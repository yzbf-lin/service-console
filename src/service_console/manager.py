"""Async native-process supervisor."""

from __future__ import annotations

import asyncio
import os
import secrets
import signal
import subprocess
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psutil

from .models import LogEntry, ServiceDefinition, ServiceRuntime, ServiceState, utc_now
from .process_guardian import MANAGED_PROCESS_ID_ENV, STATE_FILENAME, ProcessGuardian
from .store import DefinitionStore

_IS_WINDOWS = os.name == "nt"
_CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
_CREATE_SUSPENDED = getattr(subprocess, "CREATE_SUSPENDED", 0x00000004)
_SIGKILL = getattr(signal, "SIGKILL", 9)


def _subprocess_group_options() -> dict[str, object]:
    if _IS_WINDOWS:
        return {"creationflags": _CREATE_NEW_PROCESS_GROUP | _CREATE_SUSPENDED}
    return {"start_new_session": True}


@dataclass(slots=True)
class _ManagedService:
    definition: ServiceDefinition
    runtime: ServiceRuntime = field(default_factory=ServiceRuntime)
    process: asyncio.subprocess.Process | None = None
    logs: deque[LogEntry] = field(default_factory=deque)
    lifecycle_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    generation: int = 0
    successful_starts: int = 0
    started_monotonic: float | None = None
    resource_processes: dict[int, psutil.Process] = field(default_factory=dict)
    guardian_registration_id: str | None = None


class ServiceManager:
    """Own service definitions, native child processes, logs, and status events."""

    def __init__(
        self,
        data_dir: str | Path,
        *,
        log_buffer_size: int = 1_000,
        event_queue_size: int = 1_024,
        monitor_interval: float = 1.0,
        base_environment: Mapping[str, str] | None = None,
        process_guardian: ProcessGuardian | None = None,
    ) -> None:
        if log_buffer_size <= 0:
            raise ValueError("log_buffer_size must be greater than zero")
        if event_queue_size <= 0:
            raise ValueError("event_queue_size must be greater than zero")
        if monitor_interval <= 0:
            raise ValueError("monitor_interval must be greater than zero")

        self.store = DefinitionStore(data_dir)
        self.log_buffer_size = log_buffer_size
        self.event_queue_size = event_queue_size
        self.monitor_interval = monitor_interval
        self._base_environment = (
            os.environ.copy()
            if base_environment is None
            else {str(key): str(value) for key, value in base_environment.items()}
        )
        self._process_guardian = process_guardian or ProcessGuardian(self.store.data_dir)
        self._services: dict[str, _ManagedService] = {}
        self._definitions_lock = asyncio.Lock()
        self._initialize_lock = asyncio.Lock()
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._initialized = False
        self._shutting_down = False
        self._shutdown_succeeded: bool | None = None

    @property
    def shutdown_succeeded(self) -> bool | None:
        """Whether the guardian confirmed that all managed leases were cleaned."""

        return self._shutdown_succeeded

    async def initialize(self) -> None:
        """Load persisted definitions and start definitions marked auto_start."""

        async with self._initialize_lock:
            if self._initialized:
                return
            definitions = self.store.load()
            for definition in definitions.values():
                logs = deque(
                    self.store.load_logs(definition.name, self.log_buffer_size),
                    maxlen=self.log_buffer_size,
                )
                self._services[definition.name] = _ManagedService(definition=definition, logs=logs)

            auto_start_names = [
                definition.name for definition in definitions.values() if definition.auto_start
            ]
            guardian_state_exists = (self.store.data_dir / STATE_FILENAME).exists()
            if guardian_state_exists or auto_start_names:
                guardian_ready = await asyncio.to_thread(self._process_guardian.ensure_started)
                if not guardian_ready:
                    self._services.clear()
                    raise RuntimeError("process guardian could not recover managed process state")

            self._initialized = True
            if auto_start_names:
                await asyncio.gather(*(self.start(name) for name in auto_start_names), return_exceptions=True)

    async def shutdown(self) -> None:
        """Stop every child and drain the controller's background tasks."""

        self._shutting_down = True
        try:
            if self._initialized:
                names = list(self._services)
                await asyncio.gather(*(self.stop(name) for name in names), return_exceptions=True)

                current = asyncio.current_task()
                pending = [task for task in self._tasks if task is not current and not task.done()]
                if pending:
                    done, still_pending = await asyncio.wait(pending, timeout=2.0)
                    del done
                    for task in still_pending:
                        task.cancel()
                    if still_pending:
                        await asyncio.gather(*still_pending, return_exceptions=True)
        finally:
            # The external guardian is the final containment boundary. Closing it releases
            # every remaining lease even when an individual stop operation failed.
            try:
                guardian_cleaned = await asyncio.to_thread(self._process_guardian.shutdown)
            except BaseException:
                self._shutdown_succeeded = False
                raise
            self._shutdown_succeeded = guardian_cleaned
            if not guardian_cleaned:
                raise RuntimeError("process guardian could not confirm managed process cleanup")

    def emergency_shutdown(self) -> None:
        """Disconnect the guardian so it can reap children after a stuck controller exit."""

        self._shutting_down = True
        self._shutdown_succeeded = False
        self._process_guardian.emergency_disconnect()

    async def add_service(self, definition: ServiceDefinition) -> dict[str, Any]:
        await self._ensure_initialized()
        async with self._definitions_lock:
            if definition.name in self._services:
                raise ValueError(f"service already exists: {definition.name}")
            definitions = {name: service.definition for name, service in self._services.items()}
            definitions[definition.name] = definition
            self.store.save(definitions)
            service = _ManagedService(
                definition=definition,
                logs=deque(maxlen=self.log_buffer_size),
            )
            self._services[definition.name] = service
        snapshot = self._snapshot(service)
        self._emit_status(service)
        return snapshot

    async def update_service(self, name: str, definition: ServiceDefinition) -> dict[str, Any]:
        await self._ensure_initialized()
        if definition.name != name:
            raise ValueError("renaming a service is not supported")
        service = self._require_service(name)
        async with service.lifecycle_lock:
            self._ensure_current(name, service)
            async with self._definitions_lock:
                definitions = {key: item.definition for key, item in self._services.items()}
                definitions[name] = definition
                self.store.save(definitions)
                service.definition = definition
            snapshot = self._snapshot(service)
            self._emit_status(service)
            return snapshot

    async def delete_service(self, name: str) -> None:
        await self._ensure_initialized()
        service = self._require_service(name)
        async with service.lifecycle_lock:
            self._ensure_current(name, service)
            await self._stop_locked(service)
            async with self._definitions_lock:
                self._ensure_current(name, service)
                definitions = {
                    key: item.definition for key, item in self._services.items() if key != name
                }
                self.store.save(definitions)
                del self._services[name]
                self.store.delete_logs(name)

    async def start(self, name: str) -> dict[str, Any]:
        await self._ensure_initialized()
        service = self._require_service(name)
        async with service.lifecycle_lock:
            self._ensure_current(name, service)
            return await self._start_locked(service)

    async def stop(self, name: str) -> dict[str, Any]:
        await self._ensure_initialized()
        service = self._require_service(name)
        async with service.lifecycle_lock:
            self._ensure_current(name, service)
            return await self._stop_locked(service)

    async def restart(self, name: str) -> dict[str, Any]:
        await self._ensure_initialized()
        service = self._require_service(name)
        async with service.lifecycle_lock:
            self._ensure_current(name, service)
            await self._stop_locked(service)
            self._ensure_current(name, service)
            return await self._start_locked(service)

    async def list_services(self) -> list[dict[str, Any]]:
        await self._ensure_initialized()
        services = list(self._services.values())
        for service in services:
            self._sample_resources(service)
        return [self._snapshot(service) for service in sorted(services, key=lambda item: item.definition.name)]

    async def get_service(self, name: str) -> dict[str, Any]:
        await self._ensure_initialized()
        service = self._require_service(name)
        self._sample_resources(service)
        return self._snapshot(service)

    async def get_logs(self, name: str, tail: int = 500) -> list[dict[str, str]]:
        await self._ensure_initialized()
        if tail < 0:
            raise ValueError("tail must be greater than or equal to zero")
        service = self._require_service(name)
        if tail == 0:
            return []
        if tail > self.log_buffer_size:
            return [entry.to_dict() for entry in self.store.load_logs(name, tail)]
        return [entry.to_dict() for entry in list(service.logs)[-tail:]]

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self.event_queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    async def _ensure_initialized(self) -> None:
        if not self._initialized:
            await self.initialize()

    def _require_service(self, name: str) -> _ManagedService:
        try:
            return self._services[name]
        except KeyError:
            raise KeyError(f"service not found: {name}") from None

    def _ensure_current(self, name: str, service: _ManagedService) -> None:
        if self._services.get(name) is not service:
            raise KeyError(f"service not found: {name}")

    async def _start_locked(self, service: _ManagedService) -> dict[str, Any]:
        process = service.process
        if process is not None and process.returncode is None:
            return self._snapshot(service)
        if self._shutting_down:
            raise RuntimeError("service manager is shutting down")
        if service.guardian_registration_id is not None:
            await self._release_guardian(service)

        service.generation += 1
        generation = service.generation
        service.runtime.state = ServiceState.STARTING
        service.runtime.pid = None
        service.runtime.exit_code = None
        service.runtime.started_at = None
        service.runtime.stopped_at = None
        service.runtime.cpu_percent = 0.0
        service.runtime.memory_rss = 0
        service.runtime.last_error = None
        service.resource_processes.clear()
        self._emit_status(service)

        definition = service.definition
        registration_id = secrets.token_urlsafe(18)
        environment = dict(self._base_environment)
        environment.update(definition.env)
        environment[MANAGED_PROCESS_ID_ENV] = registration_id
        process = None
        tracked = False
        try:
            guardian_ready = await asyncio.to_thread(self._process_guardian.ensure_started)
            if not guardian_ready:
                raise RuntimeError("process guardian did not become ready")
            process = await asyncio.create_subprocess_shell(
                definition.command,
                cwd=definition.cwd,
                env=environment,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=1024 * 1024,
                **_subprocess_group_options(),
            )
            root_process: psutil.Process | None = None
            try:
                root_process = psutil.Process(process.pid)
                create_time = root_process.create_time()
            except (psutil.Error, OSError):
                create_time = time.time()
            tracked = await asyncio.to_thread(
                self._process_guardian.track,
                registration_id=registration_id,
                service=definition.name,
                pid=process.pid,
                create_time=create_time,
                process_group_id=None if _IS_WINDOWS else process.pid,
                stop_timeout=definition.stop_timeout,
            )
            if not tracked:
                detail = getattr(self._process_guardian, "last_error", None)
                suffix = f": {detail}" if isinstance(detail, str) and detail else ""
                raise RuntimeError(f"process guardian did not contain the launched process{suffix}")
            if _IS_WINDOWS:
                if root_process is None:
                    raise RuntimeError("suspended process identity was unavailable for resume")
                try:
                    root_process.resume()
                except (psutil.Error, OSError) as exc:
                    raise RuntimeError(f"failed to resume suspended process {process.pid}: {exc}") from exc
        except Exception as exc:
            guardian_cleanup_error: str | None = None
            if tracked:
                try:
                    released = await asyncio.to_thread(
                        self._process_guardian.release,
                        registration_id,
                    )
                    if released:
                        tracked = False
                    else:
                        guardian_cleanup_error = "process guardian did not release the failed start"
                except Exception as cleanup_exc:  # noqa: BLE001 - best-effort failure cleanup
                    guardian_cleanup_error = f"process guardian release failed: {cleanup_exc}"
            if process is not None:
                process_tree = self._signal_process_group(process, _SIGKILL)
                await self._wait_for_process_group(
                    process,
                    timeout=max(1.0, min(5.0, definition.stop_timeout)),
                    process_tree=process_tree,
                )
                if process.returncode is None:
                    await asyncio.shield(process.wait())
            error_message = str(exc)
            if guardian_cleanup_error is not None:
                error_message = f"{error_message}; {guardian_cleanup_error}"
            service.runtime.state = ServiceState.FAILED
            service.runtime.last_error = error_message
            service.runtime.stopped_at = utc_now()
            self._emit_status(service)
            self._record_log(service, "stderr", f"failed to start: {error_message}")
            raise RuntimeError(f"failed to start service {definition.name}: {error_message}") from exc

        service.process = process
        service.guardian_registration_id = registration_id if tracked else None
        service.runtime.state = ServiceState.RUNNING
        service.runtime.pid = process.pid
        service.runtime.started_at = utc_now()
        service.runtime.restart_count = service.successful_starts
        service.successful_starts += 1
        service.started_monotonic = time.monotonic()
        self._prime_resource_counters(service)

        stdout_task = self._create_task(self._read_stream(service, process.stdout, "stdout"))
        stderr_task = self._create_task(self._read_stream(service, process.stderr, "stderr"))
        monitor_task = self._create_task(self._monitor_resources(service, process, generation))
        self._create_task(
            self._watch_process(
                service,
                process,
                generation,
                service.guardian_registration_id,
                (stdout_task, stderr_task),
                monitor_task,
            )
        )
        self._emit_status(service)
        return self._snapshot(service)

    async def _stop_locked(self, service: _ManagedService) -> dict[str, Any]:
        process = service.process
        if (process is None or process.returncode is not None) and service.guardian_registration_id is None:
            return self._snapshot(service)

        service.runtime.state = ServiceState.STOPPING
        self._emit_status(service)
        process_tree: tuple[psutil.Process, ...] = ()
        try:
            if process is not None and process.returncode is None:
                process_tree = self._signal_process_group(process, signal.SIGTERM)
                group_exited = await self._wait_for_process_group(
                    process,
                    timeout=service.definition.stop_timeout,
                    process_tree=process_tree,
                )
                if not group_exited:
                    process_tree = self._signal_process_group(
                        process,
                        _SIGKILL,
                        process_tree=process_tree,
                    )
                    await asyncio.shield(process.wait())
                    if _IS_WINDOWS:
                        await self._wait_for_process_group(
                            process,
                            timeout=max(1.0, service.definition.stop_timeout),
                            process_tree=process_tree,
                        )
            await self._release_guardian(service)
            if process is not None and process.returncode is None:
                await asyncio.shield(process.wait())
        except asyncio.CancelledError:
            if process is not None and process.returncode is None:
                process_tree = self._signal_process_group(
                    process,
                    _SIGKILL,
                    process_tree=process_tree,
                )
                await asyncio.shield(process.wait())
                if _IS_WINDOWS:
                    await asyncio.shield(
                        self._wait_for_process_group(
                            process,
                            timeout=max(1.0, service.definition.stop_timeout),
                            process_tree=process_tree,
                        )
                    )
            await asyncio.shield(self._release_guardian(service))
            raise
        except Exception as exc:
            service.runtime.last_error = str(exc)
            service.runtime.state = ServiceState.FAILED
            self._emit_status(service)
            raise
        finally:
            if (
                (process is None or process.returncode is not None)
                and service.process is process
                and service.guardian_registration_id is None
            ):
                service.process = None
                service.started_monotonic = None
                service.resource_processes.clear()
                service.runtime.state = ServiceState.STOPPED
                service.runtime.pid = None
                service.runtime.exit_code = process.returncode if process is not None else None
                service.runtime.stopped_at = utc_now()
                service.runtime.cpu_percent = 0.0
                service.runtime.memory_rss = 0
                self._emit_status(service)
        return self._snapshot(service)

    async def _read_stream(
        self,
        service: _ManagedService,
        stream: asyncio.StreamReader | None,
        stream_name: str,
    ) -> None:
        if stream is None:
            return
        try:
            while True:
                raw_line = await stream.readline()
                if not raw_line:
                    return
                message = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                self._record_log(service, stream_name, message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._record_log(service, "stderr", f"log reader failed for {stream_name}: {exc}")

    async def _watch_process(
        self,
        service: _ManagedService,
        process: asyncio.subprocess.Process,
        generation: int,
        guardian_registration_id: str | None,
        readers: tuple[asyncio.Task[Any], asyncio.Task[Any]],
        monitor_task: asyncio.Task[Any],
    ) -> None:
        return_code = await process.wait()
        await asyncio.gather(*readers, return_exceptions=True)
        monitor_task.cancel()
        await asyncio.gather(monitor_task, return_exceptions=True)

        guardian_error: Exception | None = None
        if guardian_registration_id is not None:
            try:
                released = await asyncio.to_thread(
                    self._process_guardian.release,
                    guardian_registration_id,
                )
                if not released:
                    raise RuntimeError("process guardian did not release the managed process")
            except Exception as exc:  # final shutdown retries by closing the guardian pipe
                guardian_error = exc

        async with service.lifecycle_lock:
            if service.process is not process or service.generation != generation:
                return
            if service.guardian_registration_id == guardian_registration_id and guardian_error is None:
                service.guardian_registration_id = None
            was_stopping = service.runtime.state is ServiceState.STOPPING
            service.process = None
            service.started_monotonic = None
            service.resource_processes.clear()
            service.runtime.pid = None
            service.runtime.exit_code = return_code
            service.runtime.stopped_at = utc_now()
            service.runtime.cpu_percent = 0.0
            service.runtime.memory_rss = 0
            if guardian_error is not None:
                service.runtime.state = ServiceState.FAILED
                service.runtime.last_error = f"process guardian cleanup failed: {guardian_error}"
            elif was_stopping:
                service.runtime.state = ServiceState.STOPPED
            elif return_code == 0:
                service.runtime.state = ServiceState.EXITED
            else:
                service.runtime.state = ServiceState.FAILED
            self._emit_status(service)

    async def _release_guardian(self, service: _ManagedService) -> None:
        registration_id = service.guardian_registration_id
        if registration_id is None:
            return
        released = await asyncio.to_thread(self._process_guardian.release, registration_id)
        if not released:
            raise RuntimeError("process guardian did not release the managed process")
        if service.guardian_registration_id == registration_id:
            service.guardian_registration_id = None

    async def _monitor_resources(
        self,
        service: _ManagedService,
        process: asyncio.subprocess.Process,
        generation: int,
    ) -> None:
        while True:
            await asyncio.sleep(self.monitor_interval)
            if service.process is not process or service.generation != generation or process.returncode is not None:
                return
            self._sample_resources(service)
            self._emit_status(service)

    def _prime_resource_counters(self, service: _ManagedService) -> None:
        self._sample_resources(service)

    def _sample_resources(self, service: _ManagedService) -> None:
        pid = service.runtime.pid
        if pid is None or service.runtime.state not in {
            ServiceState.RUNNING,
            ServiceState.STOPPING,
        }:
            return
        try:
            root = service.resource_processes.get(pid)
            if root is None:
                root = psutil.Process(pid)
                service.resource_processes[pid] = root
            try:
                children = root.children(recursive=True)
            except (psutil.Error, OSError):
                # Sandboxed macOS processes may inspect a known PID but may not
                # enumerate the global PID table required by children().
                children = []
            processes = [root, *children]
            live_pids = {process.pid for process in processes}
            cpu_percent = 0.0
            memory_rss = 0
            for process in processes:
                cached = service.resource_processes.get(process.pid)
                if cached is None:
                    cached = process
                    service.resource_processes[process.pid] = cached
                try:
                    cpu_percent += cached.cpu_percent(interval=None)
                    memory_rss += cached.memory_info().rss
                except (psutil.Error, OSError):
                    continue
            service.resource_processes = {
                process_pid: process
                for process_pid, process in service.resource_processes.items()
                if process_pid in live_pids
            }
            service.runtime.cpu_percent = round(cpu_percent, 2)
            service.runtime.memory_rss = memory_rss
        except (psutil.Error, OSError):
            service.runtime.cpu_percent = 0.0
            service.runtime.memory_rss = 0

    def _record_log(self, service: _ManagedService, stream: str, message: str) -> None:
        entry = LogEntry.create(stream=stream, message=message)
        service.logs.append(entry)
        self.store.append_log(service.definition.name, entry)
        self._emit(
            {
                "type": "log",
                "service": service.definition.name,
                "data": entry.to_dict(),
            }
        )

    def _emit_status(self, service: _ManagedService) -> None:
        self._emit(
            {
                "type": "status",
                "service": service.definition.name,
                "data": self._snapshot(service),
            }
        )

    def _emit(self, event: dict[str, Any]) -> None:
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    @staticmethod
    def _snapshot(service: _ManagedService) -> dict[str, Any]:
        uptime_seconds = 0.0
        if service.started_monotonic is not None and service.runtime.state in {
            ServiceState.RUNNING,
            ServiceState.STOPPING,
        }:
            uptime_seconds = round(max(0.0, time.monotonic() - service.started_monotonic), 3)
        return service.runtime.to_dict(service.definition, uptime_seconds=uptime_seconds)

    @staticmethod
    def _signal_process_group(
        process: asyncio.subprocess.Process,
        sig: signal.Signals | int,
        *,
        process_tree: tuple[psutil.Process, ...] = (),
    ) -> tuple[psutil.Process, ...]:
        if _IS_WINDOWS:
            current_tree = ServiceManager._windows_process_tree(process.pid)
            targets = ServiceManager._merge_process_trees(process_tree, current_tree)
            if not targets:
                try:
                    if sig == _SIGKILL:
                        process.kill()
                    else:
                        process.terminate()
                except ProcessLookupError:
                    pass
                return targets
            for target in targets:
                try:
                    if sig == _SIGKILL:
                        target.kill()
                    else:
                        target.terminate()
                except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                    continue
            return targets
        try:
            os.killpg(process.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        return ()

    @staticmethod
    def _windows_process_tree(pid: int) -> tuple[psutil.Process, ...]:
        try:
            root = psutil.Process(pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            return ()
        try:
            descendants = root.children(recursive=True)
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            descendants = []
        descendants.reverse()
        return (*descendants, root)

    @staticmethod
    def _merge_process_trees(
        existing: tuple[psutil.Process, ...],
        current: tuple[psutil.Process, ...],
    ) -> tuple[psutil.Process, ...]:
        processes: dict[int, psutil.Process] = {}
        for process in (*existing, *current):
            processes.setdefault(process.pid, process)
        return tuple(processes.values())

    @staticmethod
    def _windows_process_tree_exists(process_tree: tuple[psutil.Process, ...]) -> bool:
        for process in process_tree:
            try:
                if process.is_running():
                    return True
            except psutil.NoSuchProcess:
                continue
            except (psutil.AccessDenied, OSError):
                return True
        return False

    @staticmethod
    def _process_group_exists(process_group_id: int) -> bool:
        try:
            os.killpg(process_group_id, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    async def _wait_for_process_group(
        self,
        process: asyncio.subprocess.Process,
        *,
        timeout: float,
        process_tree: tuple[psutil.Process, ...] = (),
    ) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while (
            self._windows_process_tree_exists(process_tree)
            if _IS_WINDOWS
            else self._process_group_exists(process.pid)
        ):
            remaining = deadline - loop.time()
            if remaining <= 0:
                return False
            if process.returncode is None:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(process.wait()),
                        timeout=min(0.05, remaining),
                    )
                except TimeoutError:
                    pass
            else:
                await asyncio.sleep(min(0.05, remaining))
        if process.returncode is None:
            await asyncio.shield(process.wait())
        return True

    def _create_task(self, coroutine: Any) -> asyncio.Task[Any]:
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task
