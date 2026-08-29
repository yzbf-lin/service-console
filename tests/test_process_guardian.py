from __future__ import annotations

import asyncio
import json
import os
import queue
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import psutil
import pytest

from service_console import process_guardian
from service_console.process_guardian import (
    MANAGED_PROCESS_ID_ENV,
    ProcessGuardian,
)


def _wait_until(predicate: object, *, timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():  # type: ignore[operator]
            return
        time.sleep(0.05)
    assert predicate()  # type: ignore[operator]


def _matching_process_is_alive(pid: int, create_time: float) -> bool:
    try:
        process = psutil.Process(pid)
        return (
            abs(process.create_time() - create_time) <= 0.01
            and process.is_running()
            and process.status() != psutil.STATUS_ZOMBIE
        )
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return False


def _start_managed_tree(
    registration_id: str,
    *,
    child_marker: str | None = None,
) -> tuple[subprocess.Popen[str], int, float, int, float, int | None]:
    child_marker_statement = ""
    if child_marker is not None:
        child_marker_statement = f"child_env[{MANAGED_PROCESS_ID_ENV!r}] = {child_marker!r};"
    child_code = (
        "import signal,time;"
        + ("signal.signal(signal.SIGTERM, signal.SIG_IGN);" if os.name != "nt" else "")
        + "time.sleep(60)"
    )
    root_code = (
        "import os,signal,subprocess,sys,time;"
        + ("signal.signal(signal.SIGTERM, signal.SIG_IGN);" if os.name != "nt" else "")
        + "child_env=os.environ.copy();"
        + child_marker_statement
        + "child=subprocess.Popen([sys.executable,'-c',"
        + repr(child_code)
        + "],env=child_env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,"
        + "stderr=subprocess.DEVNULL);"
        + "print(child.pid,flush=True);time.sleep(60)"
    )
    environment = os.environ.copy()
    environment[MANAGED_PROCESS_ID_ENV] = registration_id
    options: dict[str, object] = {
        "env": environment,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.DEVNULL,
        "text": True,
    }
    if os.name == "nt":
        options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
    else:
        options["start_new_session"] = True
    process = subprocess.Popen([sys.executable, "-c", root_code], **options)  # type: ignore[arg-type]
    assert process.stdout is not None
    raw_child_pid = process.stdout.readline().strip()
    if not raw_child_pid:
        process.kill()
        raise AssertionError("managed test process did not report its child PID")
    child_pid = int(raw_child_pid)
    root_create_time = psutil.Process(process.pid).create_time()
    child_create_time = psutil.Process(child_pid).create_time()
    process_group_id = None if os.name == "nt" else os.getpgid(process.pid)
    return process, child_pid, root_create_time, child_pid, child_create_time, process_group_id


def _force_stop_tree(process: subprocess.Popen[str], process_group_id: int | None) -> None:
    if os.name != "nt" and process_group_id is not None:
        try:
            os.killpg(process_group_id, getattr(signal, "SIGKILL", 9))
        except (ProcessLookupError, PermissionError):
            pass
    elif process.poll() is None:
        try:
            root = psutil.Process(process.pid)
            targets = [*root.children(recursive=True), root]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            targets = []
        for target in reversed(targets):
            try:
                target.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
    if process.poll() is None:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def _write_state(
    data_dir: Path,
    *,
    owner_pid: int,
    owner_create_time: float,
    leases: list[dict[str, object]],
) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / process_guardian.STATE_FILENAME
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "owner": {"pid": owner_pid, "create_time": owner_create_time},
                "leases": leases,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    if os.name != "nt":
        path.chmod(0o600)
    return path


def _lease(
    registration_id: str,
    process: subprocess.Popen[str],
    create_time: float,
    process_group_id: int | None,
    *,
    stop_timeout: float = 0.1,
) -> dict[str, object]:
    return {
        "registration_id": registration_id,
        "service": "test-service",
        "pid": process.pid,
        "create_time": create_time,
        "pgid": process_group_id,
        "stop_timeout": stop_timeout,
    }


def test_source_and_frozen_guardian_commands(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delattr(process_guardian.sys, "frozen", raising=False)
    assert process_guardian._guardian_command() == [
        sys.executable,
        "-m",
        "service_console.process_guardian",
    ]

    executable = tmp_path / "Service Console" / "Service Console"
    monkeypatch.setattr(process_guardian.sys, "frozen", True, raising=False)
    monkeypatch.setattr(process_guardian.sys, "executable", str(executable))
    monkeypatch.setattr(process_guardian, "_IS_WINDOWS", False)
    assert process_guardian._guardian_command() == [
        str(executable.resolve().with_name("Service Console Guardian"))
    ]
    monkeypatch.setattr(process_guardian, "_IS_WINDOWS", True)
    assert process_guardian._guardian_command() == [
        str(executable.resolve().with_name("Service Console Guardian.exe"))
    ]


def test_ensure_started_is_thread_safe_and_state_is_private(tmp_path: Path) -> None:
    guardian = ProcessGuardian(tmp_path)
    try:
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _index: guardian.ensure_started(), range(16)))
        assert results == [True] * 16
        state_path = tmp_path / process_guardian.STATE_FILENAME
        payload = json.loads(state_path.read_text(encoding="utf-8"))
        assert payload["version"] == 1
        assert payload["owner"]["pid"] == os.getpid()
        assert payload["leases"] == []
        if os.name != "nt":
            assert stat.S_IMODE(state_path.stat().st_mode) == 0o600
    finally:
        guardian.shutdown()
    assert not state_path.exists()


def test_emergency_disconnect_does_not_wait_for_a_long_guardian_request(tmp_path: Path) -> None:
    guardian = ProcessGuardian(tmp_path)
    request_started = threading.Event()
    request_results: list[dict[str, object] | None] = []

    class FakeStream:
        def __init__(self) -> None:
            self.closed = False

        def close(self) -> None:
            self.closed = True

        def write(self, _payload: bytes) -> None:
            return None

        def flush(self) -> None:
            request_started.set()

    class FakeProcess:
        stdin = FakeStream()
        stdout = FakeStream()

        @staticmethod
        def poll() -> None:
            return None

    guardian._process = FakeProcess()  # type: ignore[assignment]
    guardian._responses = queue.Queue()
    guardian._tracked_timeouts["fixture"] = 300.0

    def run_long_request() -> None:
        with guardian._lock:
            request_results.append(guardian._request_locked({"action": "shutdown"}, timeout=300))

    requester = threading.Thread(target=run_long_request)
    requester.start()
    assert request_started.wait(timeout=2)

    started_at = time.monotonic()
    guardian.emergency_disconnect()
    assert time.monotonic() - started_at < 0.2
    requester.join(timeout=0.5)

    assert not requester.is_alive()
    assert request_results == [None]
    assert FakeProcess.stdin.closed is True


def test_windows_track_fails_if_process_tree_never_stabilizes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeProcess:
        def __init__(self, pid: int) -> None:
            self.pid = pid
            self.killed = False

        def kill(self) -> None:
            self.killed = True

    class FakeJob:
        def __init__(self) -> None:
            self.closed = False

        def assign(self, _processes: object) -> None:
            return None

        def close(self) -> None:
            self.closed = True

    calls = 0
    processes: list[FakeProcess] = []

    def growing_tree(*_args: object, **_kwargs: object) -> tuple[FakeProcess, ...]:
        nonlocal calls
        calls += 1
        processes.append(FakeProcess(10_000 + calls))
        return tuple(processes)

    monkeypatch.setattr(process_guardian, "_IS_WINDOWS", True)
    monkeypatch.setattr(process_guardian, "_windows_process_tree", growing_tree)
    monkeypatch.setattr(process_guardian, "_windows_marker_processes", lambda _lease: ())
    monkeypatch.setattr(process_guardian, "_WindowsJob", FakeJob)
    worker = process_guardian._GuardianWorker(
        tmp_path,
        process_guardian._Owner(os.getpid(), psutil.Process().create_time()),
    )
    lease = process_guardian._Lease(
        registration_id=uuid.uuid4().hex,
        service="growing-tree",
        pid=10_000,
        create_time=time.time(),
        pgid=None,
        stop_timeout=0.1,
    )

    assert worker.track(lease) is False
    assert calls >= 6
    assert all(process.killed for process in processes)


def test_windows_nested_job_assignment_remains_the_primary_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeProcess:
        def __init__(self, pid: int) -> None:
            self.pid = pid

        def kill(self) -> None:
            raise AssertionError("a successful nested Job assignment must not kill the service")

    class FakeJob:
        def __init__(self) -> None:
            self.assignments: list[tuple[int, ...]] = []

        def assign(self, processes: object) -> None:
            self.assignments.append(tuple(process.pid for process in processes))  # type: ignore[union-attr]

        def contains_process_in_any_job(self, _processes: object) -> bool:
            raise AssertionError("host-Job detection only follows a denied assignment")

        def close(self) -> None:
            raise AssertionError("a successfully retained private Job must remain open")

    root = FakeProcess(11_001)
    child = FakeProcess(11_002)
    job = FakeJob()
    monkeypatch.setattr(process_guardian, "_IS_WINDOWS", True)
    monkeypatch.setattr(process_guardian, "_WindowsJob", lambda: job)
    monkeypatch.setattr(
        process_guardian,
        "_windows_process_tree",
        lambda *_args, **_kwargs: (child, root),
    )
    monkeypatch.setattr(
        process_guardian,
        "_windows_marker_processes",
        lambda _lease: (root, child),
    )
    worker = process_guardian._GuardianWorker(
        tmp_path,
        process_guardian._Owner(os.getpid(), psutil.Process().create_time()),
    )
    lease = process_guardian._Lease(
        registration_id=uuid.uuid4().hex,
        service="nested-job",
        pid=root.pid,
        create_time=time.time(),
        pgid=None,
        stop_timeout=0.1,
    )

    assert worker.track(lease) is True
    assert job.assignments[0] == (root.pid, child.pid)
    assert len(job.assignments) >= 2
    assert worker.jobs[lease.registration_id] is job


def test_windows_host_job_uses_verified_marker_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeProcess:
        def __init__(self, pid: int) -> None:
            self.pid = pid

        def kill(self) -> None:
            raise AssertionError("a verified marker fallback must not kill the service")

    class FakeJob:
        closed = False

        def assign(self, processes: object) -> None:
            root_process = next(iter(processes))  # type: ignore[arg-type]
            raise process_guardian._WindowsJobAssignmentError(
                stage="AssignProcessToJobObject",
                pid=root_process.pid,
                winerror=process_guardian._ERROR_ACCESS_DENIED,
                assigned_pids=(),
            )

        def contains_process_in_any_job(self, _processes: object) -> bool:
            return True

        def close(self) -> None:
            self.closed = True

    root = FakeProcess(12_001)
    child = FakeProcess(12_002)
    job = FakeJob()
    monkeypatch.setattr(process_guardian, "_IS_WINDOWS", True)
    monkeypatch.setattr(process_guardian, "_WindowsJob", lambda: job)
    monkeypatch.setattr(
        process_guardian,
        "_windows_process_tree",
        lambda *_args, **_kwargs: (child, root),
    )
    monkeypatch.setattr(
        process_guardian,
        "_windows_marker_processes",
        lambda _lease: (root, child),
    )
    worker = process_guardian._GuardianWorker(
        tmp_path,
        process_guardian._Owner(os.getpid(), psutil.Process().create_time()),
    )
    lease = process_guardian._Lease(
        registration_id=uuid.uuid4().hex,
        service="host-job",
        pid=root.pid,
        create_time=time.time(),
        pgid=None,
        stop_timeout=0.1,
    )

    assert worker.track(lease) is True
    assert job.closed is True
    assert lease.registration_id in worker.leases
    assert lease.registration_id not in worker.jobs


def test_windows_partial_job_assignment_never_uses_marker_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeProcess:
        def __init__(self, pid: int) -> None:
            self.pid = pid
            self.killed = False

        def kill(self) -> None:
            self.killed = True

    class FakeJob:
        closed = False

        def assign(self, processes: object) -> None:
            root_process, child_process = tuple(processes)  # type: ignore[arg-type]
            raise process_guardian._WindowsJobAssignmentError(
                stage="AssignProcessToJobObject",
                pid=child_process.pid,
                winerror=process_guardian._ERROR_ACCESS_DENIED,
                assigned_pids=(root_process.pid,),
            )

        def contains_process_in_any_job(self, _processes: object) -> bool:
            raise AssertionError("partial assignment must fail before host-Job fallback")

        def close(self) -> None:
            self.closed = True

    root = FakeProcess(12_101)
    child = FakeProcess(12_102)
    job = FakeJob()
    monkeypatch.setattr(process_guardian, "_IS_WINDOWS", True)
    monkeypatch.setattr(process_guardian, "_WindowsJob", lambda: job)
    monkeypatch.setattr(
        process_guardian,
        "_windows_process_tree",
        lambda *_args, **_kwargs: (child, root),
    )
    monkeypatch.setattr(
        process_guardian,
        "_windows_marker_processes",
        lambda _lease: (root, child),
    )
    worker = process_guardian._GuardianWorker(
        tmp_path,
        process_guardian._Owner(os.getpid(), psutil.Process().create_time()),
    )
    lease = process_guardian._Lease(
        registration_id=uuid.uuid4().hex,
        service="partial-job",
        pid=root.pid,
        create_time=time.time(),
        pgid=None,
        stop_timeout=0.1,
    )

    assert worker.track(lease) is False
    assert job.closed is True
    assert root.killed is True
    assert child.killed is True
    assert worker.last_track_error is not None
    assert "assigned_pids=[12101]" in worker.last_track_error
    assert lease.registration_id not in worker.leases


def test_windows_host_job_rejects_unverified_marker_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeProcess:
        def __init__(self, pid: int) -> None:
            self.pid = pid
            self.killed = False

        def kill(self) -> None:
            self.killed = True

    class FakeJob:
        closed = False

        def assign(self, processes: object) -> None:
            root_process = next(iter(processes))  # type: ignore[arg-type]
            raise process_guardian._WindowsJobAssignmentError(
                stage="AssignProcessToJobObject",
                pid=root_process.pid,
                winerror=process_guardian._ERROR_ACCESS_DENIED,
                assigned_pids=(),
            )

        def contains_process_in_any_job(self, _processes: object) -> bool:
            return True

        def close(self) -> None:
            self.closed = True

    root = FakeProcess(13_001)
    child = FakeProcess(13_002)
    job = FakeJob()

    def process_tree(
        _lease: object,
        *,
        require_marker: bool,
    ) -> tuple[FakeProcess, ...] | None:
        return None if require_marker else (child, root)

    monkeypatch.setattr(process_guardian, "_IS_WINDOWS", True)
    monkeypatch.setattr(process_guardian, "_WindowsJob", lambda: job)
    monkeypatch.setattr(process_guardian, "_windows_process_tree", process_tree)
    monkeypatch.setattr(
        process_guardian,
        "_windows_marker_processes",
        lambda _lease: (root,),
    )
    worker = process_guardian._GuardianWorker(
        tmp_path,
        process_guardian._Owner(os.getpid(), psutil.Process().create_time()),
    )
    lease = process_guardian._Lease(
        registration_id=uuid.uuid4().hex,
        service="host-job-marker-mismatch",
        pid=root.pid,
        create_time=time.time(),
        pgid=None,
        stop_timeout=0.1,
    )

    assert worker.track(lease) is False
    assert job.closed is True
    assert root.killed is True
    assert child.killed is True
    assert lease.registration_id not in worker.leases


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX shell exec timing is required")
async def test_track_retries_the_create_subprocess_shell_exec_window(tmp_path: Path) -> None:
    guardian = ProcessGuardian(tmp_path)
    assert guardian.ensure_started()
    registration_id = uuid.uuid4().hex
    environment = os.environ.copy()
    environment[MANAGED_PROCESS_ID_ENV] = registration_id
    process = await asyncio.create_subprocess_shell(
        f"{sys.executable} -c 'import time; time.sleep(30)'",
        env=environment,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    create_time = psutil.Process(process.pid).create_time()
    process_group_id = os.getpgid(process.pid)
    try:
        assert guardian.track(
            registration_id,
            "shell-race",
            process.pid,
            create_time,
            process_group_id,
            0.1,
        ), guardian.last_error
        await asyncio.to_thread(guardian.shutdown)
        await asyncio.wait_for(process.wait(), timeout=8)
    finally:
        guardian.emergency_disconnect()
        if process.returncode is None:
            os.killpg(process_group_id, getattr(signal, "SIGKILL", 9))
            await process.wait()


@pytest.mark.parametrize("close_method", ["shutdown", "emergency_disconnect"])
def test_parent_close_stops_tracked_process_tree(tmp_path: Path, close_method: str) -> None:
    registration_id = uuid.uuid4().hex
    process, _, root_created, child_pid, child_created, process_group_id = _start_managed_tree(
        registration_id
    )
    guardian = ProcessGuardian(tmp_path)
    try:
        assert guardian.track(
            registration_id,
            "tree",
            process.pid,
            root_created,
            process_group_id,
            0.1,
        ), guardian.last_error
        payload = json.loads((tmp_path / process_guardian.STATE_FILENAME).read_text(encoding="utf-8"))
        assert payload["leases"][0]["registration_id"] == registration_id

        reaper = threading.Thread(target=process.wait, daemon=True)
        reaper.start()
        getattr(guardian, close_method)()
        reaper.join(timeout=8)
        assert not reaper.is_alive()
        _wait_until(lambda: not _matching_process_is_alive(child_pid, child_created))
        _wait_until(lambda: not (tmp_path / process_guardian.STATE_FILENAME).exists())
    finally:
        guardian.emergency_disconnect()
        _force_stop_tree(process, process_group_id)


@pytest.mark.skipif(os.name == "nt", reason="Windows Popen.terminate does not run Python handlers")
def test_worker_sigterm_stops_tracked_process_tree(tmp_path: Path) -> None:
    registration_id = uuid.uuid4().hex
    process, _, root_created, child_pid, child_created, process_group_id = _start_managed_tree(
        registration_id
    )
    guardian = ProcessGuardian(tmp_path)
    try:
        assert guardian.track(
            registration_id,
            "tree",
            process.pid,
            root_created,
            process_group_id,
            0.1,
        ), guardian.last_error
        worker = guardian._process
        assert worker is not None
        reaper = threading.Thread(target=process.wait, daemon=True)
        reaper.start()
        worker.send_signal(signal.SIGTERM)
        worker.wait(timeout=8)
        reaper.join(timeout=8)
        assert not reaper.is_alive()
        _wait_until(lambda: not _matching_process_is_alive(child_pid, child_created))
        assert not (tmp_path / process_guardian.STATE_FILENAME).exists()
    finally:
        guardian.emergency_disconnect()
        _force_stop_tree(process, process_group_id)


def test_release_removes_lease_after_service_has_stopped(tmp_path: Path) -> None:
    registration_id = uuid.uuid4().hex
    process, _, root_created, child_pid, child_created, process_group_id = _start_managed_tree(
        registration_id
    )
    guardian = ProcessGuardian(tmp_path)
    try:
        assert guardian.track(
            registration_id,
            "release",
            process.pid,
            root_created,
            process_group_id,
            0.1,
        ), guardian.last_error
        # Reproduce a shell that exits while a detached/background descendant in its
        # original process group is still alive. release must reap, not merely forget it.
        process.kill()
        process.wait(timeout=5)
        assert _matching_process_is_alive(child_pid, child_created)
        assert guardian.release(registration_id)
        _wait_until(lambda: not _matching_process_is_alive(child_pid, child_created))
        payload = json.loads((tmp_path / process_guardian.STATE_FILENAME).read_text(encoding="utf-8"))
        assert payload["leases"] == []
    finally:
        guardian.shutdown()
        _force_stop_tree(process, process_group_id)


def test_release_timeout_covers_term_and_kill_phases(tmp_path: Path) -> None:
    registration_id = uuid.uuid4().hex
    process, _, root_created, child_pid, child_created, process_group_id = _start_managed_tree(
        registration_id
    )
    guardian = ProcessGuardian(tmp_path, request_timeout=0.1)
    try:
        assert guardian.track(
            registration_id,
            "slow-release",
            process.pid,
            root_created,
            process_group_id,
            0.3,
        ), guardian.last_error
        reaper = threading.Thread(target=process.wait, daemon=True)
        reaper.start()

        assert guardian.release(registration_id)

        reaper.join(timeout=8)
        assert not reaper.is_alive()
        _wait_until(lambda: not _matching_process_is_alive(child_pid, child_created))
    finally:
        guardian.shutdown()
        _force_stop_tree(process, process_group_id)


def test_live_previous_owner_blocks_takeover_without_cleanup(tmp_path: Path) -> None:
    current = psutil.Process()
    state_path = _write_state(
        tmp_path,
        owner_pid=current.pid,
        owner_create_time=current.create_time(),
        leases=[],
    )
    original = state_path.read_bytes()
    guardian = ProcessGuardian(tmp_path, startup_timeout=2)

    assert guardian.ensure_started() is False
    assert state_path.read_bytes() == original
    guardian.emergency_disconnect()


def test_stale_owner_uses_untrusted_cleanup_before_new_owner_is_published(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    registration_id = uuid.uuid4().hex
    current = psutil.Process()
    state_path = _write_state(
        tmp_path,
        owner_pid=current.pid,
        owner_create_time=current.create_time() - 10_000,
        leases=[
            {
                "registration_id": registration_id,
                "service": "stale",
                "pid": current.pid,
                "create_time": current.create_time(),
                "pgid": None if os.name == "nt" else os.getpgrp(),
                "stop_timeout": 0.1,
            }
        ],
    )
    calls: list[tuple[str, bool]] = []
    if os.name == "nt":
        monkeypatch.setattr(
            process_guardian,
            "_terminate_windows_lease",
            lambda lease, job: calls.append((lease.registration_id, job is not None)) or True,
        )
    else:
        monkeypatch.setattr(
            process_guardian,
            "_terminate_posix_lease",
            lambda lease, *, trusted: calls.append((lease.registration_id, trusted)) or True,
        )
    worker = process_guardian._GuardianWorker(
        tmp_path,
        process_guardian._Owner(current.pid, current.create_time()),
    )
    try:
        worker.initialize()
        assert calls == [(registration_id, False)]
        payload = json.loads(state_path.read_text(encoding="utf-8"))
        assert payload["owner"]["pid"] == os.getpid()
        assert payload["leases"] == []
    finally:
        worker.close()


@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups are required")
def test_stale_posix_matching_marker_terminates_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registration_id = uuid.uuid4().hex
    process_group_id = 45_678
    process_id = 45_679
    lease = process_guardian._Lease(
        registration_id=registration_id,
        service="stale-posix",
        pid=process_id,
        create_time=time.time(),
        pgid=process_group_id,
        stop_timeout=0.1,
    )
    alive = True

    class FakeProcess:
        pid = process_id

        @staticmethod
        def is_running() -> bool:
            return alive

        @staticmethod
        def status() -> str:
            return psutil.STATUS_SLEEPING

        @staticmethod
        def environ() -> dict[str, str]:
            return {MANAGED_PROCESS_ID_ENV: registration_id}

    rows = f"{process_id} {process_group_id} {os.getuid()} S\n"
    completed = subprocess.CompletedProcess([], 0, stdout=rows, stderr="")
    monkeypatch.setattr(process_guardian.subprocess, "run", lambda *_args, **_kwargs: completed)
    monkeypatch.setattr(process_guardian.psutil, "Process", lambda _pid: FakeProcess())
    monkeypatch.setattr(process_guardian.os, "getpgid", lambda _pid: process_group_id)
    monkeypatch.setattr(process_guardian, "_posix_group_exists", lambda _pgid: True)
    signals: list[int] = []

    def signal_group(_pgid: int, selected_signal: int) -> None:
        nonlocal alive
        signals.append(selected_signal)
        if selected_signal == signal.SIGTERM:
            alive = False

    monkeypatch.setattr(process_guardian.os, "killpg", signal_group)

    assert process_guardian._terminate_posix_lease(lease, trusted=False) is True
    assert signals == [signal.SIGTERM]


@pytest.mark.parametrize(
    ("candidate_marker", "should_terminate"),
    [("matching", True), ("different-registration", False)],
)
def test_stale_windows_cleanup_uses_marker_instead_of_reused_pid(
    monkeypatch: pytest.MonkeyPatch,
    candidate_marker: str,
    should_terminate: bool,
) -> None:
    registration_id = "matching"
    lease = process_guardian._Lease(
        registration_id=registration_id,
        service="stale-windows",
        pid=56_789,
        create_time=time.time() - 10_000,
        pgid=None,
        stop_timeout=0.1,
    )
    alive = True
    actions: list[str] = []

    class CurrentProcess:
        @staticmethod
        def username() -> str:
            return "fixture-user"

    class CandidateProcess:
        pid = lease.pid

        @staticmethod
        def username() -> str:
            return "fixture-user"

        @staticmethod
        def is_running() -> bool:
            return alive

        @staticmethod
        def status() -> str:
            return psutil.STATUS_RUNNING

        @staticmethod
        def environ() -> dict[str, str]:
            return {MANAGED_PROCESS_ID_ENV: candidate_marker}

        @staticmethod
        def terminate() -> None:
            nonlocal alive
            actions.append("terminate")
            alive = False

        @staticmethod
        def kill() -> None:
            actions.append("kill")

    candidate = CandidateProcess()
    monkeypatch.setattr(process_guardian.psutil, "Process", lambda: CurrentProcess())
    monkeypatch.setattr(process_guardian.psutil, "process_iter", lambda: iter((candidate,)))

    assert process_guardian._terminate_windows_lease(lease, None) is True
    assert actions == (["terminate"] if should_terminate else [])


@pytest.mark.skipif(os.name == "nt", reason="the live fixture exercises POSIX process-group trust")
def test_live_posix_track_uses_private_pipe_identity_when_marker_is_temporarily_unreadable(
    tmp_path: Path,
) -> None:
    expected_registration = uuid.uuid4().hex
    actual_registration = uuid.uuid4().hex
    process, _, root_created, _, _, process_group_id = _start_managed_tree(actual_registration)
    guardian = ProcessGuardian(tmp_path)
    try:
        assert guardian.track(
            expected_registration,
            "private-pipe",
            process.pid,
            root_created,
            process_group_id,
            0.1,
        ), guardian.last_error
        assert process.poll() is None
        payload = json.loads((tmp_path / process_guardian.STATE_FILENAME).read_text(encoding="utf-8"))
        assert payload["leases"][0]["registration_id"] == expected_registration
    finally:
        guardian.shutdown()
        _force_stop_tree(process, process_group_id)


def test_live_track_rejects_reused_or_mismatched_pid_identity(tmp_path: Path) -> None:
    registration_id = uuid.uuid4().hex
    process, _, root_created, _, _, process_group_id = _start_managed_tree(registration_id)
    guardian = ProcessGuardian(tmp_path)
    try:
        assert not guardian.track(
            registration_id,
            "wrong-identity",
            process.pid,
            root_created - 10_000,
            process_group_id,
            0.1,
        )
        assert process.poll() is None
    finally:
        guardian.shutdown()
        _force_stop_tree(process, process_group_id)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups are required")
def test_stale_posix_marker_mismatch_prevents_group_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registration_id = uuid.uuid4().hex
    process, _, root_created, child_pid, _, process_group_id = _start_managed_tree(
        registration_id,
        child_marker="different-registration",
    )
    try:
        assert process_group_id is not None
        lease = process_guardian._Lease.from_dict(
            _lease(registration_id, process, root_created, process_group_id)
        )
        rows = (
            f"{process.pid} {process_group_id} {os.getuid()} S\n"
            f"{child_pid} {process_group_id} {os.getuid()} S\n"
        )
        completed = subprocess.CompletedProcess([], 0, stdout=rows, stderr="")
        monkeypatch.setattr(process_guardian.subprocess, "run", lambda *_args, **_kwargs: completed)

        assert process_guardian._posix_group_members(lease) is None
        assert process_guardian._terminate_posix_lease(lease, trusted=False) is False
        assert process.poll() is None
    finally:
        _force_stop_tree(process, process_group_id)


@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups are required")
def test_stale_posix_missing_group_is_clean_without_process_enumeration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lease = process_guardian._Lease(
        registration_id=uuid.uuid4().hex,
        service="already-gone",
        pid=999_991,
        create_time=time.time(),
        pgid=999_991,
        stop_timeout=0.1,
    )
    monkeypatch.setattr(process_guardian, "_posix_group_exists", lambda _pgid: False)
    monkeypatch.setattr(
        process_guardian,
        "_posix_group_members",
        lambda _lease: pytest.fail("a vanished group must not require global process enumeration"),
    )

    assert process_guardian._terminate_posix_lease(lease, trusted=False) is True


def test_corrupt_state_fails_closed_and_is_not_replaced(tmp_path: Path) -> None:
    state_path = tmp_path / process_guardian.STATE_FILENAME
    state_path.write_text("not-json\n", encoding="utf-8")
    guardian = ProcessGuardian(tmp_path, startup_timeout=2)

    assert guardian.ensure_started() is False
    assert state_path.read_text(encoding="utf-8") == "not-json\n"
    guardian.emergency_disconnect()
