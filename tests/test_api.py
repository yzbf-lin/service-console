from __future__ import annotations

import asyncio
from typing import Any

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
