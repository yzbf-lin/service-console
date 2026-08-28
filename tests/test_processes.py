from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import psutil
import pytest

from service_console import processes
from service_console.processes import ProcessInspector


_TEST_UID = getattr(os, "getuid", lambda: 1_000)()


def format_command(argv: list[str]) -> str:
    if os.name == "nt":
        return subprocess.list2cmdline(argv)
    return shlex.join(argv)


class FakeProcess:
    def __init__(
        self,
        pid: int,
        *,
        ppid: int,
        pgid: int,
        name: str,
        argv: list[str],
        cwd: Path,
        created_at: float,
        environment: dict[str, str] | BaseException | None = None,
        username: str = "tester",
        uid: int | None = None,
    ) -> None:
        self.pid = pid
        self._ppid = ppid
        self.pgid = pgid
        self._name = name
        self._argv = argv
        self._cwd = cwd
        self._created_at: float | list[float] = created_at
        self._environment = environment or {}
        self._username = username
        self._uid = _TEST_UID if uid is None else uid
        self.registry: dict[int, FakeProcess] = {}
        self.cmdline_reads = 0
        self.cwd_reads = 0
        self.environment_reads = 0

    def parent(self) -> FakeProcess | None:
        return self.registry.get(self._ppid)

    def ppid(self) -> int:
        return self._ppid

    def name(self) -> str:
        return self._name

    def cmdline(self) -> list[str]:
        self.cmdline_reads += 1
        return list(self._argv)

    def cwd(self) -> str:
        self.cwd_reads += 1
        return str(self._cwd)

    def create_time(self) -> float:
        if isinstance(self._created_at, list):
            return self._created_at.pop(0)
        return self._created_at

    def username(self) -> str:
        return self._username

    def environ(self) -> dict[str, str]:
        self.environment_reads += 1
        if isinstance(self._environment, BaseException):
            raise self._environment
        return dict(self._environment)

    def uids(self) -> SimpleNamespace:
        return SimpleNamespace(real=self._uid)


class FakePortInspector:
    def __init__(self, rows: list[dict[str, object]] | None = None) -> None:
        self.rows = rows or []

    def list_ports(self) -> list[dict[str, object]]:
        return self.rows


def install_processes(
    monkeypatch: pytest.MonkeyPatch,
    registry: dict[int, FakeProcess],
) -> None:
    for process in registry.values():
        process.registry = registry

    def process_factory(pid: int) -> FakeProcess:
        try:
            return registry[pid]
        except KeyError:
            raise psutil.NoSuchProcess(pid) from None

    def getpgid(pid: int) -> int:
        try:
            return registry[pid].pgid
        except KeyError:
            raise ProcessLookupError(pid) from None

    monkeypatch.setattr(processes.psutil, "Process", process_factory)
    monkeypatch.setattr(processes.psutil, "process_iter", lambda: list(registry.values()))
    monkeypatch.setattr(processes.os, "getuid", lambda: _TEST_UID, raising=False)
    monkeypatch.setattr(processes.os, "getpgid", getpgid, raising=False)


def process_tree(tmp_path: Path) -> dict[int, FakeProcess]:
    shell = FakeProcess(
        90,
        ppid=1,
        pgid=90,
        name="zsh",
        argv=["/bin/zsh", "-l"],
        cwd=tmp_path,
        created_at=90.0,
    )
    controller = FakeProcess(
        900,
        ppid=90,
        pgid=900,
        name="python",
        argv=["python", "-m", "service_console.desktop"],
        cwd=tmp_path,
        created_at=900.0,
    )
    uv = FakeProcess(
        101,
        ppid=90,
        pgid=101,
        name="uv",
        argv=["/opt/uv bin/uv", "run", "backend/run.py", "--label", "hello world"],
        cwd=tmp_path,
        created_at=101.25,
        environment={
            "PATH": "/secret/path",
            "PYTHONUNBUFFERED": "1",
            "TOKEN": "do-not-return",
        },
    )
    backend = FakeProcess(
        102,
        ppid=101,
        pgid=101,
        name="python",
        argv=[".venv/bin/python", "backend/run.py"],
        cwd=tmp_path,
        created_at=102.25,
    )
    pnpm = FakeProcess(
        201,
        ppid=90,
        pgid=201,
        name="node",
        argv=["node", "/opt/pnpm/pnpm.cjs", "dev:antdv-next"],
        cwd=tmp_path,
        created_at=201.25,
    )
    frontend = FakeProcess(
        202,
        ppid=201,
        pgid=201,
        name="node",
        argv=["node", "vite.js"],
        cwd=tmp_path,
        created_at=202.25,
    )
    managed_root = FakeProcess(
        300,
        ppid=90,
        pgid=300,
        name="sh",
        argv=["/bin/sh", "-c", "python managed.py"],
        cwd=tmp_path,
        created_at=300.25,
    )
    managed_child = FakeProcess(
        301,
        ppid=300,
        pgid=300,
        name="python",
        argv=["python", "managed.py"],
        cwd=tmp_path,
        created_at=301.25,
    )
    celery = FakeProcess(
        400,
        ppid=90,
        pgid=400,
        name="python",
        argv=["python", "-m", "celery", "worker"],
        cwd=tmp_path,
        created_at=400.25,
        environment=psutil.AccessDenied(pid=400),
    )
    other_user = FakeProcess(
        500,
        ppid=1,
        pgid=500,
        name="python",
        argv=["python", "other-user.py"],
        cwd=tmp_path,
        created_at=500.25,
        username="other",
        uid=_TEST_UID + 1,
    )
    return {
        process.pid: process
        for process in (
            shell,
            controller,
            uv,
            backend,
            pnpm,
            frontend,
            managed_root,
            managed_child,
            celery,
            other_user,
        )
    }


def test_list_processes_restores_launchers_and_includes_processes_without_ports(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    registry = process_tree(tmp_path)
    install_processes(monkeypatch, registry)
    inspector = ProcessInspector(
        FakePortInspector([{"pid": 102, "port": 8000}]),
        controller_pid=900,
    )

    rows = inspector.list_processes(managed_processes={300: "managed"})

    assert [row["pid"] for row in rows] == [101, 400, 201]
    assert all(row["pid"] not in {90, 300, 301, 900} for row in rows)
    assert all(row["pid"] != 500 for row in rows)
    backend = next(row for row in rows if row["pid"] == 101)
    assert backend["command"] == format_command(registry[101]._argv)
    assert backend["ports"] == [8000]
    assert backend["safe_env"] == {"PYTHONUNBUFFERED": "1"}
    assert "TOKEN" not in backend["safe_env"]
    assert next(row for row in rows if row["pid"] == 201)["ports"] == []
    celery = next(row for row in rows if row["pid"] == 400)
    assert celery["ports"] == []
    assert celery["restorable"] is True
    assert any("environment" in warning for warning in celery["warnings"])

    filtered = inspector.list_processes("celery", limit=1, managed_processes={300: "managed"})
    assert [row["pid"] for row in filtered] == [400]


def test_get_process_returns_resolved_uv_identity_and_marks_managed_children(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    registry = process_tree(tmp_path)
    install_processes(monkeypatch, registry)
    inspector = ProcessInspector(
        FakePortInspector([{"pid": 102, "port": 8000}]),
        controller_pid=900,
    )

    backend = inspector.get_process(102, managed_processes={300: "managed"})

    assert backend == {
        "pid": 101,
        "ppid": 90,
        "create_time": 101.25,
        "started_at": "1970-01-01T00:01:41.250000+00:00",
        "process_name": "uv",
        "command": format_command(registry[101]._argv),
        "cwd": str(tmp_path),
        "username": "tester",
        "ports": [8000],
        "suggested_name": f"{tmp_path.name.replace('_', '-')}-backend",
        "safe_env": {"PYTHONUNBUFFERED": "1"},
        "restorable": True,
        "warnings": [
            "Command restored from same-process-group launcher PID 101; review it before saving."
        ],
        "managed_service": None,
    }

    managed = inspector.get_process(301, managed_processes={300: "managed"})
    assert managed["managed_service"] == "managed"
    assert managed["restorable"] is False
    assert any("Already managed" in warning for warning in managed["warnings"])


def test_get_process_rejects_other_users_and_controller_ancestry_before_reading_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    registry = process_tree(tmp_path)
    install_processes(monkeypatch, registry)
    inspector = ProcessInspector(FakePortInspector(), controller_pid=900)

    with pytest.raises(RuntimeError, match="owned by another user"):
        inspector.get_process(500)
    with pytest.raises(ValueError, match="belongs to Service Console"):
        inspector.get_process(900)
    with pytest.raises(ValueError, match="belongs to Service Console"):
        inspector.get_process(90)

    for pid in (90, 500, 900):
        process = registry[pid]
        assert process.cmdline_reads == 0
        assert process.cwd_reads == 0
        assert process.environment_reads == 0


def test_get_process_rejects_pid_reuse(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    changing = FakeProcess(
        500,
        ppid=1,
        pgid=500,
        name="python",
        argv=["python", "app.py"],
        cwd=tmp_path,
        created_at=100.0,
    )
    changing._created_at = [100.0, 100.0, 100.0, 100.0, 200.0]
    install_processes(monkeypatch, {500: changing})
    inspector = ProcessInspector(FakePortInspector(), controller_pid=999)

    with pytest.raises(ValueError, match="changed identity"):
        inspector.get_process(500)


def test_sensitive_command_arguments_are_redacted_and_require_review(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    sensitive = FakeProcess(
        600,
        ppid=1,
        pgid=600,
        name="uv",
        argv=[
            "uv",
            "run",
            "app.py",
            "--token",
            "top-secret",
            "DATABASE_PASSWORD=hunter2",
            "--api-key=api-secret",
            "--client-secret",
            "client-secret-value",
            "--github-token",
            "github-token-value",
            "AWS_ACCESS_KEY_ID=access-key-value",
            "PRIVATE_KEY=private-key-value",
            "--credential",
            "credential-value",
            "--authorization",
            "Bearer authorization-value",
            "Authorization: Bearer header-value",
        ],
        cwd=tmp_path,
        created_at=600.25,
    )
    install_processes(monkeypatch, {600: sensitive})
    inspector = ProcessInspector(FakePortInspector(), controller_pid=999)

    row = inspector.get_process(600)

    assert "top-secret" not in row["command"]
    assert "hunter2" not in row["command"]
    assert "api-secret" not in row["command"]
    assert "client-secret-value" not in row["command"]
    assert "github-token-value" not in row["command"]
    assert "access-key-value" not in row["command"]
    assert "private-key-value" not in row["command"]
    assert "credential-value" not in row["command"]
    assert "authorization-value" not in row["command"]
    assert "header-value" not in row["command"]
    assert row["command"].count("REDACTED") == 10
    assert row["restorable"] is False
    assert any("Sensitive command arguments" in warning for warning in row["warnings"])


@pytest.mark.parametrize(
    ("shell_argv", "child_argv"),
    [
        (["bash", "run-server.sh"], ["python", "app.py"]),
        (["sh", "-c", "exec python app.py"], ["python", "app.py"]),
    ],
)
def test_scripted_shells_are_restorable_launchers(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    shell_argv: list[str],
    child_argv: list[str],
) -> None:
    interactive = FakeProcess(
        90,
        ppid=1,
        pgid=90,
        name="zsh",
        argv=["zsh", "-l"],
        cwd=tmp_path,
        created_at=90.0,
    )
    launcher = FakeProcess(
        700,
        ppid=90,
        pgid=700,
        name=shell_argv[0],
        argv=shell_argv,
        cwd=tmp_path,
        created_at=700.0,
    )
    child = FakeProcess(
        701,
        ppid=700,
        pgid=700,
        name="python",
        argv=child_argv,
        cwd=tmp_path,
        created_at=701.0,
    )
    registry = {process.pid: process for process in (interactive, launcher, child)}
    install_processes(monkeypatch, registry)
    inspector = ProcessInspector(
        FakePortInspector([{"pid": 701, "port": 8123}]),
        controller_pid=999,
    )

    rows = inspector.list_processes()

    assert [row["pid"] for row in rows] == [700]
    assert rows[0]["command"] == format_command(shell_argv)
    assert rows[0]["ports"] == [8123]
    assert rows[0]["restorable"] is True


def test_ports_are_scoped_to_launcher_ancestry_not_shared_process_group(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    shell = FakeProcess(
        90,
        ppid=1,
        pgid=90,
        name="zsh",
        argv=["zsh", "-l"],
        cwd=tmp_path,
        created_at=90.0,
    )
    listener = FakeProcess(
        710,
        ppid=90,
        pgid=90,
        name="python",
        argv=["python", "listener.py"],
        cwd=tmp_path,
        created_at=710.0,
    )
    sibling = FakeProcess(
        711,
        ppid=90,
        pgid=90,
        name="python",
        argv=["python", "worker.py"],
        cwd=tmp_path,
        created_at=711.0,
    )
    registry = {process.pid: process for process in (shell, listener, sibling)}
    install_processes(monkeypatch, registry)
    inspector = ProcessInspector(
        FakePortInspector([{"pid": 710, "port": 9000}]),
        controller_pid=999,
    )

    rows = {int(row["pid"]): row for row in inspector.list_processes()}

    assert rows[710]["ports"] == [9000]
    assert rows[711]["ports"] == []


def test_port_snapshot_is_discarded_when_owner_pid_changes_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    changing = FakeProcess(
        720,
        ppid=1,
        pgid=720,
        name="python",
        argv=["python", "app.py"],
        cwd=tmp_path,
        created_at=100.0,
    )
    changing._created_at = [100.0, 200.0, 200.0, 200.0, 200.0]
    install_processes(monkeypatch, {720: changing})
    inspector = ProcessInspector(
        FakePortInspector([{"pid": 720, "port": 9001}]),
        controller_pid=999,
    )

    rows = inspector.list_processes()

    assert len(rows) == 1
    assert rows[0]["ports"] == []


@pytest.mark.parametrize("pid", [0, 1, -1])
def test_get_process_rejects_system_pids(pid: int) -> None:
    with pytest.raises(ValueError, match="greater than 1"):
        ProcessInspector(FakePortInspector(), controller_pid=999).get_process(pid)


def test_windows_discovery_without_getpgid_uses_windows_command_quoting(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    selected = FakeProcess(
        800,
        ppid=1,
        pgid=800,
        name="python.exe",
        argv=[r"C:\Program Files\Python\python.exe", "app.py", "hello world"],
        cwd=tmp_path,
        created_at=800.25,
    )
    install_processes(monkeypatch, {800: selected})
    monkeypatch.delattr(processes.os, "getpgid")
    monkeypatch.setattr(processes, "_IS_WINDOWS", True)
    inspector = ProcessInspector(FakePortInspector(), controller_pid=999)

    row = inspector.get_process(800)

    assert row["pid"] == 800
    assert row["command"] == subprocess.list2cmdline(selected._argv)


@pytest.mark.parametrize("shell", ["cmd.exe", "powershell.exe", "pwsh.exe"])
def test_windows_interactive_shells_are_not_restorable_launchers(
    shell: str,
    tmp_path: Path,
) -> None:
    interactive = FakeProcess(
        810,
        ppid=1,
        pgid=810,
        name=shell,
        argv=[shell],
        cwd=tmp_path,
        created_at=810.25,
    )
    scripted = FakeProcess(
        811,
        ppid=1,
        pgid=811,
        name=shell,
        argv=[shell, "/c" if shell == "cmd.exe" else "-Command", "python app.py"],
        cwd=tmp_path,
        created_at=811.25,
    )

    assert processes._is_shell(interactive, interactive._argv) is True
    assert processes._is_shell(scripted, scripted._argv) is False
