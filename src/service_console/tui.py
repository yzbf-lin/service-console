"""Terminal interface for a remote Service Console server."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import httpx
import websockets
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import DataTable, Footer, Header, RichLog, Static

from .cli import _format_log, _headers, _service_value, _websocket_url


def _uptime(service: dict[str, object]) -> str:
    if _service_value(service, "state") not in {"RUNNING", "STOPPING"}:
        return "-"
    started_at = _service_value(service, "started_at", None)
    if not isinstance(started_at, str):
        return "-"
    try:
        started = datetime.fromisoformat(started_at)
        if started.tzinfo is None:
            started = started.replace(tzinfo=UTC)
        seconds = max(0, int((datetime.now(UTC) - started).total_seconds()))
    except ValueError:
        return "-"
    return str(timedelta(seconds=seconds))


def _memory(value: object) -> str:
    try:
        size = int(value)
    except (TypeError, ValueError):
        return "-"
    if size < 1024:
        return f"{size} B"
    if size < 1024**2:
        return f"{size / 1024:.1f} KiB"
    if size < 1024**3:
        return f"{size / 1024**2:.1f} MiB"
    return f"{size / 1024**3:.1f} GiB"


class ServiceConsoleTUI(App[None]):
    """Monitor and control services through HTTP and WebSocket APIs."""

    TITLE = "Service Console"
    CSS = """
    #connection {
        height: 1;
        padding: 0 1;
        color: $text-muted;
    }
    #services {
        height: 45%;
        border: round $primary;
    }
    #logs {
        height: 1fr;
        border: round $secondary;
        padding: 0 1;
    }
    """
    BINDINGS = [
        Binding("s", "start_service", "Start"),
        Binding("x", "stop_service", "Stop"),
        Binding("r", "restart_service", "Restart"),
        Binding("q", "quit", "Quit"),
    ]

    def __init__(self, url: str, token: str | None = None) -> None:
        super().__init__()
        self.base_url = url.rstrip("/")
        self.token = token
        self.selected_service: str | None = None
        self.client: httpx.AsyncClient | None = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield Static(f"Connecting to {self.base_url}…", id="connection")
        yield DataTable(id="services", cursor_type="row", zebra_stripes=True)
        yield RichLog(id="logs", wrap=True, highlight=True, markup=False)
        yield Footer()

    async def on_mount(self) -> None:
        table = self.query_one("#services", DataTable)
        table.add_columns("Name", "State", "PID", "Uptime", "CPU", "Memory", "Command")
        table.focus()
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=_headers(self.token),
            timeout=30,
        )
        await self._refresh_services()
        self.run_worker(self._listen_events(), name="events", group="events", exclusive=True)

    async def on_unmount(self) -> None:
        if self.client is not None:
            await self.client.aclose()

    async def _json_request(self, method: str, path: str) -> dict[str, object]:
        if self.client is None:
            raise RuntimeError("HTTP client is not ready")
        response = await self.client.request(method, path)
        if response.is_error:
            try:
                detail = response.json().get("detail", response.text)
            except ValueError:
                detail = response.text
            raise RuntimeError(f"HTTP {response.status_code}: {detail}")
        return response.json()

    async def _refresh_services(self) -> None:
        try:
            payload = await self._json_request("GET", "/api/services")
        except (httpx.RequestError, RuntimeError, ValueError) as exc:
            self.query_one("#connection", Static).update(f"Disconnected: {exc}")
            return

        services = payload.get("services", [])
        if not isinstance(services, list):
            services = []

        table = self.query_one("#services", DataTable)
        previous = self.selected_service
        table.clear()
        names: list[str] = []
        for service in services:
            if not isinstance(service, dict):
                continue
            name = str(_service_value(service, "name", ""))
            if not name:
                continue
            names.append(name)
            table.add_row(
                name,
                str(_service_value(service, "state")),
                str(_service_value(service, "pid")),
                _uptime(service),
                f"{float(_service_value(service, 'cpu_percent', 0)):.1f}%",
                _memory(_service_value(service, "memory_rss", 0)),
                str(_service_value(service, "command")),
                key=name,
            )

        self.query_one("#connection", Static).update(f"Connected to {self.base_url}")
        if not names:
            self.selected_service = None
            self.query_one("#logs", RichLog).clear()
            return

        self.selected_service = previous if previous in names else names[0]
        table.move_cursor(row=names.index(self.selected_service))
        if self.selected_service != previous:
            await self._load_logs(self.selected_service)

    async def _load_logs(self, name: str) -> None:
        try:
            encoded_name = quote(name, safe="")
            payload = await self._json_request("GET", f"/api/services/{encoded_name}/logs?tail=500")
        except (httpx.RequestError, RuntimeError, ValueError) as exc:
            self.notify(str(exc), title="Logs", severity="error")
            return
        if name != self.selected_service:
            return
        widget = self.query_one("#logs", RichLog)
        widget.clear()
        logs = payload.get("logs", [])
        if isinstance(logs, list):
            for entry in logs:
                widget.write(_format_log(entry))

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        name = str(event.row_key.value)
        if not name or name == self.selected_service:
            return
        self.selected_service = name
        self.run_worker(self._load_logs(name), group="logs", exclusive=True)

    async def _listen_events(self) -> None:
        while True:
            try:
                async with websockets.connect(_websocket_url(self.base_url, self.token)) as socket:
                    self.query_one("#connection", Static).update(f"Connected to {self.base_url}")
                    async for raw_event in socket:
                        event = json.loads(raw_event)
                        if not isinstance(event, dict):
                            continue
                        if event.get("type") == "status":
                            await self._refresh_services()
                        elif event.get("type") == "log" and event.get("service") == self.selected_service:
                            self.query_one("#logs", RichLog).write(_format_log(event.get("data")))
            except asyncio.CancelledError:
                raise
            except (OSError, ValueError, websockets.WebSocketException) as exc:
                self.query_one("#connection", Static).update(f"Event stream disconnected: {exc}")
                await asyncio.sleep(2)

    def _run_action(self, action: str) -> None:
        if self.selected_service is None:
            self.notify("Select a service first", severity="warning")
            return
        self.run_worker(self._control(action), group="control", exclusive=True)

    async def _control(self, action: str) -> None:
        name = self.selected_service
        if name is None:
            return
        try:
            encoded_name = quote(name, safe="")
            await self._json_request("POST", f"/api/services/{encoded_name}/{action}")
            await self._refresh_services()
            self.notify(f"{name}: {action} requested")
        except (httpx.RequestError, RuntimeError, ValueError) as exc:
            self.notify(str(exc), title=action.title(), severity="error")

    def action_start_service(self) -> None:
        self._run_action("start")

    def action_stop_service(self) -> None:
        self._run_action("stop")

    def action_restart_service(self) -> None:
        self._run_action("restart")


def run_tui(url: str, token: str | None = None) -> None:
    ServiceConsoleTUI(url, token).run()
