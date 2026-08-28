from __future__ import annotations

import os
import socket
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock

import psutil
import pytest

from service_console import ports
from service_console.ports import PortInspector


def connection(
    protocol: int,
    address: tuple[str, int],
    pid: int,
    status: str = psutil.CONN_NONE,
) -> SimpleNamespace:
    return SimpleNamespace(type=protocol, laddr=address, pid=pid, status=status)


def process_details(name: object, cmdline: object, username: object) -> Mock:
    process = Mock()
    process.name.side_effect = name if isinstance(name, BaseException) else None
    if process.name.side_effect is None:
        process.name.return_value = name
    process.cmdline.side_effect = cmdline if isinstance(cmdline, BaseException) else None
    if process.cmdline.side_effect is None:
        process.cmdline.return_value = cmdline
    process.username.side_effect = username if isinstance(username, BaseException) else None
    if process.username.side_effect is None:
        process.username.return_value = username
    return process


def test_list_ports_filters_sorts_deduplicates_and_tolerates_metadata_denial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        ports.psutil,
        "net_connections",
        lambda **_: [
            connection(socket.SOCK_STREAM, ("127.0.0.1", 9000), 42, psutil.CONN_LISTEN),
            connection(socket.SOCK_STREAM, ("127.0.0.1", 9000), 42, psutil.CONN_LISTEN),
            connection(socket.SOCK_STREAM, ("127.0.0.1", 8000), 44, "ESTABLISHED"),
            connection(socket.SOCK_DGRAM, ("0.0.0.0", 7000), 43),
            connection(socket.SOCK_STREAM, ("::1", 7000), 45, psutil.CONN_LISTEN),
        ],
    )
    processes = {
        42: process_details("python", ["python", "server.py"], "test-user"),
        43: process_details("dns", psutil.AccessDenied(pid=43), "root"),
        45: process_details("node", ["node", "app.js"], "test-user"),
    }
    monkeypatch.setattr(ports.psutil, "Process", lambda pid: processes[pid])

    rows = PortInspector.list_ports()

    assert [(row["port"], row["protocol"], row["pid"]) for row in rows] == [
        (7000, "tcp", 45),
        (7000, "udp", 43),
        (9000, "tcp", 42),
    ]
    assert rows[1]["command"] is None
    assert rows[2] == {
        "protocol": "tcp",
        "local_address": "127.0.0.1",
        "port": 9000,
        "pid": 42,
        "process_name": "python",
        "command": "python server.py",
        "username": "test-user",
    }
    assert PortInspector.list_ports(9000) == [rows[2]]


def test_macos_permission_error_falls_back_to_lsof(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ports.sys, "platform", "darwin")
    monkeypatch.setattr(
        ports.psutil,
        "net_connections",
        Mock(side_effect=PermissionError(1, "Operation not permitted")),
    )
    monkeypatch.setattr(
        ports.psutil,
        "Process",
        Mock(side_effect=psutil.AccessDenied(pid=321)),
    )
    tcp_output = "\n".join(
        [
            "p321",
            "cpython3",
            "Lalice",
            "f8",
            "n127.0.0.1:8080",
            "TST=LISTEN",
            "f9",
            "n127.0.0.1:8080",
        ]
    )
    udp_output = "\n".join(
        [
            "p654",
            "cdns",
            "Lroot",
            "f4",
            "n[::1]:5353->8.8.8.8:53",
            "f5",
            "n*:*",
        ]
    )
    run = Mock(
        side_effect=[
            subprocess.CompletedProcess([], 0, tcp_output, ""),
            subprocess.CompletedProcess([], 0, udp_output, ""),
        ]
    )
    monkeypatch.setattr(ports.subprocess, "run", run)

    rows = PortInspector.list_ports()

    assert rows == [
        {
            "protocol": "udp",
            "local_address": "::1",
            "port": 5353,
            "pid": 654,
            "process_name": "dns",
            "command": "dns",
            "username": "root",
        },
        {
            "protocol": "tcp",
            "local_address": "127.0.0.1",
            "port": 8080,
            "pid": 321,
            "process_name": "python3",
            "command": "python3",
            "username": "alice",
        },
    ]
    assert run.call_count == 2
    assert "-sTCP:LISTEN" in run.call_args_list[0].args[0]
    assert "-iUDP" in run.call_args_list[1].args[0]


def test_macos_lsof_keeps_tcp_rows_when_udp_scan_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ports.sys, "platform", "darwin")
    monkeypatch.setattr(
        ports.psutil,
        "net_connections",
        Mock(side_effect=PermissionError(1, "Operation not permitted")),
    )
    monkeypatch.setattr(
        ports.psutil,
        "Process",
        Mock(side_effect=psutil.AccessDenied(pid=321)),
    )
    run = Mock(
        side_effect=[
            subprocess.CompletedProcess([], 0, "p321\ncpython\nLalice\nf8\nn*:8080", ""),
            subprocess.CompletedProcess([], 2, "", "UDP inspection denied"),
        ]
    )
    monkeypatch.setattr(ports.subprocess, "run", run)

    assert PortInspector.list_ports() == [
        {
            "protocol": "tcp",
            "local_address": "*",
            "port": 8080,
            "pid": 321,
            "process_name": "python",
            "command": "python",
            "username": "alice",
        }
    ]


def test_non_macos_scan_failure_is_clear(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ports.sys, "platform", "linux")
    monkeypatch.setattr(ports.psutil, "net_connections", Mock(side_effect=OSError("blocked")))

    with pytest.raises(RuntimeError, match="failed to inspect system ports: blocked"):
        PortInspector.list_ports()


@pytest.mark.parametrize("pid", [0, 1, -5])
def test_terminate_rejects_system_pids_without_opening_a_process(
    monkeypatch: pytest.MonkeyPatch,
    pid: int,
) -> None:
    process_factory = Mock()
    monkeypatch.setattr(ports.psutil, "Process", process_factory)

    with pytest.raises(ValueError, match="system PID"):
        PortInspector.terminate(pid)
    process_factory.assert_not_called()


def test_terminate_rejects_controller_pid(monkeypatch: pytest.MonkeyPatch) -> None:
    process_factory = Mock()
    monkeypatch.setattr(ports.psutil, "Process", process_factory)

    with pytest.raises(ValueError, match="controller"):
        PortInspector.terminate(os.getpid())
    process_factory.assert_not_called()


def termination_process(created_at: float = 123.0, exit_code: int | None = 0) -> Mock:
    process = Mock()
    process.create_time.return_value = created_at
    process.wait.return_value = exit_code
    return process


def test_terminate_rechecks_expected_port_then_sends_terminate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = termination_process()
    current = termination_process(exit_code=-15)
    process_factory = Mock(side_effect=[original, current])
    monkeypatch.setattr(ports.psutil, "Process", process_factory)
    list_ports = Mock(return_value=[{"pid": 222, "port": 8080}])
    monkeypatch.setattr(PortInspector, "list_ports", list_ports)

    result = PortInspector.terminate(222, expected_port=8080, timeout=1.5)

    assert result == {
        "pid": 222,
        "expected_port": 8080,
        "action": "terminate",
        "force": False,
        "terminated": True,
        "exit_code": -15,
    }
    list_ports.assert_called_once_with(8080)
    current.terminate.assert_called_once_with()
    current.kill.assert_not_called()
    current.wait.assert_called_once_with(timeout=1.5)


def test_terminate_refuses_when_process_no_longer_owns_expected_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = termination_process()
    monkeypatch.setattr(ports.psutil, "Process", Mock(return_value=process))
    monkeypatch.setattr(PortInspector, "list_ports", Mock(return_value=[{"pid": 999}]))

    with pytest.raises(ValueError, match="no longer listening on or bound to port 8080"):
        PortInspector.terminate(222, expected_port=8080)
    process.terminate.assert_not_called()
    process.kill.assert_not_called()


def test_terminate_refuses_recycled_pid(monkeypatch: pytest.MonkeyPatch) -> None:
    original = termination_process(created_at=100.0)
    recycled = termination_process(created_at=200.0)
    monkeypatch.setattr(ports.psutil, "Process", Mock(side_effect=[original, recycled]))
    monkeypatch.setattr(PortInspector, "list_ports", Mock(return_value=[{"pid": 222}]))

    with pytest.raises(ValueError, match="changed identity"):
        PortInspector.terminate(222, expected_port=8080)
    recycled.terminate.assert_not_called()
    recycled.kill.assert_not_called()


def test_force_uses_kill_and_timeout_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    original = termination_process()
    current = termination_process()
    current.wait.side_effect = psutil.TimeoutExpired(0.25, pid=222)
    monkeypatch.setattr(ports.psutil, "Process", Mock(side_effect=[original, current]))

    with pytest.raises(RuntimeError, match="did not exit within 0.25 seconds after kill"):
        PortInspector.terminate(222, force=True, timeout=0.25)
    current.kill.assert_called_once_with()
    current.terminate.assert_not_called()


def test_missing_process_and_signal_permission_errors_are_clear(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        ports.psutil,
        "Process",
        Mock(side_effect=psutil.NoSuchProcess(pid=222)),
    )
    with pytest.raises(ValueError, match="process 222 does not exist"):
        PortInspector.terminate(222)

    original = termination_process()
    current = termination_process()
    current.terminate.side_effect = psutil.AccessDenied(pid=222)
    monkeypatch.setattr(ports.psutil, "Process", Mock(side_effect=[original, current]))
    with pytest.raises(RuntimeError, match="permission denied while attempting to terminate process 222"):
        PortInspector.terminate(222)
