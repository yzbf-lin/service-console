"""Discover running processes that can prefill service definitions."""

from __future__ import annotations

import getpass
import os
import re
import shlex
import subprocess
from collections import defaultdict
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psutil

from .ports import PortInspector


ProcessRow = dict[str, object]
ManagedProcesses = Mapping[int, str]
ProcessIdentity = tuple[int, float]
_IS_WINDOWS = os.name == "nt"

_SAFE_ENV_KEYS = frozenset(
    {
        "HOST",
        "NODE_ENV",
        "PORT",
        "PYTHONPATH",
        "PYTHONUNBUFFERED",
        "UV_PROJECT",
        "UV_PYTHON",
        "VIRTUAL_ENV",
    }
)
_SHELL_NAMES = frozenset(
    {
        "bash",
        "cmd",
        "cmd.exe",
        "dash",
        "fish",
        "powershell",
        "powershell.exe",
        "pwsh",
        "pwsh.exe",
        "sh",
        "tcsh",
        "zsh",
    }
)
_SENSITIVE_KEY = re.compile(
    r"(?:^|[_-])(?:"
    r"api[_-]?key|access[_-]?key|private[_-]?key|password|passwd|secret|token|"
    r"credentials?|authorization"
    r")(?:$|[_-])",
    re.IGNORECASE,
)
_AUTHORIZATION_HEADER = re.compile(r"^\s*(?:proxy-)?authorization\s*:", re.IGNORECASE)


class ProcessInspector:
    """Build editable service-definition drafts from live process metadata."""

    def __init__(
        self,
        port_inspector: PortInspector | None = None,
        *,
        controller_pid: int | None = None,
        current_uid: int | None = None,
        current_username: str | None = None,
    ) -> None:
        self.port_inspector = port_inspector or PortInspector()
        self.controller_pid = os.getpid() if controller_pid is None else controller_pid
        getuid = getattr(os, "getuid", None)
        self.current_uid = getuid() if current_uid is None and getuid is not None else current_uid
        self.current_username = current_username or getpass.getuser()

    def list_processes(
        self,
        query: str | None = None,
        limit: int = 100,
        managed_processes: ManagedProcesses | None = None,
    ) -> list[ProcessRow]:
        """Return non-controller, unmanaged processes, including processes without ports."""

        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 500:
            raise ValueError("limit must be an integer between 1 and 500")
        normalized_query = (query or "").strip().casefold()
        managed = _normalize_managed_processes(managed_processes)
        protected = self._controller_ancestry()
        ports_by_process, port_warning = self._load_ports()

        results: list[ProcessRow] = []
        identities: set[tuple[int, float]] = set()
        try:
            running_processes = psutil.process_iter()
            for running_process in running_processes:
                pid = int(running_process.pid)
                if pid <= 1:
                    continue
                try:
                    row, is_protected, is_shell, is_current_user = self._inspect(
                        pid,
                        managed,
                        protected,
                        ports_by_process,
                        port_warning,
                    )
                except (ValueError, RuntimeError, psutil.Error, OSError):
                    continue
                if (
                    is_protected
                    or is_shell
                    or not is_current_user
                    or row["managed_service"] is not None
                ):
                    continue
                identity = (int(row["pid"]), float(row["create_time"]))
                if identity in identities:
                    continue
                if normalized_query and not _matches(row, normalized_query):
                    continue
                identities.add(identity)
                results.append(row)
        except (psutil.Error, OSError) as exc:
            raise RuntimeError(f"failed to enumerate processes: {exc}") from exc

        results.sort(key=lambda row: (str(row["suggested_name"]), int(row["pid"])))
        return results[:limit]

    def get_process(
        self,
        pid: int,
        managed_processes: ManagedProcesses | None = None,
    ) -> ProcessRow:
        """Return one PID, resolving a same-process-group uv/pnpm launcher when present."""

        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
            raise ValueError("pid must be an integer greater than 1")
        protected = self._controller_ancestry()
        selected = _get_process(pid)
        selected_created_at = _create_time(selected, pid)
        self._ensure_visible(selected, protected)
        _verify_identity(pid, selected_created_at)
        ports_by_process, port_warning = self._load_ports()
        row, _, _, _ = self._inspect(
            pid,
            _normalize_managed_processes(managed_processes),
            protected,
            ports_by_process,
            port_warning,
            enforce_visibility=True,
        )
        return row

    def _inspect(
        self,
        pid: int,
        managed: dict[int, str],
        protected: set[int],
        ports_by_process: dict[ProcessIdentity, set[int]],
        port_warning: str | None,
        *,
        enforce_visibility: bool = False,
    ) -> tuple[ProcessRow, bool, bool, bool]:
        selected = _get_process(pid)
        selected_created_at = _create_time(selected, pid)
        if enforce_visibility:
            self._ensure_visible(selected, protected)
        launcher = self._resolve_launcher(selected, protected, managed)
        launcher_pid = int(launcher.pid)
        created_at = _create_time(launcher, launcher_pid)
        if enforce_visibility and launcher_pid != pid:
            self._ensure_visible(launcher, protected)
        warnings: list[str] = []

        argv = _read_process_value(launcher, "cmdline", warnings, "command line") or []
        argv = [str(item) for item in argv]
        masked_argv, redacted = _mask_sensitive_argv(argv)
        command = _format_command(masked_argv) if masked_argv else ""
        cwd_value = _read_process_value(launcher, "cwd", warnings, "working directory")
        cwd = str(cwd_value) if cwd_value else ""
        name_value = _read_process_value(launcher, "name", warnings, "process name")
        process_name = str(name_value or (Path(argv[0]).name if argv else "unknown"))
        username_value = _read_process_value(launcher, "username", warnings, "username")
        username = str(username_value) if username_value else None
        is_current_user = self._is_current_user(launcher, username)
        ppid_value = _read_process_value(launcher, "ppid", warnings, "parent PID")
        ppid = int(ppid_value) if ppid_value is not None else None
        safe_env: dict[str, str] = {}
        environment = _read_process_value(launcher, "environ", warnings, "environment")
        if isinstance(environment, Mapping):
            safe_env = {
                key: str(environment[key])
                for key in sorted(_SAFE_ENV_KEYS)
                if key in environment
            }

        managed_service = _managed_service(launcher, managed)
        is_protected = launcher_pid in protected
        is_shell = _is_shell(launcher, argv)
        if selected.pid != launcher_pid:
            warnings.append(
                f"Command restored from same-process-group launcher PID {launcher_pid}; "
                "review it before saving."
            )
        if managed_service is not None:
            warnings.append(f"Already managed by service {managed_service}.")
        if is_protected:
            warnings.append("Service Console and its launcher processes cannot be imported.")
        if is_shell:
            warnings.append("Interactive shell processes cannot be imported directly.")
        if not is_current_user:
            warnings.append("Processes owned by another user cannot be imported.")
        if redacted:
            warnings.append(
                "Sensitive command arguments were redacted; enter them manually before saving."
            )
        if port_warning:
            warnings.append(port_warning)
        if not command:
            warnings.append("Command line is unavailable; enter a command manually.")
        if not cwd:
            warnings.append("Working directory is unavailable; select one manually.")
        elif not Path(cwd).is_dir():
            warnings.append("Working directory no longer exists.")

        _verify_identity(pid, selected_created_at)
        if launcher_pid != pid:
            _verify_identity(launcher_pid, created_at)

        ports = set(ports_by_process.get((launcher_pid, created_at), set()))
        restorable = bool(command and cwd and Path(cwd).is_dir())
        restorable = (
            restorable
            and managed_service is None
            and not is_protected
            and not is_shell
            and is_current_user
            and not redacted
        )
        row: ProcessRow = {
            "pid": launcher_pid,
            "ppid": ppid,
            "create_time": created_at,
            "started_at": datetime.fromtimestamp(created_at, UTC).isoformat(),
            "process_name": process_name,
            "command": command,
            "cwd": cwd,
            "username": username,
            "ports": sorted(ports),
            "suggested_name": _suggested_name(cwd, argv, process_name, launcher_pid),
            "safe_env": safe_env,
            "restorable": restorable,
            "warnings": list(dict.fromkeys(warnings)),
            "managed_service": managed_service,
        }
        return row, is_protected, is_shell, is_current_user

    def _is_current_user(self, process: psutil.Process, username: str | None) -> bool:
        if self.current_uid is not None:
            try:
                return int(process.uids().real) == self.current_uid
            except (AttributeError, psutil.Error, OSError):
                pass
        if username is None:
            try:
                username = str(process.username())
            except (psutil.Error, OSError):
                return False
        return username == self.current_username

    def _ensure_visible(self, process: psutil.Process, protected: set[int]) -> None:
        pid = int(process.pid)
        if pid in protected:
            raise ValueError(f"process {pid} belongs to Service Console and cannot be imported")
        if not self._is_current_user(process, None):
            raise RuntimeError(f"permission denied while inspecting process {pid} owned by another user")

    def _resolve_launcher(
        self,
        selected: psutil.Process,
        protected: set[int],
        managed: dict[int, str],
    ) -> psutil.Process:
        selected_group = _get_process_group(selected.pid)
        if selected_group is None:
            return selected
        candidate = selected
        current = selected
        for _ in range(16):
            try:
                parent = current.parent()
            except (psutil.Error, OSError):
                break
            if parent is None or parent.pid <= 1 or parent.pid in protected:
                break
            if parent.pid in managed or _get_process_group(parent.pid) != selected_group:
                break
            parent_argv = _cmdline(parent)
            if _is_shell(parent, parent_argv):
                break
            if _is_launcher(parent, parent_argv):
                candidate = parent
            current = parent
        return candidate

    def _controller_ancestry(self) -> set[int]:
        protected = {self.controller_pid}
        try:
            current = psutil.Process(self.controller_pid)
        except (psutil.Error, OSError):
            return protected
        for _ in range(16):
            try:
                parent = current.parent()
            except (psutil.Error, OSError):
                break
            if parent is None or parent.pid <= 1:
                break
            protected.add(parent.pid)
            current = parent
        return protected

    def _load_ports(self) -> tuple[dict[ProcessIdentity, set[int]], str | None]:
        ports_by_owner: dict[int, set[int]] = defaultdict(set)
        ports_by_process: dict[ProcessIdentity, set[int]] = defaultdict(set)
        try:
            rows = self.port_inspector.list_ports()
        except (ValueError, RuntimeError, OSError) as exc:
            return ports_by_process, f"Listening ports could not be inspected: {exc}"
        for row in rows:
            try:
                pid = int(row["pid"])
                port = int(row["port"])
            except (KeyError, TypeError, ValueError):
                continue
            if pid <= 1 or not 1 <= port <= 65_535:
                continue
            ports_by_owner[pid].add(port)

        for pid, ports in ports_by_owner.items():
            try:
                owner = _get_process(pid)
                identities = _process_ancestry_identities(owner)
                if not identities:
                    continue
                _verify_identity(pid, identities[0][1])
            except (ValueError, RuntimeError, psutil.Error, OSError):
                continue
            for identity in identities:
                ports_by_process[identity].update(ports)
        return ports_by_process, None


def _get_process(pid: int) -> psutil.Process:
    try:
        return psutil.Process(pid)
    except psutil.NoSuchProcess as exc:
        raise ValueError(f"process {pid} does not exist") from exc
    except psutil.AccessDenied as exc:
        raise RuntimeError(f"permission denied while inspecting process {pid}") from exc
    except OSError as exc:
        raise RuntimeError(f"failed to inspect process {pid}: {exc}") from exc


def _create_time(process: psutil.Process, pid: int) -> float:
    try:
        return float(process.create_time())
    except psutil.NoSuchProcess as exc:
        raise ValueError(f"process {pid} disappeared while it was being inspected") from exc
    except psutil.AccessDenied as exc:
        raise RuntimeError(f"permission denied while inspecting process {pid}") from exc
    except OSError as exc:
        raise RuntimeError(f"failed to inspect process {pid}: {exc}") from exc


def _verify_identity(pid: int, expected_create_time: float) -> None:
    current = _get_process(pid)
    if _create_time(current, pid) != expected_create_time:
        raise ValueError(f"process {pid} changed identity while it was being inspected")


def _read_process_value(
    process: psutil.Process,
    method: str,
    warnings: list[str],
    label: str,
) -> Any:
    try:
        return getattr(process, method)()
    except (psutil.Error, OSError):
        warnings.append(f"Process {label} could not be inspected.")
        return None


def _cmdline(process: psutil.Process) -> list[str]:
    try:
        return [str(item) for item in process.cmdline()]
    except (psutil.Error, OSError):
        return []


def _get_process_group(pid: int) -> int | None:
    getpgid = getattr(os, "getpgid", None)
    if getpgid is None:
        return None
    try:
        return getpgid(pid)
    except (ProcessLookupError, PermissionError, OSError):
        return None


def _format_command(argv: list[str]) -> str:
    if _IS_WINDOWS:
        return subprocess.list2cmdline(argv)
    return shlex.join(argv)


def _process_ancestry_identities(process: psutil.Process) -> list[ProcessIdentity]:
    identities: list[ProcessIdentity] = []
    current = process
    for _ in range(17):
        pid = int(current.pid)
        try:
            created_at = _create_time(current, pid)
        except (ValueError, RuntimeError):
            if not identities:
                raise
            break
        identities.append((pid, created_at))
        try:
            parent = current.parent()
        except (psutil.Error, OSError):
            break
        if parent is None or parent.pid <= 1:
            break
        current = parent
    return identities


def _is_launcher(process: psutil.Process, argv: list[str]) -> bool:
    if not argv:
        return False
    if _is_scripted_shell(process, argv):
        return True
    executable = Path(argv[0]).name.casefold()
    if executable == "uv":
        return True
    head = " ".join(argv[:2]).casefold()
    return executable in {"pnpm", "pnpm.cjs"} or "pnpm.cjs" in head


def _is_shell(process: psutil.Process, argv: list[str]) -> bool:
    executable = _shell_name(process, argv)
    if executable not in _SHELL_NAMES:
        return False
    return not _is_scripted_shell(process, argv)


def _shell_name(process: psutil.Process, argv: list[str]) -> str:
    executable = Path(argv[0]).name.casefold() if argv else ""
    if executable in _SHELL_NAMES:
        return executable
    try:
        return process.name().casefold()
    except (psutil.Error, OSError):
        return executable


def _is_scripted_shell(process: psutil.Process, argv: list[str]) -> bool:
    if _shell_name(process, argv) not in _SHELL_NAMES or len(argv) < 2:
        return False

    arguments = argv[1:]
    options_with_value = {"-o", "-O", "--init-file", "--rcfile"}
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            return index + 1 < len(arguments)
        if argument in {"-c", "--command"}:
            return index + 1 < len(arguments)
        if argument.startswith("-") and not argument.startswith("--") and "c" in argument[1:]:
            return index + 1 < len(arguments)
        if argument in options_with_value:
            index += 2
            continue
        if not argument.startswith("-"):
            return True
        index += 1
    return False


def _managed_service(process: psutil.Process, managed: dict[int, str]) -> str | None:
    if process.pid in managed:
        return managed[process.pid]
    group = _get_process_group(process.pid)
    if group in managed:
        return managed[group]
    current = process
    for _ in range(16):
        try:
            parent = current.parent()
        except (psutil.Error, OSError):
            break
        if parent is None or parent.pid <= 1:
            break
        if parent.pid in managed:
            return managed[parent.pid]
        current = parent
    return None


def _normalize_managed_processes(value: ManagedProcesses | None) -> dict[int, str]:
    managed: dict[int, str] = {}
    for raw_pid, raw_name in (value or {}).items():
        try:
            pid = int(raw_pid)
        except (TypeError, ValueError):
            continue
        if pid > 1:
            managed[pid] = str(raw_name)
    return managed


def _matches(row: ProcessRow, query: str) -> bool:
    values = (
        row["pid"],
        row["process_name"],
        row["command"],
        row["cwd"],
        row["username"],
        row["suggested_name"],
    )
    return any(query in str(value or "").casefold() for value in values)


def _mask_sensitive_argv(argv: list[str]) -> tuple[list[str], bool]:
    masked: list[str] = []
    redacted = False
    index = 0
    while index < len(argv):
        argument = argv[index]
        if _AUTHORIZATION_HEADER.match(argument):
            key, _, _ = argument.partition(":")
            masked.append(f"{key}: REDACTED")
            redacted = True
            index += 1
            continue
        if "=" in argument:
            key, _, value = argument.partition("=")
            if _is_sensitive_key(key):
                masked.append(f"{key}=REDACTED")
                redacted = True
                index += 1
                continue
            if _AUTHORIZATION_HEADER.match(value):
                header, _, _ = value.partition(":")
                masked.append(f"{key}={header}: REDACTED")
                redacted = True
                index += 1
                continue
        if argument.startswith("-") and _is_sensitive_key(argument):
            masked.append(argument)
            redacted = True
            if index + 1 < len(argv):
                masked.append("REDACTED")
                index += 2
                continue
            index += 1
            continue
        masked.append(argument)
        index += 1
    return masked, redacted


def _is_sensitive_key(value: str) -> bool:
    return _SENSITIVE_KEY.search(value.lstrip("-")) is not None


def _suggested_name(cwd: str, argv: list[str], process_name: str, pid: int) -> str:
    project = Path(cwd).name if cwd else process_name
    command = " ".join(argv).casefold()
    role = ""
    if "celery" in command and "worker" in command:
        role = "celery-worker"
    elif "celery" in command and "beat" in command:
        role = "celery-beat"
    elif any(item.replace("\\", "/").endswith("backend/run.py") for item in argv):
        role = "backend"
    elif _is_pnpm_argv(argv):
        role = "frontend"
    base = _slug(project) or f"service-{pid}"
    return f"{base}-{role}" if role and role not in base else base


def _is_pnpm_argv(argv: list[str]) -> bool:
    if not argv:
        return False
    executable = Path(argv[0]).name.casefold()
    return executable in {"pnpm", "pnpm.cjs"} or "pnpm.cjs" in " ".join(argv[:2]).casefold()


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
