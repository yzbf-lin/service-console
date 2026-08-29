"""Out-of-process lifetime guard for services started by Service Console.

The desktop controller owns this worker through a private stdin/stdout pipe.  If
the controller exits without completing its normal shutdown, EOF closes the
lease and the worker stops every process group it has safely registered.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import queue
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, BinaryIO

import psutil

try:
    import fcntl as _fcntl
except ImportError:  # pragma: no cover - Windows only
    _fcntl = None

try:
    import msvcrt as _msvcrt
except ImportError:  # pragma: no cover - POSIX only
    _msvcrt = None


MANAGED_PROCESS_ID_ENV = "SERVICE_CONSOLE_MANAGED_PROCESS_ID"
# Backwards-compatible descriptive name used by the manager integration.
MANAGED_PROCESS_MARKER_ENV = MANAGED_PROCESS_ID_ENV
STATE_FILENAME = "managed-processes.json"
PROTOCOL_VERSION = 1

_IS_WINDOWS = os.name == "nt"
_MAX_LINE_BYTES = 256 * 1024
_MAX_TEXT_LENGTH = 4_096
_TRACK_VALIDATION_TIMEOUT = 1.0
_CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
_SIGKILL = getattr(signal, "SIGKILL", 9)


def _cleanup_wait_budget(stop_timeout: float) -> float:
    """Cover graceful wait, forced-stop verification, and IPC/state overhead."""

    return stop_timeout + max(1.0, min(5.0, stop_timeout)) + 2.0


@dataclass(frozen=True, slots=True)
class _Owner:
    pid: int
    create_time: float

    @classmethod
    def from_dict(cls, value: object) -> _Owner:
        if not isinstance(value, dict):
            raise TypeError("guardian owner must be a JSON object")
        owner = cls(
            pid=_positive_int(value.get("pid"), "owner pid"),
            create_time=_time_value(value.get("create_time")),
        )
        return owner


@dataclass(frozen=True, slots=True)
class _Lease:
    registration_id: str
    service: str
    pid: int
    create_time: float
    pgid: int | None
    stop_timeout: float

    @classmethod
    def from_dict(cls, value: object) -> _Lease:
        if not isinstance(value, dict):
            raise TypeError("guardian lease must be a JSON object")
        registration_id = _bounded_text(value.get("registration_id"), "registration id")
        service = _bounded_text(value.get("service"), "service")
        pid = _positive_int(value.get("pid"), "process pid")
        create_time = _time_value(value.get("create_time"))
        raw_pgid = value.get("pgid")
        pgid = None if raw_pgid is None else _positive_int(raw_pgid, "process group id")
        try:
            stop_timeout = float(value.get("stop_timeout"))
        except (TypeError, ValueError) as exc:
            raise ValueError("stop timeout must be a number") from exc
        if not math.isfinite(stop_timeout) or not 0 <= stop_timeout <= 300:
            raise ValueError("stop timeout must be between 0 and 300 seconds")
        if not _IS_WINDOWS and pgid is None:
            raise ValueError("POSIX leases require a process group id")
        return cls(
            registration_id=registration_id,
            service=service,
            pid=pid,
            create_time=create_time,
            pgid=pgid,
            stop_timeout=stop_timeout,
        )

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class _State:
    owner: _Owner
    leases: tuple[_Lease, ...]


def _bounded_text(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{label} must be text")
    normalized = value.strip()
    if not normalized or len(normalized) > _MAX_TEXT_LENGTH or "\x00" in normalized:
        raise ValueError(f"{label} is invalid")
    return normalized


def _positive_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise TypeError(f"{label} must be a positive integer")
    try:
        normalized = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be a positive integer") from exc
    if normalized <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return normalized


def _time_value(value: object) -> float:
    try:
        normalized = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("process creation time must be a positive number") from exc
    if not math.isfinite(normalized) or normalized <= 0:
        raise ValueError("process creation time must be a positive number")
    return normalized


def _same_create_time(left: float, right: float) -> bool:
    return math.isclose(left, right, rel_tol=0.0, abs_tol=0.01)


def _matching_process(pid: int, create_time: float) -> psutil.Process | None:
    try:
        process = psutil.Process(pid)
        if not _same_create_time(process.create_time(), create_time):
            return None
        if not process.is_running() or process.status() == psutil.STATUS_ZOMBIE:
            return None
        return process
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return None
    except (psutil.AccessDenied, OSError) as exc:
        raise RuntimeError(f"unable to verify process {pid}") from exc


def _owner_is_live(owner: _Owner) -> bool:
    try:
        return _matching_process(owner.pid, owner.create_time) is not None
    except RuntimeError:
        # An unverifiable owner may still be live; taking over would be unsafe.
        return True


def _has_marker(process: psutil.Process, registration_id: str) -> bool:
    try:
        return process.environ().get(MANAGED_PROCESS_ID_ENV) == registration_id
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return False
    except (psutil.AccessDenied, OSError) as exc:
        raise RuntimeError(f"unable to inspect environment for process {process.pid}") from exc


class _StateLock:
    """Hold one cross-process lock for the complete guardian lifetime."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._descriptor: int | None = None

    def acquire(self) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_CREAT | os.O_RDWR
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(self.path, flags, 0o600)
        try:
            if _IS_WINDOWS:
                if _msvcrt is None:
                    raise RuntimeError("Windows guardian locking is unavailable")
                if os.fstat(descriptor).st_size == 0:
                    os.write(descriptor, b"\0")
                    os.fsync(descriptor)
                os.lseek(descriptor, 0, os.SEEK_SET)
                _msvcrt.locking(descriptor, _msvcrt.LK_NBLCK, 1)
            else:
                if _fcntl is None:
                    raise RuntimeError("POSIX guardian locking is unavailable")
                os.fchmod(descriptor, 0o600)
                _fcntl.flock(descriptor, _fcntl.LOCK_EX | _fcntl.LOCK_NB)
        except (OSError, RuntimeError) as exc:
            os.close(descriptor)
            raise RuntimeError("another process guardian is already active") from exc
        self._descriptor = descriptor

    def close(self) -> None:
        descriptor = self._descriptor
        self._descriptor = None
        if descriptor is None:
            return
        try:
            if _IS_WINDOWS and _msvcrt is not None:
                os.lseek(descriptor, 0, os.SEEK_SET)
                _msvcrt.locking(descriptor, _msvcrt.LK_UNLCK, 1)
            elif not _IS_WINDOWS and _fcntl is not None:
                _fcntl.flock(descriptor, _fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


class _StateStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.path = data_dir / STATE_FILENAME

    def load(self) -> _State | None:
        try:
            metadata = self.path.lstat()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise ValueError(f"unable to inspect guardian state: {exc}") from exc
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError("guardian state must be a regular file")
        if not _IS_WINDOWS and hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise ValueError("guardian state is not owned by the current user")
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"unable to read guardian state: {exc}") from exc
        if not isinstance(payload, dict) or payload.get("version") != 1:
            raise ValueError("unsupported guardian state")
        owner = _Owner.from_dict(payload.get("owner"))
        raw_leases = payload.get("leases")
        if not isinstance(raw_leases, list):
            raise TypeError("guardian leases must be a JSON list")
        leases = tuple(_Lease.from_dict(value) for value in raw_leases)
        if len({lease.registration_id for lease in leases}) != len(leases):
            raise ValueError("guardian state contains duplicate registrations")
        return _State(owner=owner, leases=leases)

    def save(self, owner: _Owner, leases: Mapping[str, _Lease]) -> None:
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        encoded = (
            json.dumps(
                {
                    "version": 1,
                    "owner": asdict(owner),
                    "leases": [leases[key].to_dict() for key in sorted(leases)],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n"
        )
        temporary_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=self.data_dir,
                prefix=".managed-processes-",
                suffix=".tmp",
                delete=False,
            ) as temporary:
                temporary_path = temporary.name
                if not _IS_WINDOWS:
                    os.fchmod(temporary.fileno(), 0o600)
                temporary.write(encoded)
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_path, self.path)
            if not _IS_WINDOWS:
                self.path.chmod(0o600)
        finally:
            if temporary_path is not None:
                Path(temporary_path).unlink(missing_ok=True)

    def remove(self) -> None:
        self.path.unlink(missing_ok=True)


class _ProcessEnumerationUnavailable(RuntimeError):
    pass


def _posix_group_members(lease: _Lease) -> tuple[psutil.Process, ...] | None:
    assert lease.pgid is not None
    ps_executable = "/bin/ps" if Path("/bin/ps").is_file() else "ps"
    try:
        completed = subprocess.run(
            [ps_executable, "-axo", "pid=,pgid=,uid=,stat="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2.0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise _ProcessEnumerationUnavailable from exc
    if completed.returncode != 0:
        raise _ProcessEnumerationUnavailable

    members: list[psutil.Process] = []
    current_uid = os.getuid()
    for raw_line in completed.stdout.splitlines():
        fields = raw_line.split(None, 3)
        if len(fields) != 4:
            return None
        try:
            pid, pgid, uid = (int(value) for value in fields[:3])
        except ValueError:
            return None
        if pgid != lease.pgid or "Z" in fields[3]:
            continue
        if uid != current_uid:
            return None
        try:
            process = psutil.Process(pid)
            if os.getpgid(pid) != lease.pgid:
                continue
            if not process.is_running() or process.status() == psutil.STATUS_ZOMBIE:
                continue
            if not _has_marker(process, lease.registration_id):
                try:
                    if not process.is_running():
                        continue
                except (psutil.NoSuchProcess, psutil.ZombieProcess):
                    continue
                return None
            members.append(process)
        except (ProcessLookupError, psutil.NoSuchProcess, psutil.ZombieProcess):
            continue
        except (PermissionError, psutil.AccessDenied, OSError):
            return None
    return tuple(members)


def _posix_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _recorded_posix_group_is_safe(lease: _Lease) -> bool:
    """Validate that a private-pipe registration's PGID was not recycled."""

    assert lease.pgid is not None
    if lease.pgid <= 1 or lease.pgid == os.getpgrp():
        return False
    try:
        root = psutil.Process(lease.pid)
        if not _same_create_time(root.create_time(), lease.create_time):
            return False
        return os.getpgid(root.pid) == lease.pgid
    except (psutil.NoSuchProcess, psutil.ZombieProcess, ProcessLookupError):
        # A non-empty process group keeps its numeric PGID reserved. If the leader
        # PID has not been recycled, descendants are still in the originally
        # authenticated group.
        return True
    except (PermissionError, psutil.AccessDenied, RuntimeError, OSError):
        return False


def _posix_leader_is_gone(lease: _Lease) -> bool:
    try:
        root = psutil.Process(lease.pid)
        if not _same_create_time(root.create_time(), lease.create_time):
            return False
        return not root.is_running() or root.status() == psutil.STATUS_ZOMBIE
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return True
    except (psutil.AccessDenied, OSError):
        return False


def _validate_posix_lease(lease: _Lease) -> bool:
    assert lease.pgid is not None
    if lease.pgid <= 1 or lease.pgid == os.getpgrp():
        return False
    try:
        root = psutil.Process(lease.pid)
        if not _same_create_time(root.create_time(), lease.create_time):
            return False
        # The request arrived over the guardian's private ownership pipe. PID,
        # creation time and the new-session PGID establish live containment; the
        # marker is reserved for revalidating disk-loaded stale state.
        return os.getpgid(lease.pid) == lease.pgid
    except (psutil.NoSuchProcess, psutil.ZombieProcess, ProcessLookupError):
        pass
    except (PermissionError, psutil.AccessDenied, RuntimeError, OSError):
        return False
    try:
        members = _posix_group_members(lease)
    except _ProcessEnumerationUnavailable:
        return not _posix_group_exists(lease.pgid)
    if members is None:
        return False
    if members:
        return True
    # A command may complete before the track request arrives. Persisting an empty
    # lease is safe and lets release remain unambiguous for the manager.
    return not _posix_group_exists(lease.pgid)


def _wait_for_posix_group(lease: _Lease, timeout: float, *, trusted: bool) -> bool:
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        if trusted:
            # A trusted live registration has already authenticated the PGID over
            # the private controller pipe.  Keep waiting while the group exists:
            # on macOS a just-terminated leader can remain as a zombie briefly and
            # ``killpg(..., 0)`` may report EPERM until its parent reaps it.
            if not _posix_group_exists(lease.pgid):
                return True
        else:
            try:
                members = _posix_group_members(lease)
            except _ProcessEnumerationUnavailable:
                return False
            if members == ():
                return True
            if members is None:
                return False
        if time.monotonic() >= deadline:
            return False
        time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))


def _terminate_posix_lease(lease: _Lease, *, trusted: bool = False) -> bool:
    assert lease.pgid is not None
    # A vanished group is conclusive and does not require global process-table
    # enumeration.  This also lets a later launch discard a fully reaped stale
    # lease in restricted macOS environments where ``ps`` is unavailable.
    if not _posix_group_exists(lease.pgid):
        return True
    if trusted:
        if not _recorded_posix_group_is_safe(lease):
            return False
        members = None
    else:
        try:
            members = _posix_group_members(lease)
        except _ProcessEnumerationUnavailable:
            return False
    if members == ():
        return True
    if members is None and not trusted:
        return False
    try:
        os.killpg(lease.pgid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    except (PermissionError, OSError):
        return False
    if _wait_for_posix_group(lease, lease.stop_timeout, trusted=trusted):
        return True

    # Re-check the complete group immediately before the non-graceful signal.
    if trusted:
        if not _recorded_posix_group_is_safe(lease):
            return False
        members = () if not _posix_group_exists(lease.pgid) else None
    else:
        try:
            members = _posix_group_members(lease)
        except _ProcessEnumerationUnavailable:
            return False
    if members == ():
        return True
    if members is None and not trusted:
        return False
    try:
        os.killpg(lease.pgid, _SIGKILL)
    except ProcessLookupError:
        return True
    except (PermissionError, OSError):
        return False
    if _wait_for_posix_group(
        lease,
        max(1.0, min(5.0, lease.stop_timeout)),
        trusted=trusted,
    ):
        return True
    if trusted:
        # killpg succeeded and the authenticated leader is gone. Remaining zombie
        # entries cannot execute and will be reaped by their parent/init.
        deadline = time.monotonic() + 1.0
        while not _posix_leader_is_gone(lease):
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)
        return True
    return False


class _JobBasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _JobExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobBasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _WindowsJob:
    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _PROCESS_TERMINATE = 0x0001
    _PROCESS_SET_QUOTA = 0x0100
    _PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    def __init__(self) -> None:  # pragma: no cover - Windows only
        if not _IS_WINDOWS:
            raise RuntimeError("Windows Job Objects are unavailable")
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._configure_functions()
        self._handle = self._kernel32.CreateJobObjectW(None, None)
        if not self._handle:
            raise ctypes.WinError(ctypes.get_last_error())
        information = _JobExtendedLimitInformation()
        information.BasicLimitInformation.LimitFlags = self._JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self._kernel32.SetInformationJobObject(
            self._handle,
            self._JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(information),
            ctypes.sizeof(information),
        ):
            error = ctypes.get_last_error()
            self.close()
            raise ctypes.WinError(error)

    def _configure_functions(self) -> None:  # pragma: no cover - Windows only
        kernel32 = self._kernel32
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        kernel32.SetInformationJobObject.restype = ctypes.c_int
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.AssignProcessToJobObject.restype = ctypes.c_int
        kernel32.IsProcessInJob.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        kernel32.IsProcessInJob.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int

    def assign(self, processes: Sequence[psutil.Process]) -> None:  # pragma: no cover - Windows only
        if self._handle is None:
            raise RuntimeError("Windows Job Object is closed")
        access = self._PROCESS_TERMINATE | self._PROCESS_SET_QUOTA | self._PROCESS_QUERY_LIMITED_INFORMATION
        for process in processes:
            process_handle = self._kernel32.OpenProcess(access, False, process.pid)
            if not process_handle:
                if not psutil.pid_exists(process.pid):
                    continue
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                already_assigned = ctypes.c_int()
                if not self._kernel32.IsProcessInJob(
                    process_handle, self._handle, ctypes.byref(already_assigned)
                ):
                    raise ctypes.WinError(ctypes.get_last_error())
                if already_assigned.value:
                    continue
                if not self._kernel32.AssignProcessToJobObject(self._handle, process_handle):
                    if not psutil.pid_exists(process.pid):
                        continue
                    raise ctypes.WinError(ctypes.get_last_error())
            finally:
                self._kernel32.CloseHandle(process_handle)

    def close(self) -> None:  # pragma: no cover - Windows only
        handle = getattr(self, "_handle", None)
        self._handle = None
        if handle:
            self._kernel32.CloseHandle(handle)


def _windows_process_tree(
    lease: _Lease,
    *,
    require_marker: bool,
) -> tuple[psutil.Process, ...] | None:
    try:
        root = _matching_process(lease.pid, lease.create_time)
    except RuntimeError:
        return None
    if root is None:
        return ()
    try:
        descendants = root.children(recursive=True)
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return ()
    except (psutil.AccessDenied, OSError):
        return None
    processes = (root, *descendants)
    if require_marker:
        try:
            if not all(_has_marker(process, lease.registration_id) for process in processes):
                return None
        except RuntimeError:
            return None
    descendants.reverse()
    return (*descendants, root)


def _windows_marker_processes(lease: _Lease) -> tuple[psutil.Process, ...] | None:
    """Find orphaned Windows processes by the unguessable per-start marker."""

    try:
        current_username = psutil.Process().username()
    except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
        return None
    matches: list[psutil.Process] = []
    try:
        for process in psutil.process_iter():
            try:
                if process.username() != current_username:
                    continue
                if not process.is_running() or process.status() == psutil.STATUS_ZOMBIE:
                    continue
                if _has_marker(process, lease.registration_id):
                    matches.append(process)
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                continue
            except (psutil.AccessDenied, RuntimeError, OSError):
                # Protected processes owned by another account are common on Windows.
                # They cannot have inherited this controller's unguessable marker, and
                # one unreadable unrelated process must not disable every live track.
                continue
    except (psutil.Error, OSError):
        return None
    return tuple(matches)


def _windows_cleanup_targets(
    lease: _Lease,
    job: _WindowsJob | None,
) -> tuple[psutil.Process, ...] | None:
    return (
        _windows_process_tree(lease, require_marker=False)
        if job is not None
        else _windows_marker_processes(lease)
    )


def _wait_for_windows_tree(lease: _Lease, timeout: float, job: _WindowsJob | None) -> bool:
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        processes = _windows_cleanup_targets(lease, job)
        if processes == ():
            return True
        if processes is None or time.monotonic() >= deadline:
            return False
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))


def _terminate_windows_lease(lease: _Lease, job: _WindowsJob | None) -> bool:
    processes = _windows_cleanup_targets(lease, job)
    if processes is None and job is None:
        return False
    if processes:
        for process in processes:
            try:
                process.terminate()
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                continue
            except (psutil.AccessDenied, OSError):
                if job is None:
                    return False
    if _wait_for_windows_tree(lease, lease.stop_timeout, job):
        if job is not None:
            job.close()
            return _wait_for_windows_tree(lease, 1.0, None)
        return True
    if job is not None:
        # KILL_ON_JOB_CLOSE is the authoritative non-graceful fallback.
        job.close()
    else:
        processes = _windows_marker_processes(lease)
        if processes is None:
            return False
        for process in processes:
            try:
                process.kill()
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                continue
            except (psutil.AccessDenied, OSError):
                return False
    return _wait_for_windows_tree(
        lease,
        max(1.0, min(5.0, lease.stop_timeout)),
        None,
    )


class _GuardianWorker:
    def __init__(self, data_dir: Path, owner: _Owner) -> None:
        self.owner = owner
        self.store = _StateStore(data_dir)
        self.lock = _StateLock(data_dir / "managed-processes.lock")
        self.leases: dict[str, _Lease] = {}
        self.jobs: dict[str, _WindowsJob] = {}
        self.trusted_registrations: set[str] = set()

    def initialize(self) -> None:
        self.lock.acquire()
        previous = self.store.load()
        if previous is not None:
            if _owner_is_live(previous.owner):
                raise RuntimeError("the previous guardian owner is still active")
            self.leases = {lease.registration_id: lease for lease in previous.leases}
            self._cleanup_all(persisted_owner=previous.owner)
            if self.leases:
                raise RuntimeError("stale managed processes could not be safely cleaned")
        self.store.save(self.owner, self.leases)

    def track(self, lease: _Lease) -> bool:
        current = self.leases.get(lease.registration_id)
        if current is not None:
            return current == lease
        job: _WindowsJob | None = None
        validation_deadline = time.monotonic() + _TRACK_VALIDATION_TIMEOUT
        while True:
            if _IS_WINDOWS:
                processes = _windows_process_tree(lease, require_marker=False)
                if processes == ():
                    processes = _windows_marker_processes(lease)
                valid = processes is not None
            else:
                processes = ()
                valid = _validate_posix_lease(lease)
            if valid or time.monotonic() >= validation_deadline:
                break
            time.sleep(0.02)
        if not valid:
            return False
        if _IS_WINDOWS:
            known_processes = {process.pid: process for process in processes}
            try:
                if processes:
                    job = _WindowsJob()
                    # _windows_process_tree returns the authenticated root last;
                    # assign it first so later children inherit the Job.
                    job.assign(tuple(reversed(processes)))
                    previous_pids: set[int] = set()
                    stable = False
                    for _attempt in range(5):
                        root_tree = _windows_process_tree(lease, require_marker=False)
                        marker_processes = _windows_marker_processes(lease)
                        if root_tree is None or marker_processes is None:
                            raise RuntimeError("managed Windows process tree became unverifiable")
                        for candidate in (*root_tree, *marker_processes):
                            known_processes[candidate.pid] = candidate
                        current_pids = set(known_processes)
                        job.assign(tuple(known_processes.values()))
                        if current_pids == previous_pids:
                            stable = True
                            break
                        previous_pids = current_pids
                        time.sleep(0.02)
                    if not stable:
                        raise RuntimeError("managed Windows process tree did not stabilize")
            except (OSError, RuntimeError):
                if job is not None:
                    job.close()
                # Closing the partial Job reaps assigned members. Best-effort kill
                # covers a child found just before an assignment failure.
                for candidate in known_processes.values():
                    try:
                        candidate.kill()
                    except (psutil.NoSuchProcess, psutil.ZombieProcess, psutil.AccessDenied, OSError):
                        continue
                return False

        self.leases[lease.registration_id] = lease
        self.trusted_registrations.add(lease.registration_id)
        if job is not None:
            self.jobs[lease.registration_id] = job
        try:
            self.store.save(self.owner, self.leases)
        except OSError:
            self.leases.pop(lease.registration_id, None)
            self.trusted_registrations.discard(lease.registration_id)
            failed_job = self.jobs.pop(lease.registration_id, None)
            if failed_job is not None:
                failed_job.close()
            return False
        return True

    def release(self, registration_id: str) -> bool:
        lease = self.leases.get(registration_id)
        if lease is None:
            return True
        job = self.jobs.get(registration_id)
        trusted = registration_id in self.trusted_registrations
        cleaned = (
            _terminate_windows_lease(lease, job)
            if _IS_WINDOWS
            else _terminate_posix_lease(lease, trusted=trusted)
        )
        if not cleaned:
            return False
        self.leases.pop(registration_id, None)
        self.jobs.pop(registration_id, None)
        self.trusted_registrations.discard(registration_id)
        try:
            self.store.save(self.owner, self.leases)
        except OSError:
            # Preserve the lease for a later idempotent retry even though this pass
            # already stopped the matching processes.
            self.leases[registration_id] = lease
            if trusted:
                self.trusted_registrations.add(registration_id)
            return False
        return True

    def _cleanup_all(self, *, persisted_owner: _Owner | None = None) -> bool:
        state_owner = self.owner if persisted_owner is None else persisted_owner
        all_clean = True
        for registration_id, lease in tuple(self.leases.items()):
            job = self.jobs.pop(registration_id, None)
            trusted = registration_id in self.trusted_registrations
            cleaned = (
                _terminate_windows_lease(lease, job)
                if _IS_WINDOWS
                else _terminate_posix_lease(lease, trusted=trusted)
            )
            if cleaned:
                self.leases.pop(registration_id, None)
                self.trusted_registrations.discard(registration_id)
                try:
                    self.store.save(state_owner, self.leases)
                except OSError:
                    # Retaining the in-memory lease prevents a false successful cleanup.
                    self.leases[registration_id] = lease
                    if trusted:
                        self.trusted_registrations.add(registration_id)
                    all_clean = False
            else:
                all_clean = False
        if not self.leases:
            try:
                self.store.remove()
            except OSError:
                all_clean = False
        return all_clean and not self.leases

    def close(self) -> bool:
        try:
            return self._cleanup_all()
        finally:
            for job in self.jobs.values():
                job.close()
            self.jobs.clear()
            self.trusted_registrations.clear()
            self.lock.close()


def _encode_message(payload: Mapping[str, object]) -> bytes:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(encoded) > _MAX_LINE_BYTES:
        raise ValueError("guardian protocol message is too large")
    return encoded


def _write_message(output: BinaryIO, payload: Mapping[str, object]) -> bool:
    try:
        output.write(_encode_message(payload))
        output.flush()
    except (BrokenPipeError, OSError, ValueError):
        return False
    return True


def _read_lines(source: BinaryIO, destination: queue.Queue[bytes | None]) -> None:
    try:
        while True:
            line = source.readline(_MAX_LINE_BYTES + 1)
            if not line:
                destination.put(None)
                return
            if len(line) > _MAX_LINE_BYTES or not line.endswith(b"\n"):
                destination.put(b"")
                return
            destination.put(line)
    except (OSError, ValueError):
        destination.put(None)


def _request_id(payload: object) -> str:
    if not isinstance(payload, dict):
        raise TypeError("guardian request must be a JSON object")
    return _bounded_text(payload.get("id"), "request id")


def _run_worker(data_dir: Path, owner: _Owner, input_stream: BinaryIO, output_stream: BinaryIO) -> int:
    worker = _GuardianWorker(data_dir, owner)
    try:
        worker.initialize()
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        _write_message(
            output_stream,
            {"type": "hello", "version": PROTOCOL_VERSION, "ok": False, "error": str(exc)},
        )
        worker.lock.close()
        return 1

    if not _write_message(
        output_stream,
        {"type": "hello", "version": PROTOCOL_VERSION, "ok": True, "pid": os.getpid()},
    ):
        worker.close()
        return 1

    requests: queue.Queue[bytes | None] = queue.Queue()
    reader = threading.Thread(target=_read_lines, args=(input_stream, requests), daemon=True)
    reader.start()
    terminate_requested = threading.Event()

    def request_termination(_signum: int, _frame: object) -> None:
        terminate_requested.set()

    installed_signals: dict[int, Any] = {}
    for signal_number in (signal.SIGTERM, signal.SIGINT):
        try:
            installed_signals[signal_number] = signal.signal(signal_number, request_termination)
        except (OSError, ValueError):
            pass

    try:
        while not terminate_requested.is_set():
            try:
                raw_line = requests.get(timeout=0.2)
            except queue.Empty:
                continue
            if raw_line is None or raw_line == b"":
                break
            request_id = "unknown"
            try:
                payload = json.loads(raw_line)
                request_id = _request_id(payload)
                assert isinstance(payload, dict)
                action = payload.get("action")
                if action == "track":
                    lease = _Lease.from_dict(payload.get("lease"))
                    ok = worker.track(lease)
                    response: dict[str, object] = {"id": request_id, "ok": ok}
                    if not ok:
                        response["error"] = "process identity could not be safely registered"
                elif action == "release":
                    registration_id = _bounded_text(payload.get("registration_id"), "registration id")
                    ok = worker.release(registration_id)
                    response = {"id": request_id, "ok": ok}
                    if not ok:
                        response["error"] = "guardian state could not be updated"
                elif action == "shutdown":
                    ok = worker.close()
                    _write_message(output_stream, {"id": request_id, "ok": ok})
                    return 0 if ok else 1
                else:
                    raise ValueError("unsupported guardian action")
            except (AssertionError, json.JSONDecodeError, TypeError, ValueError) as exc:
                response = {"id": request_id, "ok": False, "error": str(exc)}
            if not _write_message(output_stream, response):
                break
    finally:
        for signal_number, previous in installed_signals.items():
            try:
                signal.signal(signal_number, previous)
            except (OSError, ValueError):
                pass
    return 0 if worker.close() else 1


def _guardian_command() -> list[str]:
    if getattr(sys, "frozen", False):
        executable_name = "Service Console Guardian.exe" if _IS_WINDOWS else "Service Console Guardian"
        return [str(Path(sys.executable).resolve().with_name(executable_name))]
    return [sys.executable, "-m", "service_console.process_guardian"]


class ProcessGuardian:
    """Thread-safe client for one independent process-guardian worker."""

    def __init__(
        self,
        data_dir: str | Path,
        *,
        startup_timeout: float = 5.0,
        request_timeout: float = 5.0,
    ) -> None:
        if startup_timeout <= 0 or request_timeout <= 0:
            raise ValueError("guardian timeouts must be greater than zero")
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.startup_timeout = startup_timeout
        self.request_timeout = request_timeout
        self._lock = threading.RLock()
        self._process: subprocess.Popen[bytes] | None = None
        self._responses: queue.Queue[bytes | None] | None = None
        self._reader: threading.Thread | None = None
        self._tracked_timeouts: dict[str, float] = {}
        self._cleanup_unconfirmed = False

    def ensure_started(self) -> bool:
        with self._lock:
            return self._ensure_started_locked()

    def track(
        self,
        registration_id: str,
        service: str,
        pid: int,
        create_time: float,
        process_group_id: int | None,
        stop_timeout: float,
    ) -> bool:
        try:
            lease = _Lease.from_dict(
                {
                    "registration_id": registration_id,
                    "service": service,
                    "pid": pid,
                    "create_time": create_time,
                    "pgid": process_group_id,
                    "stop_timeout": stop_timeout,
                }
            )
        except (TypeError, ValueError):
            return False
        with self._lock:
            if not self._ensure_started_locked():
                return False
            response = self._request_locked({"action": "track", "lease": lease.to_dict()})
            if response is None or response.get("ok") is not True:
                return False
            self._tracked_timeouts[registration_id] = stop_timeout
            return True

    def release(self, registration_id: str) -> bool:
        try:
            normalized = _bounded_text(registration_id, "registration id")
        except (TypeError, ValueError):
            return False
        with self._lock:
            if not self._worker_is_live_locked():
                return False
            stop_timeout = self._tracked_timeouts.get(normalized, 0.0)
            cleanup_timeout = _cleanup_wait_budget(stop_timeout)
            response = self._request_locked(
                {"action": "release", "registration_id": normalized},
                timeout=max(self.request_timeout, cleanup_timeout),
            )
            if response is None or response.get("ok") is not True:
                return False
            self._tracked_timeouts.pop(normalized, None)
            return True

    def shutdown(self) -> bool:
        with self._lock:
            if not self._worker_is_live_locked():
                cleaned = not self._tracked_timeouts and not self._cleanup_unconfirmed
                self._disconnect_locked()
                return cleaned
            cleanup_timeout = (
                sum(_cleanup_wait_budget(stop_timeout) for stop_timeout in self._tracked_timeouts.values())
                + 5.0
            )
            response = self._request_locked(
                {"action": "shutdown"},
                timeout=max(self.request_timeout, cleanup_timeout),
            )
            cleaned = response is not None and response.get("ok") is True
            process = self._process
            self._disconnect_locked(cleanup_confirmed=cleaned)
            if process is not None:
                try:
                    process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    # The detached worker keeps cleaning after the UI has closed.
                    pass
            return cleaned

    def emergency_disconnect(self) -> None:
        """Simulate abrupt controller loss by closing the worker's ownership pipe."""

        # Never wait behind a long release/shutdown request. Closing the ownership
        # pipe is sufficient for the worker to observe EOF and reap every lease.
        if self._lock.acquire(blocking=False):
            try:
                self._disconnect_locked()
            finally:
                self._lock.release()
            return
        process = self._process
        responses = self._responses
        if self._tracked_timeouts:
            self._cleanup_unconfirmed = True
        if process is not None and process.stdin is not None:
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass
        if responses is not None:
            # Wake a request thread blocked in Queue.get(); it will observe an
            # unconfirmed response and release the lifecycle lock immediately.
            responses.put_nowait(None)

    def _ensure_started_locked(self) -> bool:
        if self._worker_is_live_locked():
            return True
        self._disconnect_locked()
        try:
            owner = _Owner(pid=os.getpid(), create_time=psutil.Process().create_time())
            self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            command = [
                *_guardian_command(),
                "--data-dir",
                str(self.data_dir),
                "--owner-pid",
                str(owner.pid),
                "--owner-create-time",
                repr(owner.create_time),
            ]
            options: dict[str, object] = {
                "stdin": subprocess.PIPE,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.DEVNULL,
                "bufsize": 0,
                "close_fds": True,
            }
            if _IS_WINDOWS:
                options["creationflags"] = _CREATE_NEW_PROCESS_GROUP | _CREATE_NO_WINDOW
            else:
                options["start_new_session"] = True
            process = subprocess.Popen(command, **options)  # type: ignore[arg-type]
        except (OSError, RuntimeError, psutil.Error):
            return False
        if process.stdin is None or process.stdout is None:
            process.kill()
            return False

        responses: queue.Queue[bytes | None] = queue.Queue()
        reader = threading.Thread(target=_read_lines, args=(process.stdout, responses), daemon=True)
        reader.start()
        self._process = process
        self._responses = responses
        self._reader = reader
        hello_timeout = self.startup_timeout
        try:
            previous_state = _StateStore(self.data_dir).load()
        except (OSError, TypeError, ValueError):
            previous_state = None
        if previous_state is not None:
            hello_timeout = max(
                hello_timeout,
                sum(_cleanup_wait_budget(lease.stop_timeout) for lease in previous_state.leases) + 5.0,
            )
        try:
            raw_hello = responses.get(timeout=hello_timeout)
            hello = json.loads(raw_hello) if raw_hello else None
        except (queue.Empty, json.JSONDecodeError, TypeError):
            hello = None
        if (
            not isinstance(hello, dict)
            or hello.get("type") != "hello"
            or hello.get("version") != PROTOCOL_VERSION
            or hello.get("ok") is not True
        ):
            self._disconnect_locked()
            return False
        return True

    def _worker_is_live_locked(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def _request_locked(
        self,
        payload: Mapping[str, object],
        *,
        timeout: float | None = None,
    ) -> dict[str, object] | None:
        process = self._process
        responses = self._responses
        if process is None or process.poll() is not None or process.stdin is None or responses is None:
            return None
        request_id = uuid.uuid4().hex
        message = {"id": request_id, **payload}
        try:
            process.stdin.write(_encode_message(message))
            process.stdin.flush()
            raw_response = responses.get(timeout=self.request_timeout if timeout is None else timeout)
            response = json.loads(raw_response) if raw_response else None
        except (BrokenPipeError, OSError, ValueError, queue.Empty, json.JSONDecodeError, TypeError):
            self._disconnect_locked()
            return None
        if not isinstance(response, dict) or response.get("id") != request_id:
            self._disconnect_locked()
            return None
        return response

    def _disconnect_locked(self, *, cleanup_confirmed: bool = False) -> None:
        process = self._process
        if self._tracked_timeouts and not cleanup_confirmed:
            self._cleanup_unconfirmed = True
        elif cleanup_confirmed:
            self._cleanup_unconfirmed = False
        self._process = None
        self._responses = None
        self._reader = None
        self._tracked_timeouts.clear()
        if process is None:
            return
        for stream in (process.stdin, process.stdout):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="service-console-process-guardian")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--owner-pid", required=True, type=int)
    parser.add_argument("--owner-create-time", required=True, type=float)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        owner = _Owner(
            pid=_positive_int(args.owner_pid, "owner pid"),
            create_time=_time_value(args.owner_create_time),
        )
    except (TypeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return _run_worker(
        Path(args.data_dir).expanduser().resolve(),
        owner,
        sys.stdin.buffer,
        sys.stdout.buffer,
    )


if __name__ == "__main__":
    raise SystemExit(main())
