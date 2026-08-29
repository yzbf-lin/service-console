"""FastAPI interface for the service manager."""

from __future__ import annotations

import asyncio
import math
import secrets
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .jenkins import CredentialStore, JenkinsApiError, JenkinsGateway, JenkinsService
from .manager import ServiceManager
from .mcp_integration import McpIntegrationManager
from .models import ServiceDefinition
from .ports import PortInspector
from .processes import ProcessInspector
from .settings import UiPreferencesStore
from .update import UpdateManager


class ServiceCreateRequest(BaseModel):
    """Payload used to register a service."""

    name: str = Field(min_length=1)
    command: str = Field(min_length=1)
    cwd: str
    env: dict[str, str] = Field(default_factory=dict)
    auto_start: bool = False
    stop_timeout: float = Field(default=5.0, ge=0)


class ServiceUpdateRequest(BaseModel):
    """Full replacement payload for an existing service."""

    command: str = Field(min_length=1)
    cwd: str
    env: dict[str, str] = Field(default_factory=dict)
    auto_start: bool = False
    stop_timeout: float = Field(default=5.0, ge=0)


class ProcessTerminateRequest(BaseModel):
    """Options used to terminate one local process safely."""

    expected_port: int | None = Field(default=None, ge=1, le=65535)
    force: bool = False
    timeout: float = Field(default=3.0, gt=0, allow_inf_nan=False)


class UiPreferencesRequest(BaseModel):
    """Validated appearance preference stored outside the browser profile."""

    theme: Literal["system", "light", "dark"]


class JenkinsInstanceRequest(BaseModel):
    """Create or fully replace one Jenkins controller definition."""

    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(min_length=1, max_length=2_048)
    username: str = Field(min_length=1, max_length=256)
    token: str | None = Field(default=None, min_length=1, max_length=4_096)
    ca_bundle: str | None = Field(default=None, max_length=4_096)
    enabled: bool = True
    request_timeout: float = Field(default=15.0, ge=1, le=120, allow_inf_nan=False)


JenkinsParameterValue = str | int | float | bool | list[str]


class JenkinsBuildRequest(BaseModel):
    """Parameters passed to a normal or parameterized Jenkins build."""

    parameters: dict[str, JenkinsParameterValue] = Field(default_factory=dict)

    @field_validator("parameters")
    @classmethod
    def validate_parameters(
        cls,
        parameters: dict[str, JenkinsParameterValue],
    ) -> dict[str, JenkinsParameterValue]:
        if len(parameters) > 200:
            raise ValueError("at most 200 Jenkins build parameters are supported")
        for name, value in parameters.items():
            if not name.strip() or len(name) > 256 or any(ord(character) < 32 for character in name):
                raise ValueError("Jenkins build parameter names must be printable and non-empty")
            if isinstance(value, str) and len(value) > 16_384:
                raise ValueError("Jenkins build parameter values must not exceed 16384 characters")
            if isinstance(value, list):
                if len(value) > 5_000:
                    raise ValueError("Jenkins multi-select parameters must not exceed 5000 values")
                if any(len(item) > 16_384 for item in value):
                    raise ValueError("Jenkins build parameter values must not exceed 16384 characters")
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("Jenkins build parameter values must be finite")
        return parameters


class JenkinsParameterResolutionRequest(JenkinsBuildRequest):
    """Current form values used to refresh Jenkins reactive parameter choices."""


def _definition(name: str, body: ServiceCreateRequest | ServiceUpdateRequest) -> ServiceDefinition:
    values = body.model_dump()
    values["name"] = name
    return ServiceDefinition(**values)


def create_app(
    data_dir: str | Path = "~/.service-console",
    token: str | None = None,
    manager: ServiceManager | None = None,
    port_inspector: PortInspector | None = None,
    process_inspector: ProcessInspector | None = None,
    jenkins_service: JenkinsService | None = None,
    jenkins_credential_store: CredentialStore | None = None,
    jenkins_gateway: JenkinsGateway | None = None,
    update_manager: UpdateManager | None = None,
    mcp_integration: McpIntegrationManager | None = None,
    on_update_ready: Callable[[], None] | None = None,
    runtime_file: str | Path | None = None,
) -> FastAPI:
    """Create an application and own the supplied manager for its lifespan."""

    selected_data_dir = Path(data_dir).expanduser()
    service_manager = manager or ServiceManager(selected_data_dir)
    port_tool = port_inspector if port_inspector is not None else PortInspector()
    process_tool = process_inspector or ProcessInspector(port_tool)
    jenkins_tool = jenkins_service or JenkinsService(
        selected_data_dir,
        credential_store=jenkins_credential_store,
        gateway=jenkins_gateway,
    )
    ui_preferences = UiPreferencesStore(selected_data_dir)
    update_tool = update_manager or UpdateManager(
        selected_data_dir,
        install_enabled=on_update_ready is not None,
    )
    mcp_tool = mcp_integration or McpIntegrationManager(
        selected_data_dir,
        runtime_file=runtime_file,
        registration_enabled=runtime_file is not None,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.manager = service_manager
        await service_manager.initialize()
        try:
            await jenkins_tool.initialize()
            yield
        finally:
            # Service cleanup is the primary shutdown invariant. Keep it independent from
            # Jenkins client teardown so a remote-client error can never leave children alive.
            try:
                await service_manager.shutdown()
            finally:
                await jenkins_tool.shutdown()

    app = FastAPI(title="Service Console", lifespan=lifespan)
    app.state.manager = service_manager
    app.state.port_inspector = port_tool
    app.state.process_inspector = process_tool
    app.state.jenkins = jenkins_tool
    app.state.update_manager = update_tool
    app.state.mcp_integration = mcp_tool
    app.state.token = token

    async def managed_processes() -> dict[int, str]:
        managed: dict[int, str] = {}
        for service in await service_manager.list_services():
            pid = service.get("pid")
            if isinstance(pid, int) and not isinstance(pid, bool) and pid > 1:
                managed[pid] = str(service["name"])
        return managed

    async def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
        if token is None:
            return
        scheme, _, credentials = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(credentials, token):
            raise HTTPException(
                status_code=401,
                detail="Invalid or missing bearer token",
                headers={"WWW-Authenticate": "Bearer"},
            )

    @app.exception_handler(KeyError)
    async def handle_key_error(_request: object, exc: KeyError) -> JSONResponse:
        detail = str(exc.args[0]) if exc.args else "Service not found"
        return JSONResponse(status_code=404, content={"detail": detail})

    @app.exception_handler(ValueError)
    async def handle_value_error(_request: object, exc: ValueError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(RuntimeError)
    async def handle_runtime_error(_request: object, exc: RuntimeError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(JenkinsApiError)
    async def handle_jenkins_error(_request: object, exc: JenkinsApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation_error(
        _request: object,
        exc: RequestValidationError,
    ) -> JSONResponse:
        # Pydantic includes the rejected input by default. Omitting it prevents API tokens
        # and password-like build parameters from being reflected in validation responses.
        detail = [
            {
                "type": error.get("type", "value_error"),
                "loc": error.get("loc", ()),
                "msg": error.get("msg", "Invalid request"),
            }
            for error in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": detail})

    api = APIRouter(prefix="/api", dependencies=[Depends(require_token)])

    @api.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @api.put("/ui-preferences")
    async def update_ui_preferences(body: UiPreferencesRequest) -> dict[str, str]:
        await asyncio.to_thread(ui_preferences.save_theme, body.theme)
        return {"theme": body.theme}

    @api.get("/app-update")
    async def app_update_status() -> dict[str, dict[str, object]]:
        return {"update": update_tool.status()}

    @api.post("/app-update/check")
    async def check_app_update() -> dict[str, dict[str, object]]:
        return {"update": await asyncio.to_thread(update_tool.check)}

    @api.post("/app-update/download")
    async def download_app_update() -> dict[str, dict[str, object]]:
        return {"update": await asyncio.to_thread(update_tool.download)}

    @api.post("/app-update/install")
    async def install_app_update(
        background_tasks: BackgroundTasks,
    ) -> dict[str, dict[str, object]]:
        update = await asyncio.to_thread(update_tool.install)
        if bool(update.get("restart_required")) and on_update_ready is not None:
            background_tasks.add_task(on_update_ready)
        return {"update": update}

    @api.get("/mcp-integration")
    async def mcp_integration_status() -> dict[str, dict[str, object]]:
        return {"mcp": await asyncio.to_thread(mcp_tool.status)}

    @api.post("/mcp-integration/install")
    async def install_mcp_integration() -> dict[str, dict[str, object]]:
        return {"mcp": await asyncio.to_thread(mcp_tool.install)}

    @api.post("/mcp-integration/test")
    async def test_mcp_integration() -> dict[str, dict[str, object]]:
        return {"mcp": await asyncio.to_thread(mcp_tool.test)}

    @api.delete("/mcp-integration")
    async def remove_mcp_integration() -> dict[str, dict[str, object]]:
        return {"mcp": await asyncio.to_thread(mcp_tool.remove)}

    @api.get("/jenkins/instances")
    async def list_jenkins_instances() -> dict[str, list[dict[str, object]]]:
        return {"instances": await jenkins_tool.list_instances()}

    @api.post("/jenkins/instances", status_code=201)
    async def create_jenkins_instance(
        body: JenkinsInstanceRequest,
    ) -> dict[str, dict[str, object]]:
        return {"instance": await jenkins_tool.create_instance(**body.model_dump())}

    @api.put("/jenkins/instances/{instance_id}")
    async def update_jenkins_instance(
        instance_id: str,
        body: JenkinsInstanceRequest,
    ) -> dict[str, dict[str, object]]:
        return {"instance": await jenkins_tool.update_instance(instance_id, **body.model_dump())}

    @api.delete("/jenkins/instances/{instance_id}")
    async def delete_jenkins_instance(instance_id: str) -> dict[str, str]:
        await jenkins_tool.delete_instance(instance_id)
        return {"deleted": instance_id}

    @api.post("/jenkins/instances/{instance_id}/test")
    async def test_jenkins_instance(instance_id: str) -> dict[str, dict[str, object]]:
        return {"connection": await jenkins_tool.test_connection(instance_id)}

    @api.get("/jenkins/instances/{instance_id}/jobs")
    async def list_jenkins_jobs(
        instance_id: str,
        folder: Annotated[str, Query(max_length=1_000)] = "",
        query: Annotated[str | None, Query(max_length=200)] = None,
    ) -> dict[str, object]:
        return {
            "folder": folder.strip().strip("/"),
            "jobs": await jenkins_tool.list_jobs(instance_id, folder=folder, query=query),
        }

    @api.get("/jenkins/instances/{instance_id}/job")
    async def get_jenkins_job(
        instance_id: str,
        job: Annotated[str, Query(min_length=1, max_length=1_000)],
        include_parameter_options: bool = False,
    ) -> dict[str, dict[str, object]]:
        return {
            "job": await jenkins_tool.get_job(
                instance_id,
                job=job,
                include_parameter_options=include_parameter_options,
            )
        }

    @api.post("/jenkins/instances/{instance_id}/job/parameters")
    async def resolve_jenkins_job_parameters(
        instance_id: str,
        body: JenkinsParameterResolutionRequest,
        job: Annotated[str, Query(min_length=1, max_length=1_000)],
    ) -> dict[str, dict[str, object]]:
        return {
            "job": await jenkins_tool.get_job(
                instance_id,
                job=job,
                include_parameter_options=True,
                parameter_values=body.parameters,
            )
        }

    @api.get("/jenkins/instances/{instance_id}/builds")
    async def list_jenkins_builds(
        instance_id: str,
        job: Annotated[str, Query(min_length=1, max_length=1_000)],
        limit: Annotated[int, Query(ge=1, le=100)] = 30,
    ) -> dict[str, object]:
        return {
            "job": job.strip().strip("/"),
            "builds": await jenkins_tool.list_builds(instance_id, job=job, limit=limit),
        }

    @api.get("/jenkins/instances/{instance_id}/builds/{number}")
    async def get_jenkins_build(
        instance_id: str,
        number: int,
        job: Annotated[str, Query(min_length=1, max_length=1_000)],
    ) -> dict[str, dict[str, object]]:
        if number < 1:
            raise HTTPException(status_code=422, detail="build number must be positive")
        return {"build": await jenkins_tool.get_build(instance_id, job=job, number=number)}

    @api.post("/jenkins/instances/{instance_id}/builds", status_code=202)
    async def trigger_jenkins_build(
        instance_id: str,
        body: JenkinsBuildRequest,
        job: Annotated[str, Query(min_length=1, max_length=1_000)],
    ) -> dict[str, dict[str, object]]:
        return {
            "queue": await jenkins_tool.trigger_build(
                instance_id,
                job=job,
                parameters=body.parameters,
            )
        }

    @api.post("/jenkins/instances/{instance_id}/builds/{number}/stop")
    async def stop_jenkins_build(
        instance_id: str,
        number: int,
        job: Annotated[str, Query(min_length=1, max_length=1_000)],
    ) -> dict[str, dict[str, object]]:
        if number < 1:
            raise HTTPException(status_code=422, detail="build number must be positive")
        await jenkins_tool.stop_build(instance_id, job=job, number=number)
        return {"build": {"job": job.strip().strip("/"), "number": number, "stopped": True}}

    @api.get("/jenkins/instances/{instance_id}/queue")
    async def list_jenkins_queue(instance_id: str) -> dict[str, list[dict[str, object]]]:
        return {"queue": await jenkins_tool.list_queue(instance_id)}

    @api.post("/jenkins/instances/{instance_id}/queue/{queue_id}/cancel")
    async def cancel_jenkins_queue_item(
        instance_id: str,
        queue_id: int,
    ) -> dict[str, dict[str, object]]:
        if queue_id < 1:
            raise HTTPException(status_code=422, detail="queue id must be positive")
        await jenkins_tool.cancel_queue_item(instance_id, queue_id=queue_id)
        return {"queue": {"id": queue_id, "cancelled": True}}

    @api.get("/jenkins/instances/{instance_id}/builds/{number}/log")
    async def get_jenkins_build_log(
        instance_id: str,
        number: int,
        job: Annotated[str, Query(min_length=1, max_length=1_000)],
        start: Annotated[int, Query(ge=0)] = 0,
    ) -> dict[str, dict[str, object]]:
        if number < 1:
            raise HTTPException(status_code=422, detail="build number must be positive")
        log = await jenkins_tool.progressive_log(
            instance_id,
            job=job,
            number=number,
            start=start,
        )
        return {"log": {"job": job.strip().strip("/"), "number": number, **log}}

    @api.get("/services")
    async def list_services() -> dict[str, list[dict[str, object]]]:
        return {"services": await service_manager.list_services()}

    @api.post("/services", status_code=201)
    async def add_service(body: ServiceCreateRequest) -> dict[str, dict[str, object]]:
        service = await service_manager.add_service(_definition(body.name, body))
        return {"service": service}

    @api.put("/services/{name}")
    async def update_service(name: str, body: ServiceUpdateRequest) -> dict[str, dict[str, object]]:
        service = await service_manager.update_service(name, _definition(name, body))
        return {"service": service}

    @api.delete("/services/{name}")
    async def delete_service(name: str) -> dict[str, str]:
        await service_manager.delete_service(name)
        return {"deleted": name}

    @api.post("/services/{name}/start")
    async def start_service(name: str) -> dict[str, dict[str, object]]:
        return {"service": await service_manager.start(name)}

    @api.post("/services/{name}/stop")
    async def stop_service(name: str) -> dict[str, dict[str, object]]:
        return {"service": await service_manager.stop(name)}

    @api.post("/services/{name}/restart")
    async def restart_service(name: str) -> dict[str, dict[str, object]]:
        return {"service": await service_manager.restart(name)}

    @api.get("/services/{name}/logs")
    async def service_logs(name: str, tail: int = 500) -> dict[str, object]:
        if tail < 0:
            raise HTTPException(status_code=422, detail="tail must be non-negative")
        return {"service": name, "logs": await service_manager.get_logs(name, tail=tail)}

    @api.get("/ports")
    async def list_ports(
        port: Annotated[int | None, Query(ge=1, le=65535)] = None,
    ) -> dict[str, list[dict[str, object]]]:
        ports = await asyncio.to_thread(port_tool.list_ports, port)
        return {"ports": ports}

    @api.get("/processes")
    async def list_processes(
        query: Annotated[str | None, Query(max_length=200)] = None,
        limit: Annotated[int, Query(ge=1, le=500)] = 100,
    ) -> dict[str, list[dict[str, object]]]:
        processes = await asyncio.to_thread(
            process_tool.list_processes,
            query,
            limit,
            await managed_processes(),
        )
        return {"processes": processes}

    @api.get("/processes/{pid}")
    async def get_process(pid: int) -> dict[str, dict[str, object]]:
        if pid <= 1:
            raise HTTPException(status_code=422, detail="pid must be greater than 1")
        process = await asyncio.to_thread(
            process_tool.get_process,
            pid,
            await managed_processes(),
        )
        return {"process": process}

    @api.post("/processes/{pid}/terminate")
    async def terminate_process(
        pid: int,
        body: ProcessTerminateRequest,
    ) -> dict[str, dict[str, object]]:
        if pid <= 0:
            raise HTTPException(status_code=422, detail="pid must be positive")
        result = await asyncio.to_thread(
            port_tool.terminate,
            pid,
            expected_port=body.expected_port,
            force=body.force,
            timeout=body.timeout,
        )
        return {"result": result}

    app.include_router(api)

    async def handle_websocket_command(websocket: WebSocket, payload: object) -> None:
        """Execute one lifecycle command and keep protocol failures on the socket."""

        request_id = payload.get("id") if isinstance(payload, dict) else None
        if not isinstance(payload, dict):
            await websocket.send_json(
                {
                    "type": "command_result",
                    "id": request_id,
                    "ok": False,
                    "error": "Command must be a JSON object",
                }
            )
            return

        action = payload.get("action")
        service = payload.get("service")
        handlers = {
            "start": service_manager.start,
            "stop": service_manager.stop,
            "restart": service_manager.restart,
        }
        if not isinstance(action, str) or action not in handlers:
            await websocket.send_json(
                {
                    "type": "command_result",
                    "id": request_id,
                    "action": action,
                    "service": service,
                    "ok": False,
                    "error": f"Unsupported action: {action}",
                }
            )
            return
        if not isinstance(service, str) or not service.strip():
            await websocket.send_json(
                {
                    "type": "command_result",
                    "id": request_id,
                    "action": action,
                    "service": service,
                    "ok": False,
                    "error": "Service must be a non-empty string",
                }
            )
            return

        try:
            snapshot = await handlers[action](service)
        except Exception as exc:
            detail = str(exc.args[0]) if isinstance(exc, KeyError) and exc.args else str(exc)
            await websocket.send_json(
                {
                    "type": "command_result",
                    "id": request_id,
                    "action": action,
                    "service": service,
                    "ok": False,
                    "error": detail or type(exc).__name__,
                }
            )
            return

        await websocket.send_json(
            {
                "type": "command_result",
                "id": request_id,
                "action": action,
                "service": service,
                "ok": True,
                "data": snapshot,
            }
        )

    @app.websocket("/ws/events")
    async def events(websocket: WebSocket) -> None:
        supplied_token = websocket.query_params.get("token")
        if token is not None and (
            supplied_token is None or not secrets.compare_digest(supplied_token, token)
        ):
            await websocket.close(code=1008, reason="Invalid or missing token")
            return

        queue = service_manager.subscribe()
        event_task: asyncio.Task[dict[str, object]] | None = None
        receive_task: asyncio.Task[object] | None = None
        try:
            await websocket.accept()
            for service in await service_manager.list_services():
                await websocket.send_json(
                    {"type": "status", "service": service["name"], "data": service}
                )
            while True:
                event_task = asyncio.create_task(queue.get())
                receive_task = asyncio.create_task(websocket.receive_json())
                done, pending = await asyncio.wait(
                    {event_task, receive_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                if receive_task in done:
                    try:
                        command = receive_task.result()
                    except WebSocketDisconnect:
                        break
                    except (TypeError, ValueError) as exc:
                        await websocket.send_json(
                            {
                                "type": "command_result",
                                "id": None,
                                "ok": False,
                                "error": f"Invalid JSON command: {exc}",
                            }
                        )
                    else:
                        await handle_websocket_command(websocket, command)
                if event_task in done:
                    await websocket.send_json(event_task.result())
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        finally:
            pending_tasks = [
                task
                for task in (event_task, receive_task)
                if task is not None and not task.done()
            ]
            for task in pending_tasks:
                task.cancel()
            await asyncio.gather(*pending_tasks, return_exceptions=True)
            service_manager.unsubscribe(queue)

    static_dir = Path(__file__).with_name("static")
    index_template = (static_dir / "index.html").read_text(encoding="utf-8")
    theme_placeholder = "__SERVICE_CONSOLE_THEME__"
    app.mount("/static", StaticFiles(directory=static_dir, check_dir=False), name="static")

    @app.get("/", include_in_schema=False)
    async def index() -> HTMLResponse:
        theme = await asyncio.to_thread(ui_preferences.load_theme)
        html = index_template.replace(theme_placeholder, theme)
        html = html.replace(
            'data-theme-preference="system"',
            f'data-theme-preference="{theme}"',
        )
        if "data-theme-preference=" not in html:
            html = html.replace("<html", f'<html data-theme-preference="{theme}"', 1)
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    return app
