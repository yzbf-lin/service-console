"""Inspect listening ports and safely terminate their owning processes."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
from collections.abc import Iterable
from typing import Any

import psutil


PortRow = dict[str, object]


class PortInspector:
    """Read host port ownership and perform guarded process termination."""

    @staticmethod
    def list_ports(port: int | None = None) -> list[PortRow]:
        """Return stable, de-duplicated TCP listeners and bound UDP sockets.

        ``psutil.net_connections`` is preferred. macOS commonly denies its
        system-wide sysctl query to an unprivileged process, so that specific
        failure falls back to ``lsof`` without making per-process metadata
        access a requirement.
        """

        _validate_port(port)
        try:
            rows = _scan_psutil(port)
        except (psutil.AccessDenied, PermissionError, OSError, NotImplementedError) as exc:
            if sys.platform != "darwin":
                raise RuntimeError(f"failed to inspect system ports: {exc}") from exc
            rows = _scan_lsof(port)
        return _normalize(rows)

    @staticmethod
    def terminate(
        pid: int,
        expected_port: int | None = None,
        force: bool = False,
        timeout: float = 3.0,
    ) -> PortRow:
        """Terminate a process after optionally re-checking its port ownership.

        ``force=False`` sends the normal terminate signal and waits. ``force``
        sends the platform kill signal instead. The PID identity is checked
        again immediately before signaling to reduce PID-reuse risk.
        """

        if not isinstance(pid, int) or isinstance(pid, bool):
            raise ValueError("pid must be an integer")
        if pid <= 1:
            raise ValueError("refusing to terminate system PID 0 or 1")
        if pid == os.getpid():
            raise ValueError("refusing to terminate the service-console controller process")
        _validate_port(expected_port)
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")

        process = _get_process(pid)
        created_at = _get_create_time(process, pid)

        if expected_port is not None:
            owners = PortInspector.list_ports(expected_port)
            if not any(item.get("pid") == pid for item in owners):
                raise ValueError(
                    f"process {pid} is no longer listening on or bound to port {expected_port}"
                )

        # Construct a fresh Process object so a recycled PID cannot inherit the
        # authorization established by the earlier port ownership check.
        current = _get_process(pid)
        if _get_create_time(current, pid) != created_at:
            raise ValueError(f"process {pid} changed identity before it could be terminated")

        action = "kill" if force else "terminate"
        try:
            if force:
                current.kill()
            else:
                current.terminate()
        except psutil.NoSuchProcess as exc:
            raise ValueError(f"process {pid} disappeared before it could be terminated") from exc
        except psutil.AccessDenied as exc:
            raise RuntimeError(f"permission denied while attempting to {action} process {pid}") from exc
        except OSError as exc:
            raise RuntimeError(f"failed to {action} process {pid}: {exc}") from exc

        try:
            exit_code = current.wait(timeout=timeout)
        except psutil.TimeoutExpired as exc:
            hint = "" if force else "; retry with force=True to send a kill signal"
            raise RuntimeError(
                f"process {pid} did not exit within {timeout:g} seconds after {action}{hint}"
            ) from exc
        except psutil.NoSuchProcess:
            # Disappearance after a signal is the successful outcome we were
            # waiting for; some psutil/platform combinations report it this way.
            exit_code = None
        except psutil.AccessDenied as exc:
            raise RuntimeError(f"permission denied while waiting for process {pid} to exit") from exc
        except OSError as exc:
            raise RuntimeError(f"failed while waiting for process {pid} to exit: {exc}") from exc

        return {
            "pid": pid,
            "expected_port": expected_port,
            "action": action,
            "force": force,
            "terminated": True,
            "exit_code": exit_code,
        }


def _validate_port(port: int | None) -> None:
    if port is None:
        return
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65_535:
        raise ValueError("port must be an integer between 1 and 65535")


def _get_process(pid: int) -> psutil.Process:
    try:
        return psutil.Process(pid)
    except psutil.NoSuchProcess as exc:
        raise ValueError(f"process {pid} does not exist") from exc
    except psutil.AccessDenied as exc:
        raise RuntimeError(f"permission denied while inspecting process {pid}") from exc
    except OSError as exc:
        raise RuntimeError(f"failed to inspect process {pid}: {exc}") from exc


def _get_create_time(process: psutil.Process, pid: int) -> float:
    try:
        return process.create_time()
    except psutil.NoSuchProcess as exc:
        raise ValueError(f"process {pid} disappeared while it was being inspected") from exc
    except psutil.AccessDenied as exc:
        raise RuntimeError(f"permission denied while inspecting process {pid}") from exc
    except OSError as exc:
        raise RuntimeError(f"failed to inspect process {pid}: {exc}") from exc


def _scan_psutil(port: int | None) -> list[PortRow]:
    connections = psutil.net_connections(kind="inet")
    details: dict[int, tuple[object, object, object]] = {}
    rows: list[PortRow] = []
    for connection in connections:
        endpoint = _endpoint(connection.laddr)
        if endpoint is None:
            continue
        local_address, local_port = endpoint
        if port is not None and local_port != port:
            continue

        if connection.type == socket.SOCK_STREAM:
            if connection.status != psutil.CONN_LISTEN:
                continue
            protocol = "tcp"
        elif connection.type == socket.SOCK_DGRAM:
            # UDP has no LISTEN state. A bound local endpoint is what consumes
            # the port, including a connected UDP socket.
            protocol = "udp"
        else:
            continue

        pid = connection.pid
        process_name, command, username = _process_details(pid, details)
        rows.append(
            {
                "protocol": protocol,
                "local_address": local_address,
                "port": local_port,
                "pid": pid,
                "process_name": process_name,
                "command": command,
                "username": username,
            }
        )
    return rows


def _endpoint(address: Any) -> tuple[str, int] | None:
    if not address:
        return None
    try:
        host = str(address.ip)
        port = int(address.port)
    except AttributeError:
        if not isinstance(address, tuple) or len(address) < 2:
            return None
        host, raw_port = address[0], address[1]
        try:
            port = int(raw_port)
        except (TypeError, ValueError):
            return None
        host = str(host)
    if not 1 <= port <= 65_535:
        return None
    return host, port


def _process_details(
    pid: int | None,
    cache: dict[int, tuple[object, object, object]],
) -> tuple[object, object, object]:
    if pid is None or pid <= 0:
        return None, None, None
    if pid in cache:
        return cache[pid]

    process_name: object = None
    command: object = None
    username: object = None
    try:
        process = psutil.Process(pid)
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        result = (process_name, command, username)
        cache[pid] = result
        return result

    try:
        process_name = process.name()
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        pass
    try:
        command_line = process.cmdline()
        command = " ".join(command_line) if command_line else process_name
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        pass
    try:
        username = process.username()
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        pass

    result = (process_name, command, username)
    cache[pid] = result
    return result


def _scan_lsof(port: int | None) -> list[PortRow]:
    rows: list[PortRow] = []
    rows.extend(_run_lsof("tcp", port))
    try:
        rows.extend(_run_lsof("udp", port))
    except RuntimeError:
        # TCP listeners are the primary result. UDP inspection is best-effort
        # because some host security configurations deny it independently.
        pass
    return rows


def _run_lsof(protocol: str, port: int | None) -> list[PortRow]:
    if protocol == "tcp":
        command = ["lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-FpcLfnT"]
    else:
        command = ["lsof", "-nP", "-iUDP", "-FpcLfnT"]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=5.0,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("psutil port inspection failed and lsof is not installed") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("timed out while inspecting ports with lsof") from exc
    except OSError as exc:
        raise RuntimeError(f"failed to run lsof: {exc}") from exc

    # lsof exits 1 when the selection has no matches.
    if completed.returncode not in (0, 1):
        detail = completed.stderr.strip() or f"exit status {completed.returncode}"
        raise RuntimeError(f"lsof port inspection failed: {detail}")
    return _parse_lsof(completed.stdout.splitlines(), protocol, port)


def _parse_lsof(lines: Iterable[str], protocol: str, port: int | None) -> list[PortRow]:
    current_pid: int | None = None
    current_name: object = None
    current_username: object = None
    detail_cache: dict[int, tuple[object, object, object]] = {}
    rows: list[PortRow] = []

    for line in lines:
        if not line:
            continue
        field, value = line[0], line[1:]
        if field == "p":
            try:
                current_pid = int(value)
            except ValueError:
                current_pid = None
            current_name = None
            current_username = None
        elif field == "c":
            current_name = value or None
        elif field == "L":
            current_username = value or None
        elif field == "n":
            endpoint = _lsof_endpoint(value)
            if endpoint is None:
                continue
            local_address, local_port = endpoint
            if port is not None and local_port != port:
                continue

            process_name, command, username = _process_details(current_pid, detail_cache)
            process_name = process_name or current_name
            command = command or current_name
            username = username or current_username
            rows.append(
                {
                    "protocol": protocol,
                    "local_address": local_address,
                    "port": local_port,
                    "pid": current_pid,
                    "process_name": process_name,
                    "command": command,
                    "username": username,
                }
            )
    return rows


def _lsof_endpoint(name: str) -> tuple[str, int] | None:
    local = name.split("->", 1)[0]
    try:
        host, raw_port = local.rsplit(":", 1)
        port = int(raw_port)
    except (ValueError, TypeError):
        return None
    if not 1 <= port <= 65_535:
        return None
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return host, port


def _normalize(rows: Iterable[PortRow]) -> list[PortRow]:
    unique: dict[tuple[object, ...], PortRow] = {}
    for row in rows:
        key = (row["protocol"], row["local_address"], row["port"], row["pid"])
        unique.setdefault(key, row)
    return sorted(
        unique.values(),
        key=lambda row: (
            int(row["port"]),
            str(row["protocol"]),
            str(row["local_address"]),
            -1 if row["pid"] is None else int(row["pid"]),
            str(row["process_name"] or ""),
        ),
    )
