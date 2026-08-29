from __future__ import annotations

import asyncio
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

import psutil
import pytest

from service_console import manager as manager_module
from service_console.manager import ServiceManager
from service_console.models import ServiceDefinition


def python_command(source: str) -> str:
    argv = [sys.executable, "-u", "-c", source]
    if os.name == "nt":
        return subprocess.list2cmdline(argv)
    return shlex.join(argv)


async def wait_for_state(
    manager: ServiceManager,
    name: str,
    expected: set[str],
    timeout: float = 5.0,
) -> dict[str, object]:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        service = await manager.get_service(name)
        if service["state"] in expected:
            return service
        await asyncio.sleep(0.02)
    raise AssertionError(f"service {name} did not reach one of {expected}")


@pytest.mark.asyncio
async def test_definitions_and_logs_persist(tmp_path: Path) -> None:
    manager = ServiceManager(tmp_path, log_buffer_size=2, monitor_interval=0.05)
    definition = ServiceDefinition(
        name="echo",
        command=python_command("import sys; print('one'); print('two'); print('problem', file=sys.stderr)"),
        cwd=str(tmp_path),
    )
    await manager.add_service(definition)
    await manager.start("echo")
    exited = await wait_for_state(manager, "echo", {"EXITED"})
    assert exited["exit_code"] == 0

    # A tail larger than the in-memory ring is served from the persistent JSONL log.
    logs = await manager.get_logs("echo", tail=10)
    assert {(entry["stream"], entry["message"]) for entry in logs} == {
        ("stdout", "one"),
        ("stdout", "two"),
        ("stderr", "problem"),
    }
    assert len(manager._services["echo"].logs) == 2
    await manager.shutdown()

    restored = ServiceManager(tmp_path, log_buffer_size=2)
    await restored.initialize()
    service = await restored.get_service("echo")
    assert service["command"] == definition.command
    assert service["state"] == "STOPPED"
    assert {entry["message"] for entry in await restored.get_logs("echo", 10)} == {
        "one",
        "two",
        "problem",
    }
    await restored.shutdown()


@pytest.mark.asyncio
async def test_events_follow_status_and_both_output_streams(tmp_path: Path) -> None:
    manager = ServiceManager(tmp_path, monitor_interval=0.05)
    queue = manager.subscribe()
    await manager.add_service(
        ServiceDefinition(
            name="events",
            command=python_command("import sys; print('out'); print('err', file=sys.stderr)"),
            cwd=str(tmp_path),
        )
    )
    await manager.start("events")
    await wait_for_state(manager, "events", {"EXITED"})

    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    assert all(set(event) == {"type", "service", "data"} for event in events)
    assert {event["data"]["message"] for event in events if event["type"] == "log"} == {"out", "err"}
    states = [event["data"]["state"] for event in events if event["type"] == "status"]
    assert "STARTING" in states
    assert "RUNNING" in states
    assert "EXITED" in states
    manager.unsubscribe(queue)
    await manager.shutdown()


@pytest.mark.asyncio
async def test_concurrent_lifecycle_calls_are_serialized(tmp_path: Path) -> None:
    manager = ServiceManager(tmp_path, monitor_interval=0.05)
    await manager.add_service(
        ServiceDefinition(
            name="sleep",
            command=python_command("import time; time.sleep(30)"),
            cwd=str(tmp_path),
            stop_timeout=0.5,
        )
    )

    started = await asyncio.gather(*(manager.start("sleep") for _ in range(5)))
    first_pid = started[0]["pid"]
    assert first_pid is not None
    assert {service["pid"] for service in started} == {first_pid}
    assert {service["restart_count"] for service in started} == {0}
    await asyncio.sleep(0.02)
    assert (await manager.get_service("sleep"))["uptime_seconds"] > 0

    restarted = await manager.restart("sleep")
    assert restarted["state"] == "RUNNING"
    assert restarted["pid"] != first_pid
    assert restarted["restart_count"] == 1

    stopped = await asyncio.gather(*(manager.stop("sleep") for _ in range(3)))
    assert {service["state"] for service in stopped} == {"STOPPED"}
    assert all(service["pid"] is None for service in stopped)
    await manager.shutdown()


@pytest.mark.asyncio
async def test_running_service_update_applies_on_restart_and_persists(tmp_path: Path) -> None:
    manager = ServiceManager(tmp_path, monitor_interval=0.05)
    await manager.add_service(
        ServiceDefinition(
            name="editable",
            command=python_command("import time; time.sleep(30)"),
            cwd=str(tmp_path),
            stop_timeout=0.5,
        )
    )
    running = await manager.start("editable")
    original_pid = running["pid"]
    replacement = ServiceDefinition(
        name="editable",
        command=python_command("import os; print('updated=' + os.environ['EDIT_VALUE'], flush=True)"),
        cwd=str(tmp_path),
        env={"EDIT_VALUE": "yes"},
        auto_start=False,
        stop_timeout=0.75,
    )

    updated = await manager.update_service("editable", replacement)
    assert updated["state"] == "RUNNING"
    assert updated["pid"] == original_pid
    assert updated["command"] == replacement.command
    with pytest.raises(ValueError, match="renaming a service is not supported"):
        await manager.update_service(
            "editable",
            ServiceDefinition(name="renamed", command=replacement.command, cwd=str(tmp_path)),
        )

    await manager.restart("editable")
    await wait_for_state(manager, "editable", {"EXITED"})
    assert any(entry["message"] == "updated=yes" for entry in await manager.get_logs("editable", 20))
    await manager.shutdown()

    restored = ServiceManager(tmp_path)
    await restored.initialize()
    snapshot = await restored.get_service("editable")
    assert snapshot["command"] == replacement.command
    assert snapshot["env"] == {"EDIT_VALUE": "yes"}
    assert snapshot["stop_timeout"] == 0.75
    await restored.shutdown()


@pytest.mark.asyncio
async def test_service_environment_overrides_login_shell_baseline(tmp_path: Path) -> None:
    base_environment = os.environ.copy()
    base_environment.update(
        {
            "LOGIN_ONLY": "available",
            "OVERRIDE_VALUE": "from-login-shell",
        }
    )
    manager = ServiceManager(
        tmp_path,
        monitor_interval=0.05,
        base_environment=base_environment,
    )
    await manager.add_service(
        ServiceDefinition(
            name="environment",
            command=python_command(
                "import os; "
                "print(os.environ['LOGIN_ONLY'], flush=True); "
                "print(os.environ['OVERRIDE_VALUE'], flush=True)"
            ),
            cwd=str(tmp_path),
            env={"OVERRIDE_VALUE": "from-service"},
        )
    )

    await manager.start("environment")
    await wait_for_state(manager, "environment", {"EXITED"})

    messages = [entry["message"] for entry in await manager.get_logs("environment", 10)]
    assert messages == ["available", "from-service"]
    await manager.shutdown()


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="fixture executable uses a POSIX shell script")
async def test_login_shell_path_resolves_managed_command(tmp_path: Path) -> None:
    tool_directory = tmp_path / "login-bin"
    tool_directory.mkdir()
    tool = tool_directory / "service-console-path-fixture"
    tool.write_text("#!/bin/sh\nprintf 'resolved-from-login-path\\n'\n", encoding="utf-8")
    tool.chmod(0o700)
    base_environment = os.environ.copy()
    base_environment["PATH"] = f"{tool_directory}{os.pathsep}{base_environment.get('PATH', '')}"
    manager = ServiceManager(
        tmp_path / "data",
        monitor_interval=0.05,
        base_environment=base_environment,
    )
    await manager.add_service(
        ServiceDefinition(
            name="path",
            command="service-console-path-fixture",
            cwd=str(tmp_path),
        )
    )

    await manager.start("path")
    exited = await wait_for_state(manager, "path", {"EXITED"})

    assert exited["exit_code"] == 0
    assert [entry["message"] for entry in await manager.get_logs("path", 10)] == [
        "resolved-from-login-path"
    ]
    await manager.shutdown()


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="SIGTERM handling is POSIX-specific")
async def test_stop_escalates_to_sigkill_for_term_ignoring_process(tmp_path: Path) -> None:
    manager = ServiceManager(tmp_path, monitor_interval=0.05)
    await manager.add_service(
        ServiceDefinition(
            name="stubborn",
            command=python_command(
                "import os, signal, time; "
                "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                "print(os.getpid(), flush=True); "
                "time.sleep(30)"
            ),
            cwd=str(tmp_path),
            stop_timeout=0.2,
        )
    )
    service = await manager.start("stubborn")
    pid = int(service["pid"])
    await asyncio.sleep(0.1)

    started_at = time.monotonic()
    stopped = await manager.stop("stubborn")
    elapsed = time.monotonic() - started_at
    assert elapsed >= 0.15
    assert stopped["state"] == "STOPPED"
    assert stopped["exit_code"] is not None
    assert not psutil.pid_exists(pid)
    await manager.shutdown()


@pytest.mark.asyncio
async def test_resource_snapshot_reports_process_group_memory(tmp_path: Path) -> None:
    manager = ServiceManager(tmp_path, monitor_interval=0.05)
    await manager.add_service(
        ServiceDefinition(
            name="resources",
            command=python_command("import time; payload = bytearray(8_000_000); time.sleep(30)"),
            cwd=str(tmp_path),
            stop_timeout=0.5,
        )
    )
    await manager.start("resources")

    deadline = asyncio.get_running_loop().time() + 3
    while True:
        snapshot = await manager.get_service("resources")
        if snapshot["memory_rss"] >= 8_000_000:
            break
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError(f"memory snapshot stayed at {snapshot['memory_rss']}")
        await asyncio.sleep(0.05)
    assert snapshot["cpu_percent"] >= 0
    await manager.stop("resources")
    await manager.shutdown()


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="Windows uses process groups without os.getpgid")
async def test_new_process_owns_its_unix_process_group(tmp_path: Path) -> None:
    manager = ServiceManager(tmp_path)
    await manager.add_service(
        ServiceDefinition(
            name="group",
            command=python_command("import time; time.sleep(30)"),
            cwd=str(tmp_path),
        )
    )
    service = await manager.start("group")
    pid = int(service["pid"])
    assert os.getpgid(pid) == pid
    await manager.stop("group")
    await manager.shutdown()


def test_windows_uses_new_process_group_and_signals_the_complete_process_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, int]] = []

    class FakeTreeProcess:
        def __init__(self, pid: int, children: list[FakeTreeProcess] | None = None) -> None:
            self.pid = pid
            self._children = children or []

        def children(self, *, recursive: bool) -> list[FakeTreeProcess]:
            assert recursive is True
            return list(self._children)

        def terminate(self) -> None:
            calls.append(("terminate", self.pid))

        def kill(self) -> None:
            calls.append(("kill", self.pid))

        def is_running(self) -> bool:
            return False

    grandchild = FakeTreeProcess(103)
    child = FakeTreeProcess(102)
    root = FakeTreeProcess(101, [child, grandchild])
    shell_process = type("ShellProcess", (), {"pid": 101})()
    monkeypatch.setattr(manager_module, "_IS_WINDOWS", True)
    monkeypatch.setattr(manager_module.psutil, "Process", lambda pid: root if pid == 101 else None)

    assert manager_module._subprocess_group_options() == {
        "creationflags": manager_module._CREATE_NEW_PROCESS_GROUP
    }
    tree = ServiceManager._signal_process_group(shell_process, manager_module.signal.SIGTERM)
    assert [process.pid for process in tree] == [103, 102, 101]
    assert calls == [("terminate", 103), ("terminate", 102), ("terminate", 101)]

    ServiceManager._signal_process_group(
        shell_process,
        manager_module._SIGKILL,
        process_tree=tree,
    )
    assert calls[-3:] == [("kill", 103), ("kill", 102), ("kill", 101)]
