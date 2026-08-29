from __future__ import annotations

import asyncio
import json
import os
import queue
import shlex
import subprocess
import sys
import threading
import time
from pathlib import Path

import psutil
import pytest

from service_console import manager as manager_module
from service_console.manager import ServiceManager
from service_console.models import ServiceDefinition
from service_console.process_guardian import STATE_FILENAME


def python_command(source: str) -> str:
    argv = [sys.executable, "-u", "-c", source]
    if os.name == "nt":
        return subprocess.list2cmdline(argv)
    return shlex.join(argv)


def matching_process_is_alive(pid: int, create_time: float) -> bool:
    try:
        process = psutil.Process(pid)
        return (
            abs(process.create_time() - create_time) <= 0.01
            and process.is_running()
            and process.status() != psutil.STATUS_ZOMBIE
        )
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return False


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
async def test_initialize_recovers_persisted_guardian_state_without_auto_start(tmp_path: Path) -> None:
    class RecordingGuardian:
        ensure_calls = 0
        shutdown_calls = 0

        def ensure_started(self) -> bool:
            self.ensure_calls += 1
            return True

        def shutdown(self) -> bool:
            self.shutdown_calls += 1
            return True

        def emergency_disconnect(self) -> None:
            return None

    (tmp_path / STATE_FILENAME).write_text("fixture", encoding="utf-8")
    guardian = RecordingGuardian()
    manager = ServiceManager(tmp_path, process_guardian=guardian)  # type: ignore[arg-type]

    await manager.initialize()
    assert guardian.ensure_calls == 1

    await manager.shutdown()
    assert guardian.shutdown_calls == 1


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


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="fixture command uses POSIX background-job syntax")
async def test_shutdown_reaps_background_child_after_launcher_exits(tmp_path: Path) -> None:
    child_pid_file = tmp_path / "background.pid"
    manager = ServiceManager(tmp_path, monitor_interval=0.05)
    await manager.add_service(
        ServiceDefinition(
            name="background",
            command=f"sleep 30 & echo $! > {shlex.quote(str(child_pid_file))}",
            cwd=str(tmp_path),
            stop_timeout=0.25,
        )
    )
    child_pid: int | None = None
    child_create_time: float | None = None
    try:
        await manager.start("background")
        deadline = asyncio.get_running_loop().time() + 5.0
        while child_pid is None:
            if asyncio.get_running_loop().time() >= deadline:
                raise AssertionError("background child did not publish its PID")
            try:
                child_pid = int(child_pid_file.read_text().strip())
            except (FileNotFoundError, ValueError):
                child_pid = None
                await asyncio.sleep(0.02)
        child_create_time = psutil.Process(child_pid).create_time()
        assert matching_process_is_alive(child_pid, child_create_time)

        await manager.shutdown()

        deadline = asyncio.get_running_loop().time() + 5.0
        while (
            matching_process_is_alive(child_pid, child_create_time)
            and asyncio.get_running_loop().time() < deadline
        ):
            await asyncio.sleep(0.02)
        assert not matching_process_is_alive(child_pid, child_create_time)
    finally:
        await manager.shutdown()
        if (
            child_pid is not None
            and child_create_time is not None
            and matching_process_is_alive(child_pid, child_create_time)
        ):
            psutil.Process(child_pid).kill()


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="fixture command uses POSIX background-job syntax")
async def test_rejected_guardian_track_kills_group_after_launcher_exits(tmp_path: Path) -> None:
    child_pid_file = tmp_path / "rejected-background.pid"

    class RejectingGuardian:
        child_pid: int | None = None
        child_create_time: float | None = None

        def ensure_started(self) -> bool:
            return True

        def track(self, **_kwargs: object) -> bool:
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                try:
                    self.child_pid = int(child_pid_file.read_text().strip())
                    self.child_create_time = psutil.Process(self.child_pid).create_time()
                    break
                except (FileNotFoundError, ValueError, psutil.NoSuchProcess):
                    time.sleep(0.02)
            time.sleep(0.2)
            return False

        def shutdown(self) -> bool:
            return True

        def emergency_disconnect(self) -> None:
            return None

    guardian = RejectingGuardian()
    manager = ServiceManager(tmp_path, process_guardian=guardian)  # type: ignore[arg-type]
    await manager.add_service(
        ServiceDefinition(
            name="rejected-background",
            command=f"sleep 30 & echo $! > {shlex.quote(str(child_pid_file))}",
            cwd=str(tmp_path),
            stop_timeout=0.25,
        )
    )

    try:
        with pytest.raises(RuntimeError, match="did not contain"):
            await manager.start("rejected-background")
        assert guardian.child_pid is not None
        assert guardian.child_create_time is not None
        deadline = asyncio.get_running_loop().time() + 3.0
        while (
            matching_process_is_alive(guardian.child_pid, guardian.child_create_time)
            and asyncio.get_running_loop().time() < deadline
        ):
            await asyncio.sleep(0.02)
        assert not matching_process_is_alive(guardian.child_pid, guardian.child_create_time)
    finally:
        await manager.shutdown()
        if (
            guardian.child_pid is not None
            and guardian.child_create_time is not None
            and matching_process_is_alive(guardian.child_pid, guardian.child_create_time)
        ):
            psutil.Process(guardian.child_pid).kill()


def test_controller_crash_reaps_managed_process_tree(tmp_path: Path) -> None:
    fixture = Path(__file__).parent / "fixtures" / "guardian_controller.py"
    controller = subprocess.Popen(
        [sys.executable, "-u", str(fixture), str(tmp_path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert controller.stdout is not None
    output: queue.Queue[str] = queue.Queue()
    reader = threading.Thread(target=lambda: output.put(controller.stdout.readline()), daemon=True)
    reader.start()
    process_ids: set[int] = set()
    process_identities: dict[int, float] = {}
    try:
        payload = json.loads(output.get(timeout=10.0))
        process_ids = {
            int(payload["controller_pid"]),
            int(payload["launcher_pid"]),
            int(payload["workload_pid"]),
        }
        process_identities = {pid: psutil.Process(pid).create_time() for pid in process_ids}
        assert all(matching_process_is_alive(pid, process_identities[pid]) for pid in process_ids)

        controller.kill()
        controller.wait(timeout=5.0)

        deadline = time.monotonic() + 10.0
        managed_ids = process_ids - {controller.pid}
        state_path = tmp_path / "managed-processes.json"
        while (
            any(matching_process_is_alive(pid, process_identities[pid]) for pid in managed_ids)
            or state_path.exists()
        ) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not any(matching_process_is_alive(pid, process_identities[pid]) for pid in managed_ids)
        assert not state_path.exists()
    finally:
        if controller.poll() is None:
            controller.kill()
            controller.wait(timeout=5.0)
        for pid in process_ids - {controller.pid}:
            try:
                if matching_process_is_alive(pid, process_identities[pid]):
                    psutil.Process(pid).kill()
            except psutil.NoSuchProcess:
                pass


@pytest.mark.asyncio
async def test_windows_start_tracks_suspended_root_before_resume(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    events: list[str] = []
    subprocess_options: dict[str, object] = {}

    class RecordingGuardian:
        def ensure_started(self) -> bool:
            events.append("ensure")
            return True

        def track(self, **_kwargs: object) -> bool:
            assert "resume" not in events
            events.append("track")
            return True

    class FakeNativeProcess:
        def create_time(self) -> float:
            return 123.0

        def resume(self) -> None:
            events.append("resume")

    class FakeAsyncProcess:
        pid = 12_345
        returncode = None
        stdout = None
        stderr = None

    async def create_subprocess_shell(
        _command: str,
        **options: object,
    ) -> FakeAsyncProcess:
        subprocess_options.update(options)
        events.append("create")
        return FakeAsyncProcess()

    def discard_task(coroutine: object) -> object:
        coroutine.close()  # type: ignore[union-attr]
        return object()

    monkeypatch.setattr(manager_module, "_IS_WINDOWS", True)
    monkeypatch.setattr(manager_module.asyncio, "create_subprocess_shell", create_subprocess_shell)
    monkeypatch.setattr(manager_module.psutil, "Process", lambda _pid: FakeNativeProcess())
    guardian = RecordingGuardian()
    manager = ServiceManager(tmp_path, process_guardian=guardian)  # type: ignore[arg-type]
    manager._create_task = discard_task  # type: ignore[method-assign]
    manager._prime_resource_counters = lambda _service: None  # type: ignore[method-assign]
    await manager.add_service(ServiceDefinition(name="suspended", command="fixture", cwd=str(tmp_path)))

    snapshot = await manager.start("suspended")

    assert snapshot["state"] == "RUNNING"
    assert events == ["ensure", "create", "track", "resume"]
    assert subprocess_options["creationflags"] == (
        manager_module._CREATE_NEW_PROCESS_GROUP | manager_module._CREATE_SUSPENDED
    )


@pytest.mark.asyncio
async def test_windows_resume_failure_releases_lease_and_kills_suspended_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    events: list[str] = []

    class RecordingGuardian:
        def ensure_started(self) -> bool:
            return True

        def track(self, **_kwargs: object) -> bool:
            events.append("track")
            return True

        def release(self, _registration_id: str) -> bool:
            events.append("release")
            return True

    class FakeNativeProcess:
        pid = 23_456
        alive = True

        def create_time(self) -> float:
            return 456.0

        def resume(self) -> None:
            events.append("resume")
            raise psutil.AccessDenied(pid=FakeAsyncProcess.pid)

        def children(self, *, recursive: bool) -> list[FakeNativeProcess]:
            assert recursive is True
            return []

        def kill(self) -> None:
            events.append("kill")
            self.alive = False

        def is_running(self) -> bool:
            return self.alive

    class FakeAsyncProcess:
        pid = 23_456
        returncode: int | None = None
        stdout = None
        stderr = None

        async def wait(self) -> int:
            self.returncode = -1
            return self.returncode

    native_process = FakeNativeProcess()

    async def create_subprocess_shell(
        _command: str,
        **_options: object,
    ) -> FakeAsyncProcess:
        return FakeAsyncProcess()

    monkeypatch.setattr(manager_module, "_IS_WINDOWS", True)
    monkeypatch.setattr(manager_module.asyncio, "create_subprocess_shell", create_subprocess_shell)
    monkeypatch.setattr(manager_module.psutil, "Process", lambda _pid: native_process)
    guardian = RecordingGuardian()
    manager = ServiceManager(tmp_path, process_guardian=guardian)  # type: ignore[arg-type]
    await manager.add_service(ServiceDefinition(name="resume-failure", command="fixture", cwd=str(tmp_path)))

    with pytest.raises(RuntimeError, match="failed to resume suspended process"):
        await manager.start("resume-failure")

    assert events == ["track", "resume", "release", "kill"]
    snapshot = await manager.get_service("resume-failure")
    assert snapshot["state"] == "FAILED"
    assert "failed to resume suspended process" in str(snapshot["last_error"])


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
        "creationflags": (manager_module._CREATE_NEW_PROCESS_GROUP | manager_module._CREATE_SUSPENDED)
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
