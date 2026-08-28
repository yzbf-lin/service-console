"""Short-lived desktop controller discovery metadata."""

from __future__ import annotations

import ipaddress
import json
import os
import stat
import tempfile
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator
from urllib.parse import urlsplit

import psutil

try:
    import fcntl as _fcntl
except ImportError:  # pragma: no cover - exercised on Windows
    _fcntl = None

try:
    import msvcrt as _msvcrt
except ImportError:  # pragma: no cover - exercised on POSIX
    _msvcrt = None


RUNTIME_FILENAME = "controller.json"
_IS_WINDOWS = os.name == "nt"


@dataclass(frozen=True, slots=True)
class RuntimeConnection:
    """Connection details for one running desktop controller."""

    instance_id: str
    pid: int
    base_url: str
    token: str
    started_at: str
    version: int = 1


def runtime_path(data_dir: str | Path = "~/.service-console") -> Path:
    """Return the descriptor path for a controller data directory."""

    return Path(data_dir).expanduser() / RUNTIME_FILENAME


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _process_exists(pid: int) -> bool:
    if _IS_WINDOWS:
        return psutil.pid_exists(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Sandboxed clients may be unable to signal a same-user desktop process. Treat the
        # descriptor as live and let the authenticated HTTP request verify reachability.
        return True
    return True


def _validated_connection(payload: object) -> RuntimeConnection:
    if not isinstance(payload, dict):
        raise ValueError("desktop controller descriptor must be a JSON object")
    try:
        connection = RuntimeConnection(
            version=int(payload["version"]),
            instance_id=str(payload["instance_id"]),
            pid=int(payload["pid"]),
            base_url=str(payload["base_url"]),
            token=str(payload["token"]),
            started_at=str(payload["started_at"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("desktop controller descriptor is missing required fields") from exc

    if connection.version != 1:
        raise ValueError(f"unsupported desktop controller descriptor version: {connection.version}")
    if not connection.instance_id or not connection.token or not connection.started_at:
        raise ValueError("desktop controller descriptor contains empty fields")
    if connection.pid <= 0:
        raise ValueError("desktop controller PID must be positive")

    parts = urlsplit(connection.base_url)
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError("desktop controller URL has an invalid port") from exc
    if (
        parts.scheme != "http"
        or not parts.hostname
        or not _is_loopback(parts.hostname)
        or port is None
        or parts.username is not None
        or parts.password is not None
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise ValueError("desktop controller URL must be an uncredentialed HTTP loopback URL")
    return connection


@contextmanager
def _exclusive_runtime_lock(destination: Path) -> Iterator[None]:
    """Serialize descriptor publication and removal across desktop processes."""

    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = destination.with_name(f"{destination.name}.lock")
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(lock_path, flags, 0o600)
    locked = False
    try:
        if _IS_WINDOWS:
            if _msvcrt is None:
                raise RuntimeError("Windows runtime locking is unavailable")
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"\0")
                os.fsync(descriptor)
            os.lseek(descriptor, 0, os.SEEK_SET)
            _msvcrt.locking(descriptor, _msvcrt.LK_LOCK, 1)
            locked = True
        else:
            if _fcntl is None:
                raise RuntimeError("POSIX runtime locking is unavailable")
            os.fchmod(descriptor, 0o600)
            _fcntl.flock(descriptor, _fcntl.LOCK_EX)
            locked = True
        yield
    finally:
        if locked and _IS_WINDOWS and _msvcrt is not None:
            os.lseek(descriptor, 0, os.SEEK_SET)
            _msvcrt.locking(descriptor, _msvcrt.LK_UNLCK, 1)
        elif locked and not _IS_WINDOWS and _fcntl is not None:
            _fcntl.flock(descriptor, _fcntl.LOCK_UN)
        os.close(descriptor)


def _write_runtime_connection(destination: Path, connection: RuntimeConnection) -> None:
    """Write a validated descriptor while the caller holds the runtime lock."""

    temporary_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=destination.parent,
            prefix=f".{destination.name}-",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = temporary.name
            if not _IS_WINDOWS:
                os.fchmod(temporary.fileno(), 0o600)
            json.dump(asdict(connection), temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, destination)
        if not _IS_WINDOWS:
            destination.chmod(0o600)
    finally:
        if temporary_path is not None:
            Path(temporary_path).unlink(missing_ok=True)


def write_runtime_connection(path: str | Path, connection: RuntimeConnection) -> None:
    """Atomically publish a private runtime descriptor."""

    connection = _validated_connection(asdict(connection))
    destination = Path(path).expanduser()
    with _exclusive_runtime_lock(destination):
        current = load_runtime_connection(destination)
        if current is not None and current.instance_id != connection.instance_id:
            raise ValueError("another desktop controller is already active")
        _write_runtime_connection(destination, connection)


def load_runtime_connection(
    path: str | Path,
    *,
    require_live_process: bool = True,
) -> RuntimeConnection | None:
    """Load and validate a private runtime descriptor, returning None when stale."""

    source = Path(path).expanduser()
    try:
        metadata = source.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError(f"failed to inspect desktop controller descriptor: {exc}") from exc
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("desktop controller descriptor must be a regular file")
    if not _IS_WINDOWS and hasattr(os, "getuid") and metadata.st_uid != os.getuid():
        raise ValueError("desktop controller descriptor is not owned by the current user")
    if not _IS_WINDOWS and stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ValueError("desktop controller descriptor permissions must be 0600")
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"failed to read desktop controller descriptor: {exc}") from exc
    connection = _validated_connection(payload)
    if require_live_process and not _process_exists(connection.pid):
        return None
    return connection


def remove_runtime_connection(path: str | Path, instance_id: str) -> bool:
    """Remove only the descriptor published by the matching desktop instance."""

    destination = Path(path).expanduser()
    with _exclusive_runtime_lock(destination):
        try:
            connection = load_runtime_connection(destination, require_live_process=False)
        except ValueError:
            return False
        if connection is None or connection.instance_id != instance_id:
            return False
        destination.unlink(missing_ok=True)
        return True
