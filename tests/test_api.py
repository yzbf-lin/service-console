from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from service_console.api import create_app
from service_console.models import ServiceDefinition


class FakeManager:
    def __init__(self) -> None:
        self.initialized = False
        self.shutdown_called = False
        self.services: dict[str, dict[str, Any]] = {}
        self.logs: dict[str, list[dict[str, str]]] = {}
        self.subscribers: set[asyncio.Queue[dict[str, Any]]] = set()

    async def initialize(self) -> None:
        self.initialized = True

    async def shutdown(self) -> None:
        self.shutdown_called = True

    async def add_service(self, definition: ServiceDefinition) -> dict[str, Any]:
        if definition.name in self.services:
            raise ValueError("service already exists")
        service = {**definition.to_dict(), "state": "STOPPED", "pid": None}
        self.services[definition.name] = service
        return service

    async def update_service(self, name: str, definition: ServiceDefinition) -> dict[str, Any]:
        self._require(name)
        service = {**definition.to_dict(), "state": "STOPPED", "pid": None}
        self.services[name] = service
        return service

    async def delete_service(self, name: str) -> None:
        self._require(name)
        del self.services[name]

    async def start(self, name: str) -> dict[str, Any]:
        service = self._require(name)
        service.update(state="RUNNING", pid=123)
        return service

    async def stop(self, name: str) -> dict[str, Any]:
        service = self._require(name)
        service.update(state="STOPPED", pid=None)
        return service

    async def restart(self, name: str) -> dict[str, Any]:
        return await self.start(name)

    async def list_services(self) -> list[dict[str, Any]]:
        return list(self.services.values())

    async def get_logs(self, name: str, tail: int = 500) -> list[dict[str, str]]:
        self._require(name)
        return self.logs.get(name, [])[-tail:] if tail else []

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self.subscribers.discard(queue)

    def _require(self, name: str) -> dict[str, Any]:
        try:
            return self.services[name]
        except KeyError:
            raise KeyError(f"service not found: {name}") from None


class FakePortInspector:
    def __init__(self) -> None:
        self.list_calls: list[int | None] = []
        self.terminate_calls: list[tuple[int, int | None, bool, float]] = []
        self.list_error: Exception | None = None
        self.terminate_error: Exception | None = None

    def list_ports(self, port: int | None = None) -> list[dict[str, object]]:
        self.list_calls.append(port)
        if self.list_error is not None:
            raise self.list_error
        return [
            {
                "protocol": "tcp",
                "local_address": "127.0.0.1",
                "port": 8123,
                "pid": 321,
                "process_name": "python",
                "command": "python app.py",
                "username": "tester",
            }
        ]

    def terminate(
        self,
        pid: int,
        expected_port: int | None = None,
        force: bool = False,
        timeout: float = 3.0,
    ) -> dict[str, object]:
        self.terminate_calls.append((pid, expected_port, force, timeout))
        if self.terminate_error is not None:
            raise self.terminate_error
        return {
            "pid": pid,
            "expected_port": expected_port,
            "action": "kill" if force else "terminate",
            "terminated": True,
            "force": force,
            "exit_code": -9 if force else -15,
        }


class FakeProcessInspector:
    def __init__(self) -> None:
        self.list_calls: list[tuple[str | None, int, dict[int, str]]] = []
        self.get_calls: list[tuple[int, dict[int, str]]] = []
        self.list_error: Exception | None = None
        self.get_error: Exception | None = None

    @staticmethod
    def process(pid: int = 321) -> dict[str, object]:
        return {
            "pid": pid,
            "ppid": 100,
            "create_time": 123.5,
            "started_at": "1970-01-01T00:02:03.500000+00:00",
            "process_name": "uv",
            "command": "uv run backend/run.py",
            "cwd": "/workspace/project",
            "username": "tester",
            "ports": [8000],
            "suggested_name": "project-backend",
            "safe_env": {"PYTHONUNBUFFERED": "1"},
            "restorable": True,
            "warnings": [],
            "managed_service": None,
        }

    def list_processes(
        self,
        query: str | None = None,
        limit: int = 100,
        managed_processes: dict[int, str] | None = None,
    ) -> list[dict[str, object]]:
        self.list_calls.append((query, limit, dict(managed_processes or {})))
        if self.list_error is not None:
            raise self.list_error
        return [self.process()]

    def get_process(
        self,
        pid: int,
        managed_processes: dict[int, str] | None = None,
    ) -> dict[str, object]:
        self.get_calls.append((pid, dict(managed_processes or {})))
        if self.get_error is not None:
            raise self.get_error
        return self.process(pid)


class FakeUpdateManager:
    def __init__(self) -> None:
        self.calls: list[str] = []

    @staticmethod
    def snapshot(state: str, *, restart_required: bool = False) -> dict[str, object]:
        return {
            "state": state,
            "current_version": "0.1.0",
            "latest_version": "0.2.0" if state != "idle" else None,
            "release_url": "https://github.com/yzbf-lin/service-console/releases/tag/v0.2.0",
            "published_at": None,
            "notes": None,
            "platform": "darwin-arm64",
            "platform_supported": True,
            "can_install": True,
            "reason": None,
            "error": None,
            "downloaded_bytes": 0,
            "total_bytes": None,
            "download_progress": None,
            "restart_required": restart_required,
        }

    def status(self) -> dict[str, object]:
        self.calls.append("status")
        return self.snapshot("idle")

    def check(self) -> dict[str, object]:
        self.calls.append("check")
        return self.snapshot("available")

    def download(self) -> dict[str, object]:
        self.calls.append("download")
        return self.snapshot("downloaded")

    def install(self) -> dict[str, object]:
        self.calls.append("install")
        return self.snapshot("restarting", restart_required=True)


class FakeMcpIntegration:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def snapshot(self, state: str) -> dict[str, object]:
        return {
            "state": state,
            "transport": "stdio",
            "controller_ready": True,
            "bridge_available": True,
            "codex_cli_available": True,
            "codex_registered": state == "installed",
            "server_name": "service-console",
            "bridge_command": "/Applications/Service Console.app/Contents/MacOS/Service Console MCP",
            "bridge_args": ["--runtime-file", "/tmp/controller.json"],
            "config_snippet": "codex mcp add service-console -- 'Service Console MCP'",
            "tools": ["service_list", "service_restart", "service_logs"],
            "last_test": (
                {"ok": True, "tested_at": "2026-08-28T00:00:00+00:00", "error": None}
                if state == "installed"
                else None
            ),
            "error": None,
        }

    def status(self) -> dict[str, object]:
        self.calls.append("status")
        return self.snapshot("not_installed")

    def install(self) -> dict[str, object]:
        self.calls.append("install")
        return self.snapshot("installed")

    def test(self) -> dict[str, object]:
        self.calls.append("test")
        return self.snapshot("installed")

    def remove(self) -> dict[str, object]:
        self.calls.append("remove")
        return self.snapshot("not_installed")


def test_authenticated_service_lifecycle() -> None:
    manager = FakeManager()
    app = create_app(token="secret", manager=manager)
    headers = {"Authorization": "Bearer secret"}

    with TestClient(app) as client:
        assert manager.initialized
        assert client.get("/api/health").status_code == 401
        assert client.get("/api/health", headers=headers).json() == {"status": "ok"}

        created = client.post(
            "/api/services",
            headers=headers,
            json={"name": "api", "command": "python app.py", "cwd": "/tmp"},
        )
        assert created.status_code == 201
        assert created.json()["service"]["state"] == "STOPPED"
        assert client.get("/api/services", headers=headers).json()["services"][0]["name"] == "api"

        started = client.post("/api/services/api/start", headers=headers)
        assert started.json()["service"]["state"] == "RUNNING"

        manager.logs["api"] = [
            {"timestamp": "now", "stream": "stdout", "message": "ready"},
        ]
        assert client.get("/api/services/api/logs?tail=1", headers=headers).json()["logs"][0][
            "message"
        ] == "ready"

        assert client.delete("/api/services/api", headers=headers).json() == {"deleted": "api"}
        assert client.post("/api/services/api/start", headers=headers).status_code == 404

    assert manager.shutdown_called


def test_manager_shutdown_runs_even_when_jenkins_shutdown_fails() -> None:
    manager = FakeManager()

    class FailingJenkins:
        async def initialize(self) -> None:
            return None

        async def shutdown(self) -> None:
            raise RuntimeError("fixture Jenkins teardown failure")

    app = create_app(
        manager=manager,
        jenkins_service=FailingJenkins(),  # type: ignore[arg-type]
    )

    with pytest.raises(RuntimeError, match="fixture Jenkins teardown failure"), TestClient(app):
        pass

    assert manager.shutdown_called


def test_authenticated_app_update_lifecycle_runs_restart_callback() -> None:
    manager = FakeManager()
    updater = FakeUpdateManager()
    restart_requests: list[bool] = []
    app = create_app(
        token="secret",
        manager=manager,
        update_manager=updater,  # type: ignore[arg-type]
        on_update_ready=lambda: restart_requests.append(True),
    )
    headers = {"Authorization": "Bearer secret"}

    with TestClient(app) as client:
        assert client.get("/api/app-update").status_code == 401
        assert client.get("/api/app-update", headers=headers).json()["update"]["state"] == "idle"
        checked = client.post("/api/app-update/check", headers=headers)
        assert checked.json()["update"]["state"] == "available"
        downloaded = client.post("/api/app-update/download", headers=headers)
        assert downloaded.json()["update"]["state"] == "downloaded"
        installed = client.post("/api/app-update/install", headers=headers)

    assert installed.json()["update"]["state"] == "restarting"
    assert updater.calls == ["status", "check", "download", "install"]
    assert restart_requests == [True]


def test_authenticated_mcp_integration_lifecycle() -> None:
    integration = FakeMcpIntegration()
    app = create_app(
        token="secret",
        manager=FakeManager(),
        mcp_integration=integration,  # type: ignore[arg-type]
    )
    headers = {"Authorization": "Bearer secret"}

    with TestClient(app) as client:
        assert client.get("/api/mcp-integration").status_code == 401
        assert client.get("/api/mcp-integration", headers=headers).json()["mcp"]["state"] == "not_installed"
        assert client.post("/api/mcp-integration/install", headers=headers).json()["mcp"]["state"] == "installed"
        tested = client.post("/api/mcp-integration/test", headers=headers).json()["mcp"]
        assert tested["last_test"]["ok"] is True
        assert client.delete("/api/mcp-integration", headers=headers).json()["mcp"]["state"] == "not_installed"

    assert integration.calls == ["status", "install", "test", "remove"]


def test_authenticated_service_definition_update() -> None:
    manager = FakeManager()
    app = create_app(token="secret", manager=manager)
    headers = {"Authorization": "Bearer secret"}

    with TestClient(app) as client:
        created = client.post(
            "/api/services",
            headers=headers,
            json={"name": "api", "command": "python old.py", "cwd": "/tmp"},
        )
        assert created.status_code == 201

        updated = client.put(
            "/api/services/api",
            headers=headers,
            json={
                "command": "uv run backend/run.py",
                "cwd": "/workspace/project",
                "env": {"APP_ENV": "development", "PORT": "8000"},
                "auto_start": True,
                "stop_timeout": 12.5,
            },
        )
        assert updated.status_code == 200
        assert updated.json()["service"] == {
            "name": "api",
            "command": "uv run backend/run.py",
            "cwd": "/workspace/project",
            "env": {"APP_ENV": "development", "PORT": "8000"},
            "auto_start": True,
            "stop_timeout": 12.5,
            "state": "STOPPED",
            "pid": None,
        }
        assert client.put(
            "/api/services/api",
            json={"command": "python app.py", "cwd": "/tmp"},
        ).status_code == 401
        assert client.put(
            "/api/services/missing",
            headers=headers,
            json={"command": "python app.py", "cwd": "/tmp"},
        ).status_code == 404
        assert client.put(
            "/api/services/api",
            headers=headers,
            json={"command": "", "cwd": "/tmp"},
        ).status_code == 422


def test_authenticated_ui_theme_persists_across_app_instances(tmp_path) -> None:
    headers = {"Authorization": "Bearer secret"}
    first_app = create_app(data_dir=tmp_path, token="secret", manager=FakeManager())

    with TestClient(first_app) as client:
        initial = client.get("/")
        assert 'data-theme-preference="system"' in initial.text
        assert initial.headers["cache-control"] == "no-store"
        assert client.put("/api/ui-preferences", json={"theme": "dark"}).status_code == 401
        assert client.put(
            "/api/ui-preferences",
            headers=headers,
            json={"theme": "sepia"},
        ).status_code == 422
        saved = client.put(
            "/api/ui-preferences",
            headers=headers,
            json={"theme": "dark"},
        )
        assert saved.status_code == 200
        assert saved.json() == {"theme": "dark"}

    second_app = create_app(data_dir=tmp_path, token="secret", manager=FakeManager())
    with TestClient(second_app) as client:
        restored = client.get("/")
        assert 'data-theme-preference="dark"' in restored.text
        assert 'data-theme-preference="system"' not in restored.text


def test_websocket_token_and_event_forwarding() -> None:
    manager = FakeManager()
    app = create_app(token="secret", manager=manager)

    with TestClient(app) as client:
        try:
            with client.websocket_connect("/ws/events"):
                pass
        except WebSocketDisconnect as exc:
            assert exc.code == 1008
        else:
            raise AssertionError("unauthenticated WebSocket connection was accepted")

        with client.websocket_connect("/ws/events?token=secret") as websocket:
            event = {"type": "status", "service": "api", "data": {"state": "RUNNING"}}
            next(iter(manager.subscribers)).put_nowait(event)
            assert websocket.receive_json() == event

        assert not manager.subscribers


def test_websocket_lifecycle_commands() -> None:
    manager = FakeManager()
    app = create_app(token="secret", manager=manager)

    with TestClient(app) as client:
        with client.websocket_connect("/ws/events?token=secret") as websocket:
            manager.services["api"] = {"name": "api", "state": "STOPPED", "pid": None}

            websocket.send_json({"id": "start-1", "action": "start", "service": "api"})
            started = websocket.receive_json()
            assert started == {
                "type": "command_result",
                "id": "start-1",
                "action": "start",
                "service": "api",
                "ok": True,
                "data": {"name": "api", "state": "RUNNING", "pid": 123},
            }

            websocket.send_json({"id": "stop-1", "action": "stop", "service": "api"})
            stopped = websocket.receive_json()
            assert stopped["ok"] is True
            assert stopped["data"]["state"] == "STOPPED"

            websocket.send_json({"id": "bad-1", "action": "delete", "service": "api"})
            rejected = websocket.receive_json()
            assert rejected["ok"] is False
            assert rejected["error"] == "Unsupported action: delete"

            websocket.send_json({"id": "typed-1", "action": ["start"], "service": "api"})
            typed = websocket.receive_json()
            assert typed["ok"] is False
            assert typed["error"] == "Unsupported action: ['start']"

            websocket.send_json({"id": "missing-1", "action": "restart", "service": "missing"})
            missing = websocket.receive_json()
            assert missing["ok"] is False
            assert missing["error"] == "service not found: missing"


def test_authenticated_port_inspection_and_process_termination() -> None:
    manager = FakeManager()
    inspector = FakePortInspector()
    app = create_app(token="secret", manager=manager, port_inspector=inspector)
    headers = {"Authorization": "Bearer secret"}

    with TestClient(app) as client:
        assert client.get("/api/ports").status_code == 401

        all_ports = client.get("/api/ports", headers=headers)
        assert all_ports.status_code == 200
        assert all_ports.json()["ports"][0]["pid"] == 321
        assert inspector.list_calls == [None]

        selected_port = client.get("/api/ports?port=8123", headers=headers)
        assert selected_port.status_code == 200
        assert inspector.list_calls == [None, 8123]

        assert client.get("/api/ports?port=0", headers=headers).status_code == 422
        assert client.get("/api/ports?port=65536", headers=headers).status_code == 422
        assert inspector.list_calls == [None, 8123]

        endpoint = "/api/processes/321/terminate"
        assert client.post(endpoint, json={}).status_code == 401
        terminated = client.post(
            endpoint,
            headers=headers,
            json={"expected_port": 8123, "force": True, "timeout": 0.25},
        )
        assert terminated.status_code == 200
        assert terminated.json()["result"] == {
            "pid": 321,
            "expected_port": 8123,
            "action": "kill",
            "terminated": True,
            "force": True,
            "exit_code": -9,
        }
        assert inspector.terminate_calls == [(321, 8123, True, 0.25)]

        assert client.post("/api/processes/0/terminate", headers=headers, json={}).status_code == 422
        assert client.post(endpoint, headers=headers, json={"expected_port": 0}).status_code == 422
        assert client.post(endpoint, headers=headers, json={"timeout": -1}).status_code == 422
        assert client.post(endpoint, headers=headers, json={"timeout": 0}).status_code == 422
        assert inspector.terminate_calls == [(321, 8123, True, 0.25)]


def test_authenticated_process_discovery_uses_managed_pid_map() -> None:
    manager = FakeManager()
    manager.services["managed"] = {"name": "managed", "state": "RUNNING", "pid": 123}
    inspector = FakeProcessInspector()
    app = create_app(token="secret", manager=manager, process_inspector=inspector)
    headers = {"Authorization": "Bearer secret"}

    with TestClient(app) as client:
        assert client.get("/api/processes").status_code == 401

        listed = client.get(
            "/api/processes?query=celery&limit=5",
            headers=headers,
        )
        assert listed.status_code == 200
        assert listed.json() == {"processes": [FakeProcessInspector.process()]}
        assert inspector.list_calls == [("celery", 5, {123: "managed"})]

        detail = client.get("/api/processes/321", headers=headers)
        assert detail.status_code == 200
        assert detail.json() == {"process": FakeProcessInspector.process()}
        assert inspector.get_calls == [(321, {123: "managed"})]

        assert client.get("/api/processes?limit=0", headers=headers).status_code == 422
        assert client.get("/api/processes?limit=501", headers=headers).status_code == 422
        assert client.get("/api/processes/1", headers=headers).status_code == 422
        assert inspector.list_calls == [("celery", 5, {123: "managed"})]
        assert inspector.get_calls == [(321, {123: "managed"})]


def test_process_discovery_errors_map_to_http_responses() -> None:
    manager = FakeManager()
    inspector = FakeProcessInspector()
    app = create_app(manager=manager, process_inspector=inspector)

    with TestClient(app) as client:
        inspector.list_error = RuntimeError("process enumeration denied")
        response = client.get("/api/processes")
        assert response.status_code == 409
        assert response.json() == {"detail": "process enumeration denied"}

        inspector.list_error = None
        inspector.get_error = ValueError("process 999 changed identity")
        response = client.get("/api/processes/999")
        assert response.status_code == 400
        assert response.json() == {"detail": "process 999 changed identity"}

def test_port_tool_errors_map_to_http_responses() -> None:
    manager = FakeManager()
    inspector = FakePortInspector()
    app = create_app(manager=manager, port_inspector=inspector)

    with TestClient(app) as client:
        inspector.list_error = ValueError("invalid port filter")
        response = client.get("/api/ports")
        assert response.status_code == 400
        assert response.json() == {"detail": "invalid port filter"}

        inspector.list_error = None
        inspector.terminate_error = ValueError("PID 999 does not own port 8123")
        response = client.post(
            "/api/processes/999/terminate",
            json={"expected_port": 8123},
        )
        assert response.status_code == 400
        assert response.json() == {"detail": "PID 999 does not own port 8123"}

        inspector.terminate_error = RuntimeError("permission denied")
        response = client.post("/api/processes/999/terminate", json={})
        assert response.status_code == 409
        assert response.json() == {"detail": "permission denied"}
