"""Standalone native update helper used by frozen Windows releases.

The helper intentionally depends on the Python standard library only so it can be
packaged as a small one-file executable outside the directory it replaces.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path, PureWindowsPath


UPDATE_READY_FILE_ENV = "SERVICE_CONSOLE_UPDATE_READY_FILE"
UPDATE_RESTART_ARGUMENTS_ENV = "SERVICE_CONSOLE_UPDATE_RESTART_ARGUMENTS"

_SYNCHRONIZE = 0x00100000
_INFINITE = 0xFFFFFFFF
_WAIT_OBJECT_0 = 0x00000000
_ERROR_INVALID_PARAMETER = 87
_ERROR_NOT_FOUND = 1168


class UpdateHelperError(RuntimeError):
    """A terminal update failure that has already been written to the install log."""


def _timestamp() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _append_log(log_file: Path, message: str) -> None:
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a", encoding="utf-8") as output:
            output.write(f"{_timestamp()} {message}\n")
            output.flush()
            os.fsync(output.fileno())
    except OSError:
        # Replacement and rollback are authoritative; logging remains best-effort.
        pass


def _validated_launch_relative(value: str) -> Path:
    candidate = PureWindowsPath(value)
    if (
        candidate.is_absolute()
        or bool(candidate.drive)
        or not candidate.parts
        or any(part in {"", ".", ".."} for part in candidate.parts)
    ):
        raise UpdateHelperError("The launch executable must be a safe relative path")
    return Path(*candidate.parts)


def _write_started_marker(started_file: Path) -> None:
    started_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = started_file.with_name(f".{started_file.name}.{os.getpid()}.tmp")
    payload = {
        "pid": os.getpid(),
        "started_at": datetime.now(UTC).isoformat(),
    }
    with temporary.open("w", encoding="utf-8") as marker:
        json.dump(payload, marker, ensure_ascii=False, separators=(",", ":"))
        marker.flush()
        os.fsync(marker.fileno())
    os.replace(temporary, started_file)


def _wait_for_process_exit(process_id: int) -> None:
    if process_id <= 0:
        raise UpdateHelperError("The desktop process id must be positive")
    if os.name != "nt":
        while True:
            try:
                os.kill(process_id, 0)
            except ProcessLookupError:
                return
            time.sleep(0.2)

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.WaitForSingleObject.restype = ctypes.c_uint32
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int

    handle = kernel32.OpenProcess(_SYNCHRONIZE, False, process_id)
    if not handle:
        error = ctypes.get_last_error()
        if error in {_ERROR_INVALID_PARAMETER, _ERROR_NOT_FOUND}:
            return
        raise OSError(error, f"Unable to wait for desktop process {process_id}")
    try:
        result = kernel32.WaitForSingleObject(handle, _INFINITE)
    finally:
        kernel32.CloseHandle(handle)
    if result != _WAIT_OBJECT_0:
        raise OSError(ctypes.get_last_error(), f"Unable to wait for desktop process {process_id}")


def _remove_tree(path: Path, *, attempts: int = 25) -> None:
    if not path.exists():
        return
    last_error: OSError | None = None
    for attempt in range(attempts):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(0.2)
    assert last_error is not None
    raise last_error


def _replace_path(source: Path, target: Path, *, attempts: int = 25) -> None:
    last_error: OSError | None = None
    for attempt in range(attempts):
        try:
            os.replace(source, target)
            return
        except OSError as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(0.2)
    assert last_error is not None
    raise last_error


def _start_application(
    executable: Path,
    application_root: Path,
    *,
    ready_file: Path | None,
    restart_arguments: str,
    log_file: Path,
) -> subprocess.Popen[bytes]:
    environment = os.environ.copy()
    environment[UPDATE_RESTART_ARGUMENTS_ENV] = restart_arguments
    if ready_file is None:
        environment.pop(UPDATE_READY_FILE_ENV, None)
    else:
        environment[UPDATE_READY_FILE_ENV] = str(ready_file)

    creation_flags = (
        getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    )
    log_file.parent.mkdir(parents=True, exist_ok=True)
    with log_file.open("ab", buffering=0) as output:
        return subprocess.Popen(
            [str(executable)],
            cwd=str(application_root),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            close_fds=True,
            creationflags=creation_flags,
        )


def _wait_for_readiness(
    process: subprocess.Popen[bytes],
    ready_file: Path,
    timeout: float,
) -> None:
    deadline = time.monotonic() + timeout
    while True:
        return_code = process.poll()
        if ready_file.is_file():
            if return_code is None:
                return
            raise UpdateHelperError(
                f"Updated application exited with status {return_code} after becoming ready"
            )
        if return_code is not None:
            raise UpdateHelperError(
                f"Updated application exited with status {return_code} before becoming ready"
            )
        if time.monotonic() >= deadline:
            raise UpdateHelperError(
                f"Updated application did not become ready within {timeout:g} seconds"
            )
        time.sleep(0.2)


def _stop_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _rollback(
    *,
    target: Path,
    incoming: Path,
    backup: Path,
    launch_relative: Path,
    ready_file: Path,
    restart_arguments: str,
    log_file: Path,
    new_process: subprocess.Popen[bytes] | None,
) -> None:
    _stop_process(new_process)
    ready_file.unlink(missing_ok=True)
    if backup.exists():
        _remove_tree(target)
        _replace_path(backup, target)
    _remove_tree(incoming)

    rollback_executable = target / launch_relative
    if not rollback_executable.is_file():
        _append_log(log_file, "Rollback failed: restored executable is missing")
        return
    try:
        _start_application(
            rollback_executable,
            target,
            ready_file=None,
            restart_arguments=restart_arguments,
            log_file=log_file,
        )
    except OSError as exc:
        _append_log(log_file, f"Rollback failed to relaunch the previous version: {exc}")
    else:
        _append_log(log_file, "Rollback restored and relaunched the previous version")


def apply_update(
    *,
    process_id: int,
    source: str | Path,
    target: str | Path,
    launch_relative: str,
    ready_file: str | Path,
    started_file: str | Path,
    log_file: str | Path,
    restart_arguments: str,
    ready_timeout: float = 90.0,
) -> None:
    """Replace an installed directory and keep rollback authoritative until ready."""

    source_path = Path(source).resolve()
    target_path = Path(target).resolve()
    ready_path = Path(ready_file).resolve()
    started_path = Path(started_file).resolve()
    log_path = Path(log_file).resolve()
    relative_executable = _validated_launch_relative(launch_relative)
    if not source_path.is_dir():
        raise UpdateHelperError("The prepared update directory is missing")
    if not target_path.is_dir():
        raise UpdateHelperError("The installed application directory is missing")
    if source_path == target_path:
        raise UpdateHelperError("The prepared and installed application directories must differ")
    if ready_timeout <= 0:
        raise UpdateHelperError("The readiness timeout must be positive")

    incoming = target_path.with_name(f"{target_path.name}.update-new")
    backup = target_path.with_name(f"{target_path.name}.update-backup")
    new_process: subprocess.Popen[bytes] | None = None

    log_path.parent.mkdir(parents=True, exist_ok=True)
    _append_log(log_path, f"Native updater process {os.getpid()} started")
    _write_started_marker(started_path)
    _append_log(log_path, f"Waiting for desktop process {process_id} to exit")
    _wait_for_process_exit(process_id)
    _append_log(log_path, "Desktop process exited; preparing application swap")

    try:
        if not target_path.exists() and backup.exists():
            _replace_path(backup, target_path)
        if not target_path.is_dir():
            raise UpdateHelperError("Installed application is missing")

        _remove_tree(incoming)
        _remove_tree(backup)
        ready_path.unlink(missing_ok=True)
        shutil.copytree(source_path, incoming)
        _replace_path(target_path, backup)
        _replace_path(incoming, target_path)

        updated_executable = target_path / relative_executable
        if not updated_executable.is_file():
            raise UpdateHelperError("Updated executable is missing")
        new_process = _start_application(
            updated_executable,
            target_path,
            ready_file=ready_path,
            restart_arguments=restart_arguments,
            log_file=log_path,
        )
        _append_log(log_path, f"Started updated application process {new_process.pid}")
        _wait_for_readiness(new_process, ready_path, ready_timeout)
        ready_path.unlink(missing_ok=True)
        try:
            _remove_tree(backup)
        except OSError as exc:
            _append_log(log_path, f"Update succeeded; backup cleanup is deferred: {exc}")
        _append_log(log_path, "Update completed after the desktop readiness marker")
    except Exception as exc:
        _append_log(log_path, f"Update failed: {exc}")
        try:
            _rollback(
                target=target_path,
                incoming=incoming,
                backup=backup,
                launch_relative=relative_executable,
                ready_file=ready_path,
                restart_arguments=restart_arguments,
                log_file=log_path,
                new_process=new_process,
            )
        except Exception as rollback_error:
            _append_log(log_path, f"Rollback failed: {rollback_error}")
        if isinstance(exc, UpdateHelperError):
            raise
        raise UpdateHelperError(str(exc) or exc.__class__.__name__) from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="Service Console Updater")
    parser.add_argument("--process-id", required=True, type=int)
    parser.add_argument("--source", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--launch-relative", required=True)
    parser.add_argument("--ready-file", required=True)
    parser.add_argument("--started-file", required=True)
    parser.add_argument("--log-file", required=True)
    parser.add_argument("--restart-arguments", required=True)
    parser.add_argument("--ready-timeout", type=float, default=90.0)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        apply_update(
            process_id=args.process_id,
            source=args.source,
            target=args.target,
            launch_relative=args.launch_relative,
            ready_file=args.ready_file,
            started_file=args.started_file,
            log_file=args.log_file,
            restart_arguments=args.restart_arguments,
            ready_timeout=args.ready_timeout,
        )
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
