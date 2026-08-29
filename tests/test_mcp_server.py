from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import pytest

import service_console.mcp_server as mcp_module
from service_console.mcp_server import ControllerBridge, MCPBridgeError
from service_console.runtime import RuntimeConnection


def connection(**overrides: object) -> RuntimeConnection:
    values: dict[str, object] = {
        "instance_id": "desktop-one",
        "pid": os.getpid(),
        "base_url": "http://127.0.0.1:43210",
        "token": "desktop-token",
        "started_at": "2026-08-28T00:00:00+00:00",
    }
    values.update(overrides)
    return RuntimeConnection(**values)  # type: ignore[arg-type]


def response(status: int, payload: object) -> httpx.Response:
    return httpx.Response(
        status,
        json=payload,
        request=httpx.Request("GET", "http://127.0.0.1:43210/api/test"),
    )


class RecordingBridge:
    def __init__(self, handler) -> None:
        self.handler = handler
        self.calls: list[tuple[str, str, dict[str, object]]] = []

    async def request(self, method: str, path: str, **kwargs: object) -> dict[str, object]:
        self.calls.append((method, path, kwargs))
        result = self.handler(method, path, kwargs)
        if isinstance(result, Exception):
            raise result
        return result


async def test_ensure_controller_launches_desktop_when_descriptor_is_missing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runtime_file = tmp_path / "controller.json"
    bridge = ControllerBridge(runtime_file, startup_timeout=0.25, poll_interval=0.001)
    current = connection()
    state = {"launched": False}
    launch_calls: list[tuple[Path, Path]] = []

    monkeypatch.setattr(
        bridge,
        "_load_connection",
        lambda: current if state["launched"] else None,
    )

    async def healthy(candidate: RuntimeConnection) -> bool:
        assert candidate is current
        return True

    def launch(path: Path, data_dir: Path) -> None:
        launch_calls.append((path, data_dir))
        state["launched"] = True

    monkeypatch.setattr(bridge, "_healthy", healthy)
    monkeypatch.setattr(mcp_module, "_launch_desktop", launch)

    assert await bridge.ensure_controller() is current
    assert launch_calls == [(runtime_file, (Path.home() / ".service-console").resolve())]


async def test_ensure_controller_does_not_launch_over_live_unhealthy_descriptor(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge = ControllerBridge(tmp_path / "controller.json", startup_timeout=0.01, poll_interval=0.001)
    current = connection()
    launches: list[Path] = []
    monkeypatch.setattr(bridge, "_load_connection", lambda: current)

    async def unhealthy(_candidate: RuntimeConnection) -> bool:
        return False

    monkeypatch.setattr(bridge, "_healthy", unhealthy)
    monkeypatch.setattr(mcp_module, "_launch_desktop", lambda path, _data_dir: launches.append(path))

    with pytest.raises(MCPBridgeError, match="did not become healthy"):
        await bridge.ensure_controller()
    assert launches == []


async def test_request_rereads_descriptor_and_retries_rejected_token(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge = ControllerBridge(tmp_path / "controller.json", poll_interval=0)
    old = connection(instance_id="old", token="old-token")
    new = connection(instance_id="new", token="new-token", base_url="http://127.0.0.1:43211")
    discovered = iter((old, new))
    sent: list[RuntimeConnection] = []

    async def ensure() -> RuntimeConnection:
        return next(discovered)

    async def send(candidate: RuntimeConnection, *_args: object, **_kwargs: object) -> httpx.Response:
        sent.append(candidate)
        if candidate is old:
            return response(401, {"detail": "expired token"})
        return response(200, {"services": []})

    monkeypatch.setattr(bridge, "ensure_controller", ensure)
    monkeypatch.setattr(bridge, "_send", send)

    assert await bridge.request("GET", "/api/services") == {"services": []}
    assert sent == [old, new]


async def test_request_rereads_descriptor_and_retries_transport_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge = ControllerBridge(tmp_path / "controller.json", poll_interval=0)
    old = connection(instance_id="old")
    new = connection(instance_id="new", base_url="http://127.0.0.1:43211")
    discovered = iter((old, new))
    sent: list[RuntimeConnection] = []

    async def ensure() -> RuntimeConnection:
        return next(discovered)

    async def send(candidate: RuntimeConnection, *_args: object, **_kwargs: object) -> httpx.Response:
        sent.append(candidate)
        if candidate is old:
            raise httpx.ConnectError("controller restarted")
        return response(200, {"status": "ok"})

    monkeypatch.setattr(bridge, "ensure_controller", ensure)
    monkeypatch.setattr(bridge, "_send", send)

    assert await bridge.request("GET", "/api/health") == {"status": "ok"}
    assert sent == [old, new]


async def test_request_does_not_retry_a_non_idempotent_operation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge = ControllerBridge(tmp_path / "controller.json", poll_interval=0)
    current = connection()
    ensures = 0
    sends = 0

    async def ensure() -> RuntimeConnection:
        nonlocal ensures
        ensures += 1
        return current

    async def send(*_args: object, **_kwargs: object) -> httpx.Response:
        nonlocal sends
        sends += 1
        raise httpx.ConnectError("response was lost after the request may have been accepted")

    monkeypatch.setattr(bridge, "ensure_controller", ensure)
    monkeypatch.setattr(bridge, "_send", send)

    with pytest.raises(MCPBridgeError, match="Unable to reach Service Console"):
        await bridge.request(
            "POST",
            "/api/jenkins/instances/ci/builds",
            retry_on_failure=False,
        )
    assert ensures == 1
    assert sends == 1


async def test_mcp_registers_complete_tool_surface() -> None:
    tools = {tool.name: tool for tool in await mcp_module.mcp.list_tools()}

    assert set(tools) == {
        "service_list",
        "service_status",
        "service_upsert",
        "service_start",
        "service_stop",
        "service_restart",
        "service_logs",
        "port_list",
        "process_list",
        "process_import",
        "process_terminate",
        "project_apply_config",
        "jenkins_instance_list",
        "jenkins_job_list",
        "jenkins_job_status",
        "jenkins_build_list",
        "jenkins_build_status",
        "jenkins_build_logs",
        "jenkins_queue_list",
        "jenkins_build_trigger",
        "jenkins_build_stop",
        "jenkins_queue_cancel",
    }
    assert tools["service_list"].annotations.read_only_hint is True
    assert tools["service_restart"].annotations.destructive_hint is True
    assert tools["process_terminate"].annotations.destructive_hint is True
    assert tools["project_apply_config"].annotations.idempotent_hint is True
    assert tools["jenkins_build_logs"].annotations.read_only_hint is True
    assert tools["jenkins_build_trigger"].annotations.idempotent_hint is False
    assert tools["jenkins_build_stop"].annotations.destructive_hint is True
    assert tools["jenkins_queue_cancel"].annotations.destructive_hint is True

    jenkins_tools = {name: tool for name, tool in tools.items() if name.startswith("jenkins_")}
    for name, tool in jenkins_tools.items():
        schema = tool.input_schema
        assert "token" not in json.dumps(schema).lower()
        if name != "jenkins_instance_list":
            assert "instance_id" in schema.get("required", [])


async def test_service_tools_use_structured_controller_endpoints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    existing = {
        "name": "api/worker",
        "command": "old",
        "cwd": "/workspace",
        "env": {},
        "auto_start": False,
        "stop_timeout": 5.0,
        "state": "STOPPED",
    }

    def handler(method: str, path: str, kwargs: dict[str, object]) -> dict[str, object]:
        if method == "GET" and path == "/api/services":
            return {"services": [existing]}
        if method == "PUT":
            body = kwargs["json_body"]
            assert isinstance(body, dict)
            return {"service": {"name": "api/worker", **body, "state": "STOPPED"}}
        if path.endswith("/restart"):
            return {"service": {**existing, "state": "RUNNING", "pid": 42}}
        if path.endswith("/logs"):
            return {"service": "api/worker", "logs": []}
        raise AssertionError((method, path, kwargs))

    fake = RecordingBridge(handler)
    monkeypatch.setattr(mcp_module, "_bridge", fake)

    status = await mcp_module.service_status("api/worker")
    updated = await mcp_module.service_upsert(
        "api/worker",
        "uv run worker.py",
        "/workspace",
        {"PYTHONUNBUFFERED": "1"},
        False,
        10,
    )
    restarted = await mcp_module.service_restart("api/worker")
    logs = await mcp_module.service_logs("api/worker", 25)

    assert status == {"service": existing}
    assert updated["operation"] == "updated"
    assert restarted["service"]["pid"] == 42  # type: ignore[index]
    assert logs == {"service": "api/worker", "logs": []}
    assert fake.calls[-2][:2] == ("POST", "/api/services/api%2Fworker/restart")
    assert fake.calls[-1] == (
        "GET",
        "/api/services/api%2Fworker/logs",
        {"params": {"tail": 25}},
    )


async def test_process_tools_import_safe_process_definition(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidate: dict[str, object] = {
        "pid": 321,
        "command": "uv run backend/run.py",
        "cwd": "/workspace/project",
        "suggested_name": "project-backend",
        "safe_env": {"PYTHONUNBUFFERED": "1"},
        "restorable": True,
        "warnings": [],
        "managed_service": None,
    }

    def handler(method: str, path: str, kwargs: dict[str, object]) -> dict[str, object]:
        if method == "GET" and path == "/api/processes/321":
            return {"process": candidate}
        if method == "POST" and path == "/api/services":
            body = kwargs["json_body"]
            assert isinstance(body, dict)
            return {"service": {**body, "state": "STOPPED"}}
        if method == "POST" and path == "/api/processes/321/terminate":
            return {"result": {"pid": 321, "terminated": True}}
        raise AssertionError((method, path, kwargs))

    fake = RecordingBridge(handler)
    monkeypatch.setattr(mcp_module, "_bridge", fake)

    imported = await mcp_module.process_import(321, "backend", False, 10)
    terminated = await mcp_module.process_terminate(321, 8000, False, 2)

    assert imported["service"] == {
        "name": "backend",
        "command": "uv run backend/run.py",
        "cwd": "/workspace/project",
        "env": {"PYTHONUNBUFFERED": "1"},
        "auto_start": False,
        "stop_timeout": 10,
        "state": "STOPPED",
    }
    assert "original process is still running" in str(imported["note"])
    assert terminated == {"result": {"pid": 321, "terminated": True}}
    assert fake.calls[-1][2]["json_body"] == {
        "expected_port": 8000,
        "force": False,
        "timeout": 2,
    }


async def test_jenkins_tools_use_explicit_instance_routes_and_bounded_logs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(method: str, path: str, kwargs: dict[str, object]) -> dict[str, object]:
        if path == "/api/jenkins/instances":
            return {
                "instances": [
                    {
                        "id": "jenkins one",
                        "name": "Team CI",
                        "base_url": "https://ci.example.test",
                        "username": "builder",
                        "token_present": True,
                    }
                ]
            }
        if path.endswith("/jobs"):
            return {"folder": "team", "jobs": [{"name": "backend"}]}
        if path.endswith("/job"):
            return {"job": {"name": "team/backend", "color": "blue"}}
        if path.endswith("/builds") and method == "GET":
            return {"job": "team/backend", "builds": [{"number": 8}]}
        if path.endswith("/builds") and method == "POST":
            return {"queue": {"id": 17, "url": "https://ci/queue/item/17/"}}
        if path.endswith("/builds/8/log"):
            return {
                "log": {
                    "job": "team/backend",
                    "number": 8,
                    "offset": 20,
                    "next_offset": 99,
                    "text": "hello世界more",
                    "more": False,
                    "complete": True,
                }
            }
        if path.endswith("/builds/8/stop"):
            return {"build": {"job": "team/backend", "number": 8, "stopped": True}}
        if path.endswith("/builds/8"):
            return {"build": {"job": "team/backend", "number": 8, "building": True}}
        if path.endswith("/queue/17/cancel"):
            return {"queue": {"id": 17, "cancelled": True}}
        if path.endswith("/queue"):
            return {"queue": [{"id": 17}]}
        raise AssertionError((method, path, kwargs))

    fake = RecordingBridge(handler)
    monkeypatch.setattr(mcp_module, "_bridge", fake)

    instances = await mcp_module.jenkins_instance_list()
    jobs = await mcp_module.jenkins_job_list("jenkins one", " team ", " backend ")
    job = await mcp_module.jenkins_job_status("jenkins one", " team/backend ", True)
    builds = await mcp_module.jenkins_build_list("jenkins one", "team/backend", 10)
    build = await mcp_module.jenkins_build_status("jenkins one", "team/backend", 8)
    log = await mcp_module.jenkins_build_logs("jenkins one", "team/backend", 8, 20, 8)
    queue = await mcp_module.jenkins_queue_list("jenkins one")
    triggered = await mcp_module.jenkins_build_trigger(
        "jenkins one",
        "team/backend",
        {"BRANCH": "main", "GROUP": ["server-a", "server-b"], "RETRIES": 2, "CLEAN": True},
    )
    stopped = await mcp_module.jenkins_build_stop("jenkins one", "team/backend", 8)
    cancelled = await mcp_module.jenkins_queue_cancel("jenkins one", 17)

    assert instances["instances"][0]["token_present"] is True  # type: ignore[index]
    assert jobs["folder"] == "team"
    assert job["job"]["name"] == "team/backend"  # type: ignore[index]
    assert builds["builds"] == [{"number": 8}]
    assert build["build"]["building"] is True  # type: ignore[index]
    assert log == {
        "log": {
            "job": "team/backend",
            "number": 8,
            "offset": 20,
            "next_offset": 28,
            "text": "hello世",
            "more": True,
            "complete": False,
            "returned_bytes": 8,
            "truncated": True,
        }
    }
    assert queue == {"queue": [{"id": 17}]}
    assert triggered["queue"]["id"] == 17  # type: ignore[index]
    assert stopped["build"]["stopped"] is True  # type: ignore[index]
    assert cancelled["queue"]["cancelled"] is True  # type: ignore[index]

    prefix = "/api/jenkins/instances/jenkins%20one"
    assert fake.calls == [
        ("GET", "/api/jenkins/instances", {}),
        ("GET", f"{prefix}/jobs", {"params": {"folder": "team", "query": "backend"}}),
        (
            "GET",
            f"{prefix}/job",
            {"params": {"job": "team/backend", "include_parameter_options": True}},
        ),
        ("GET", f"{prefix}/builds", {"params": {"job": "team/backend", "limit": 10}}),
        ("GET", f"{prefix}/builds/8", {"params": {"job": "team/backend"}}),
        (
            "GET",
            f"{prefix}/builds/8/log",
            {"params": {"job": "team/backend", "start": 20}},
        ),
        ("GET", f"{prefix}/queue", {}),
        (
            "POST",
            f"{prefix}/builds",
            {
                "params": {"job": "team/backend"},
                "json_body": {
                    "parameters": {
                        "BRANCH": "main",
                        "GROUP": ["server-a", "server-b"],
                        "RETRIES": 2,
                        "CLEAN": True,
                    }
                },
                "retry_on_failure": False,
            },
        ),
        (
            "POST",
            f"{prefix}/builds/8/stop",
            {"params": {"job": "team/backend"}, "retry_on_failure": False},
        ),
        ("POST", f"{prefix}/queue/17/cancel", {"retry_on_failure": False}),
    ]


async def test_project_apply_config_validates_then_creates_updates_and_skips(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    config = project / ".service-console.json"
    config.write_text(
        json.dumps(
            {
                "version": 1,
                "project": "demo",
                "services": [
                    {"name": "same", "command": "run same", "cwd": "."},
                    {"name": "changed", "command": "run new", "cwd": "."},
                    {
                        "name": "created",
                        "command": "run created",
                        "cwd": ".",
                        "env": {"PYTHONUNBUFFERED": "1"},
                        "stop_timeout": 10,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    resolved_cwd = str(project.resolve())
    current = [
        {
            "name": "same",
            "command": "run same",
            "cwd": resolved_cwd,
            "env": {},
            "auto_start": False,
            "stop_timeout": 5.0,
        },
        {
            "name": "changed",
            "command": "run old",
            "cwd": resolved_cwd,
            "env": {},
            "auto_start": False,
            "stop_timeout": 5.0,
        },
    ]

    def handler(method: str, path: str, kwargs: dict[str, object]) -> dict[str, object]:
        if method == "GET":
            return {"services": current}
        body = kwargs["json_body"]
        assert isinstance(body, dict)
        if method == "PUT":
            return {"service": {"name": "changed", **body}}
        if method == "POST":
            return {"service": dict(body)}
        raise AssertionError((method, path, kwargs))

    fake = RecordingBridge(handler)
    monkeypatch.setattr(mcp_module, "_bridge", fake)

    result = await mcp_module.project_apply_config(str(config))

    assert result["project"] == "demo"
    assert result["counts"] == {"created": 1, "updated": 1, "unchanged": 1}
    assert [call[:2] for call in fake.calls] == [
        ("GET", "/api/services"),
        ("PUT", "/api/services/changed"),
        ("POST", "/api/services"),
    ]
    created_body = fake.calls[-1][2]["json_body"]
    assert isinstance(created_body, dict)
    assert created_body["cwd"] == resolved_cwd
    assert created_body["env"] == {"PYTHONUNBUFFERED": "1"}


def test_project_apply_config_rejects_duplicates_before_controller_changes(tmp_path: Path) -> None:
    config = tmp_path / ".service-console.json"
    config.write_text(
        json.dumps(
            {
                "version": 1,
                "services": [
                    {"name": "api", "command": "run one"},
                    {"name": "api", "command": "run two"},
                ],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(MCPBridgeError, match="duplicate service name"):
        mcp_module._load_project_definition(str(config))


def test_source_launch_command_uses_python_module(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("SERVICE_CONSOLE_DESKTOP_EXECUTABLE", raising=False)
    monkeypatch.delattr(mcp_module.sys, "frozen", raising=False)

    data_dir = tmp_path / "custom data"
    command = mcp_module._desktop_launch_command(tmp_path / "controller.json", data_dir)

    assert command[:3] == [str(Path(mcp_module.sys.executable).resolve()), "-m", "service_console.desktop"]
    assert command[3:5] == ["--data-dir", str(data_dir)]
    assert command[-2:] == ["--runtime-file", str(tmp_path / "controller.json")]
