"""stdio MCP bridge for the private desktop controller.

The MCP process never owns managed services itself.  It discovers the desktop
controller through its private runtime descriptor and forwards structured tool
calls to the existing authenticated HTTP API.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

import httpx
from mcp.server import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from service_console import __version__
from service_console.runtime import RuntimeConnection, load_runtime_connection, runtime_path


class MCPBridgeError(RuntimeError):
    """An actionable failure suitable for an MCP tool result."""


READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=False)
IDEMPOTENT_WRITE = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=False,
)
STOP_WRITE = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=True,
    idempotent_hint=True,
    open_world_hint=False,
)
NON_IDEMPOTENT_WRITE = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=False,
    idempotent_hint=False,
    open_world_hint=False,
)
DESTRUCTIVE_WRITE = ToolAnnotations(
    read_only_hint=False,
    destructive_hint=True,
    idempotent_hint=False,
    open_world_hint=False,
)


def _authorization_headers(connection: RuntimeConnection) -> dict[str, str]:
    return {"Authorization": f"Bearer {connection.token}"}


def _response_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict) and payload.get("detail"):
        return str(payload["detail"])
    text = response.text.strip()
    return text or response.reason_phrase or "request failed"


def _desktop_app_from_executable(executable: Path) -> Path | None:
    for parent in (executable, *executable.parents):
        if parent.suffix.lower() == ".app":
            return parent
    return None


def _desktop_launch_command(runtime_file: Path, data_dir: Path) -> list[str]:
    """Return a shell-free command that starts the GUI for this installation."""

    configured = os.environ.get("SERVICE_CONSOLE_DESKTOP_EXECUTABLE", "").strip()
    if configured:
        selected = Path(configured).expanduser()
        if sys.platform == "darwin" and selected.suffix.lower() == ".app":
            return [
                "open",
                "-g",
                str(selected),
                "--args",
                "--data-dir",
                str(data_dir),
                "--runtime-file",
                str(runtime_file),
            ]
        return [
            str(selected),
            "--data-dir",
            str(data_dir),
            "--runtime-file",
            str(runtime_file),
        ]

    executable = Path(sys.executable).resolve()
    if getattr(sys, "frozen", False):
        if sys.platform == "darwin":
            application = _desktop_app_from_executable(executable)
            if application is None:
                raise MCPBridgeError("Unable to locate Service Console.app from the MCP helper")
            return [
                "open",
                "-g",
                str(application),
                "--args",
                "--data-dir",
                str(data_dir),
                "--runtime-file",
                str(runtime_file),
            ]
        if os.name == "nt":
            desktop = executable.with_name("Service Console.exe")
            if not desktop.is_file():
                raise MCPBridgeError(f"Unable to locate the desktop executable: {desktop}")
            return [
                str(desktop),
                "--data-dir",
                str(data_dir),
                "--runtime-file",
                str(runtime_file),
            ]

    return [
        str(executable),
        "-m",
        "service_console.desktop",
        "--data-dir",
        str(data_dir),
        "--runtime-file",
        str(runtime_file),
    ]


def _launch_desktop(runtime_file: Path, data_dir: Path) -> None:
    command = _desktop_launch_command(runtime_file, data_dir)
    options: dict[str, object] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        options["creationflags"] = (
            getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    else:
        options["start_new_session"] = True
    try:
        subprocess.Popen(command, **options)
    except OSError as exc:
        raise MCPBridgeError(f"Unable to start Service Console: {exc}") from exc


class ControllerBridge:
    """Discover, start, and call the desktop controller without caching its token."""

    def __init__(
        self,
        runtime_file: str | Path | None = None,
        *,
        data_dir: str | Path = "~/.service-console",
        startup_timeout: float = 15.0,
        poll_interval: float = 0.1,
        request_timeout: float = 60.0,
    ) -> None:
        selected_runtime = runtime_file or os.environ.get("SERVICE_CONSOLE_RUNTIME_FILE")
        self.runtime_file = (
            Path(selected_runtime).expanduser().resolve()
            if selected_runtime
            else runtime_path().resolve()
        )
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.startup_timeout = startup_timeout
        self.poll_interval = poll_interval
        self.request_timeout = request_timeout
        self._launch_lock = asyncio.Lock()

    def _load_connection(self) -> RuntimeConnection | None:
        try:
            return load_runtime_connection(self.runtime_file)
        except ValueError as exc:
            raise MCPBridgeError(f"Invalid desktop controller descriptor: {exc}") from exc

    async def _send(
        self,
        connection: RuntimeConnection,
        method: str,
        path: str,
        *,
        params: Mapping[str, object] | None = None,
        json_body: Mapping[str, object] | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        request_options: dict[str, object] = {
            "headers": _authorization_headers(connection),
        }
        if params is not None:
            request_options["params"] = params
        if json_body is not None:
            request_options["json"] = json_body
        async with httpx.AsyncClient(timeout=timeout or self.request_timeout) as client:
            return await client.request(
                method,
                f"{connection.base_url.rstrip('/')}{path}",
                **request_options,
            )

    async def _healthy(self, connection: RuntimeConnection) -> bool:
        try:
            response = await self._send(connection, "GET", "/api/health", timeout=0.75)
        except httpx.RequestError:
            return False
        return response.status_code == 200

    async def ensure_controller(self) -> RuntimeConnection:
        """Return a healthy connection, launching the GUI when no descriptor exists."""

        deadline = time.monotonic() + self.startup_timeout
        launched = False
        while True:
            connection = await asyncio.to_thread(self._load_connection)
            if connection is not None and await self._healthy(connection):
                return connection

            if connection is None and not launched:
                async with self._launch_lock:
                    # Another request in this MCP process may have completed startup while waiting.
                    current = await asyncio.to_thread(self._load_connection)
                    if current is not None and await self._healthy(current):
                        return current
                    if current is None:
                        await asyncio.to_thread(
                            _launch_desktop,
                            self.runtime_file,
                            self.data_dir,
                        )
                        launched = True

                        # Keep the lock until this launch succeeds or times out. Otherwise two
                        # concurrent tool calls could both observe the pre-publication gap and
                        # start separate desktop instances.
                        while time.monotonic() < deadline:
                            current = await asyncio.to_thread(self._load_connection)
                            if current is not None and await self._healthy(current):
                                return current
                            await asyncio.sleep(self.poll_interval)
                        raise MCPBridgeError(
                            f"Service Console did not publish {self.runtime_file} within "
                            f"{self.startup_timeout:g} seconds"
                        )

            if time.monotonic() >= deadline:
                if connection is None:
                    raise MCPBridgeError(
                        f"Service Console did not publish {self.runtime_file} within "
                        f"{self.startup_timeout:g} seconds"
                    )
                raise MCPBridgeError(
                    f"Service Console controller at {connection.base_url} did not become healthy "
                    f"within {self.startup_timeout:g} seconds"
                )
            await asyncio.sleep(self.poll_interval)

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, object] | None = None,
        json_body: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        """Call the controller, re-reading its descriptor once after connection/token failure."""

        last_error: BaseException | None = None
        for attempt in range(2):
            connection = await self.ensure_controller()
            try:
                response = await self._send(
                    connection,
                    method,
                    path,
                    params=params,
                    json_body=json_body,
                )
            except httpx.RequestError as exc:
                last_error = exc
                if attempt == 0:
                    await asyncio.sleep(self.poll_interval)
                    continue
                raise MCPBridgeError(
                    f"Unable to reach Service Console at {connection.base_url}: {exc}"
                ) from exc

            if response.status_code in (401, 403) and attempt == 0:
                last_error = MCPBridgeError(
                    f"Controller rejected the runtime token: {_response_detail(response)}"
                )
                await asyncio.sleep(self.poll_interval)
                continue
            if response.is_error:
                raise MCPBridgeError(
                    f"Service Console HTTP {response.status_code}: {_response_detail(response)}"
                )
            if not response.content:
                return {}
            try:
                payload = response.json()
            except ValueError as exc:
                raise MCPBridgeError("Service Console returned invalid JSON") from exc
            if not isinstance(payload, dict):
                raise MCPBridgeError("Service Console returned a non-object JSON response")
            return payload

        assert last_error is not None
        raise MCPBridgeError(str(last_error))


def _services_from_payload(payload: Mapping[str, object]) -> list[dict[str, object]]:
    services = payload.get("services")
    if not isinstance(services, list):
        raise MCPBridgeError("Service Console response is missing the services list")
    return [item for item in services if isinstance(item, dict)]


def _object_from_payload(payload: Mapping[str, object], key: str) -> dict[str, object]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise MCPBridgeError(f"Service Console response is missing the {key} object")
    return value


def _normalized_environment(environment: Mapping[str, object] | None) -> dict[str, str]:
    if environment is None:
        return {}
    return {str(key): str(value) for key, value in environment.items()}


async def _upsert_service(
    client: ControllerBridge,
    *,
    name: str,
    command: str,
    cwd: str,
    env: Mapping[str, object] | None,
    auto_start: bool,
    stop_timeout: float,
    known_services: dict[str, dict[str, object]] | None = None,
) -> dict[str, object]:
    normalized_name = name.strip()
    normalized_command = command.strip()
    if not normalized_name:
        raise MCPBridgeError("service name must not be empty")
    if not normalized_command:
        raise MCPBridgeError("service command must not be empty")
    if not cwd:
        raise MCPBridgeError("service cwd must not be empty")
    if not math.isfinite(stop_timeout) or stop_timeout < 0:
        raise MCPBridgeError("stop_timeout must be a finite number greater than or equal to zero")

    body: dict[str, object] = {
        "command": normalized_command,
        "cwd": cwd,
        "env": _normalized_environment(env),
        "auto_start": auto_start,
        "stop_timeout": stop_timeout,
    }
    if known_services is None:
        listed = await client.request("GET", "/api/services")
        known_services = {str(item.get("name")): item for item in _services_from_payload(listed)}

    existing = known_services.get(normalized_name)
    if existing is not None and all(existing.get(key) == value for key, value in body.items()):
        return {"operation": "unchanged", "service": existing}

    encoded_name = quote(normalized_name, safe="")
    if existing is None:
        result = await client.request(
            "POST",
            "/api/services",
            json_body={"name": normalized_name, **body},
        )
        operation = "created"
    else:
        result = await client.request(
            "PUT",
            f"/api/services/{encoded_name}",
            json_body=body,
        )
        operation = "updated"
    service = _object_from_payload(result, "service")
    known_services[normalized_name] = service
    return {"operation": operation, "service": service}


def _load_project_definition(config_path: str) -> tuple[Path, str | None, list[dict[str, object]]]:
    source = Path(config_path).expanduser().resolve()
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise MCPBridgeError(f"Project service configuration does not exist: {source}") from exc
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MCPBridgeError(f"Unable to read project service configuration {source}: {exc}") from exc
    if not isinstance(payload, dict):
        raise MCPBridgeError("Project service configuration must be a JSON object")
    if payload.get("version") != 1:
        raise MCPBridgeError("Project service configuration version must be 1")

    project_value = payload.get("project")
    if project_value is not None and not isinstance(project_value, str):
        raise MCPBridgeError("Project name must be a string")
    raw_services = payload.get("services")
    if not isinstance(raw_services, list):
        raise MCPBridgeError("Project service configuration must contain a services list")

    definitions: list[dict[str, object]] = []
    names: set[str] = set()
    for index, value in enumerate(raw_services):
        if not isinstance(value, dict):
            raise MCPBridgeError(f"services[{index}] must be an object")
        name = value.get("name")
        command = value.get("command")
        if not isinstance(name, str) or not name.strip():
            raise MCPBridgeError(f"services[{index}].name must be a non-empty string")
        name = name.strip()
        if name in names:
            raise MCPBridgeError(f"duplicate service name in project configuration: {name}")
        names.add(name)
        if not isinstance(command, str) or not command.strip():
            raise MCPBridgeError(f"services[{index}].command must be a non-empty string")

        cwd_value = value.get("cwd", ".")
        if not isinstance(cwd_value, str) or not cwd_value:
            raise MCPBridgeError(f"services[{index}].cwd must be a non-empty string")
        cwd = Path(cwd_value).expanduser()
        if not cwd.is_absolute():
            cwd = source.parent / cwd

        env = value.get("env", {})
        if not isinstance(env, dict) or not all(
            isinstance(key, str) and isinstance(item, str) for key, item in env.items()
        ):
            raise MCPBridgeError(f"services[{index}].env must contain only string values")
        auto_start = value.get("auto_start", False)
        if not isinstance(auto_start, bool):
            raise MCPBridgeError(f"services[{index}].auto_start must be a boolean")
        stop_timeout = value.get("stop_timeout", 5.0)
        if (
            isinstance(stop_timeout, bool)
            or not isinstance(stop_timeout, (int, float))
            or not math.isfinite(float(stop_timeout))
            or float(stop_timeout) < 0
        ):
            raise MCPBridgeError(
                f"services[{index}].stop_timeout must be a finite non-negative number"
            )
        definitions.append(
            {
                "name": name,
                "command": command.strip(),
                "cwd": str(cwd.resolve()),
                "env": dict(env),
                "auto_start": auto_start,
                "stop_timeout": float(stop_timeout),
            }
        )
    return source, project_value, definitions


mcp = MCPServer(
    "Service Console",
    version=__version__,
    instructions=(
        "Manage local development services through Service Console. If the current repository "
        "contains .service-console.json, call project_apply_config with its absolute path before "
        "lifecycle operations. After start or restart, call service_status and service_logs to "
        "verify readiness. Prefer managed lifecycle tools over raw shell starts so duplicate "
        "instances are not created."
    ),
    log_level="WARNING",
)
_bridge = ControllerBridge()


@mcp.tool(annotations=READ_ONLY)
async def service_list() -> dict[str, object]:
    """List configured services with lifecycle state, PID, metrics, and command."""

    return await _bridge.request("GET", "/api/services")


@mcp.tool(annotations=READ_ONLY)
async def service_status(name: Annotated[str, Field(min_length=1)]) -> dict[str, object]:
    """Return the current snapshot for one configured service."""

    payload = await _bridge.request("GET", "/api/services")
    for service in _services_from_payload(payload):
        if service.get("name") == name:
            return {"service": service}
    raise MCPBridgeError(f"service not found: {name}")


@mcp.tool(annotations=IDEMPOTENT_WRITE)
async def service_upsert(
    name: Annotated[str, Field(min_length=1)],
    command: Annotated[str, Field(min_length=1)],
    cwd: Annotated[str, Field(min_length=1)],
    env: dict[str, str] | None = None,
    auto_start: bool = False,
    stop_timeout: Annotated[float, Field(ge=0, allow_inf_nan=False)] = 5.0,
) -> dict[str, object]:
    """Create or update a service definition; running processes are not restarted automatically."""

    return await _upsert_service(
        _bridge,
        name=name,
        command=command,
        cwd=cwd,
        env=env,
        auto_start=auto_start,
        stop_timeout=stop_timeout,
    )


async def _service_action(name: str, action: str) -> dict[str, object]:
    encoded_name = quote(name, safe="")
    return await _bridge.request("POST", f"/api/services/{encoded_name}/{action}")


@mcp.tool(annotations=IDEMPOTENT_WRITE)
async def service_start(name: Annotated[str, Field(min_length=1)]) -> dict[str, object]:
    """Start a stopped service. Calling this for a running service is idempotent."""

    return await _service_action(name, "start")


@mcp.tool(annotations=STOP_WRITE)
async def service_stop(name: Annotated[str, Field(min_length=1)]) -> dict[str, object]:
    """Gracefully stop a service and its owned process tree."""

    return await _service_action(name, "stop")


@mcp.tool(annotations=DESTRUCTIVE_WRITE)
async def service_restart(name: Annotated[str, Field(min_length=1)]) -> dict[str, object]:
    """Stop and start a service, returning its new runtime snapshot."""

    return await _service_action(name, "restart")


@mcp.tool(annotations=READ_ONLY)
async def service_logs(
    name: Annotated[str, Field(min_length=1)],
    tail: Annotated[int, Field(ge=0, le=10_000)] = 200,
) -> dict[str, object]:
    """Read recent persisted stdout and stderr entries for one service."""

    encoded_name = quote(name, safe="")
    return await _bridge.request(
        "GET",
        f"/api/services/{encoded_name}/logs",
        params={"tail": tail},
    )


@mcp.tool(annotations=READ_ONLY)
async def port_list(
    port: Annotated[int | None, Field(ge=1, le=65_535)] = None,
) -> dict[str, object]:
    """List local listening ports and their owning processes, optionally filtered by port."""

    params = {"port": port} if port is not None else None
    return await _bridge.request("GET", "/api/ports", params=params)


@mcp.tool(annotations=READ_ONLY)
async def process_list(
    query: Annotated[str, Field(max_length=200)] = "",
    limit: Annotated[int, Field(ge=1, le=500)] = 100,
) -> dict[str, object]:
    """Find unmanaged processes that can be inspected or imported as service definitions."""

    params: dict[str, object] = {"limit": limit}
    if query.strip():
        params["query"] = query.strip()
    return await _bridge.request("GET", "/api/processes", params=params)


@mcp.tool(annotations=NON_IDEMPOTENT_WRITE)
async def process_import(
    pid: Annotated[int, Field(gt=1)],
    name: str | None = None,
    auto_start: bool = False,
    stop_timeout: Annotated[float, Field(ge=0, allow_inf_nan=False)] = 5.0,
) -> dict[str, object]:
    """Inspect a running process and save its restorable command as a new stopped service."""

    inspected = await _bridge.request("GET", f"/api/processes/{pid}")
    process = _object_from_payload(inspected, "process")
    if process.get("managed_service"):
        raise MCPBridgeError(f"process {pid} is already managed by {process['managed_service']}")
    if not process.get("restorable"):
        warnings = process.get("warnings")
        detail = str(warnings[0]) if isinstance(warnings, list) and warnings else "not restorable"
        raise MCPBridgeError(f"process {pid} cannot be imported: {detail}")
    selected_name = (name or str(process.get("suggested_name") or "")).strip()
    if not selected_name:
        raise MCPBridgeError(f"process {pid} does not provide a service name")
    command = str(process.get("command") or "").strip()
    cwd = str(process.get("cwd") or "")
    result = await _bridge.request(
        "POST",
        "/api/services",
        json_body={
            "name": selected_name,
            "command": command,
            "cwd": cwd,
            "env": _normalized_environment(
                process.get("safe_env") if isinstance(process.get("safe_env"), dict) else None
            ),
            "auto_start": auto_start,
            "stop_timeout": stop_timeout,
        },
    )
    return {
        "operation": "created",
        "service": _object_from_payload(result, "service"),
        "process": process,
        "note": "The original process is still running; stop it before starting the saved service.",
    }


@mcp.tool(annotations=DESTRUCTIVE_WRITE)
async def process_terminate(
    pid: Annotated[int, Field(gt=1)],
    expected_port: Annotated[int | None, Field(ge=1, le=65_535)] = None,
    force: bool = False,
    timeout: Annotated[float, Field(gt=0, allow_inf_nan=False)] = 3.0,
) -> dict[str, object]:
    """Terminate a local process, optionally verifying that it still owns an expected port."""

    return await _bridge.request(
        "POST",
        f"/api/processes/{pid}/terminate",
        json_body={"expected_port": expected_port, "force": force, "timeout": timeout},
    )


@mcp.tool(annotations=IDEMPOTENT_WRITE)
async def project_apply_config(
    config_path: Annotated[str, Field(min_length=1)],
) -> dict[str, object]:
    """Apply a version-1 .service-console.json file without deleting unspecified services."""

    source, project, definitions = await asyncio.to_thread(_load_project_definition, config_path)
    listed = await _bridge.request("GET", "/api/services")
    known = {str(item.get("name")): item for item in _services_from_payload(listed)}
    applied: list[dict[str, object]] = []
    for definition in definitions:
        applied.append(
            await _upsert_service(
                _bridge,
                name=str(definition["name"]),
                command=str(definition["command"]),
                cwd=str(definition["cwd"]),
                env=definition["env"] if isinstance(definition["env"], dict) else None,
                auto_start=bool(definition["auto_start"]),
                stop_timeout=float(definition["stop_timeout"]),
                known_services=known,
            )
        )
    counts = {
        operation: sum(1 for item in applied if item["operation"] == operation)
        for operation in ("created", "updated", "unchanged")
    }
    return {
        "config_path": str(source),
        "project": project,
        "counts": counts,
        "services": applied,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="service-console-mcp")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("SERVICE_CONSOLE_DATA_DIR", "~/.service-console"),
        help="Service Console data directory used when the desktop must be started",
    )
    parser.add_argument(
        "--runtime-file",
        default=os.environ.get("SERVICE_CONSOLE_RUNTIME_FILE", str(runtime_path())),
        help="desktop controller descriptor",
    )
    parser.add_argument("--startup-timeout", type=float, default=15.0)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    global _bridge
    args = build_parser().parse_args(argv)
    if not math.isfinite(args.startup_timeout) or args.startup_timeout <= 0:
        raise SystemExit("--startup-timeout must be a finite positive number")
    _bridge = ControllerBridge(
        args.runtime_file,
        data_dir=args.data_dir,
        startup_timeout=args.startup_timeout,
    )
    mcp.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
