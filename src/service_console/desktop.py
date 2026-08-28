"""Native pywebview shell for the Service Console dashboard."""

from __future__ import annotations

import argparse
import os
import secrets
import sys
import threading
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import uvicorn

from service_console.api import create_app
from service_console.runtime import (
    RuntimeConnection,
    remove_runtime_connection,
    runtime_path,
    write_runtime_connection,
)


class DesktopError(RuntimeError):
    """A concise desktop startup error."""


class DesktopController:
    """Run the existing FastAPI application on a private random loopback port."""

    def __init__(
        self,
        data_dir: str | Path,
        *,
        startup_timeout: float = 15.0,
        token: str | None = None,
        runtime_file: str | Path | None = None,
    ) -> None:
        self.data_dir = Path(data_dir).expanduser()
        self.startup_timeout = startup_timeout
        environment_token = os.environ.get("SERVICE_CONSOLE_DESKTOP_TOKEN", "").strip()
        self.token = token or environment_token or secrets.token_urlsafe(32)
        self.instance_id = secrets.token_urlsafe(16)
        runtime_override = os.environ.get("SERVICE_CONSOLE_RUNTIME_FILE", "").strip()
        selected_runtime = runtime_file or runtime_override
        self.runtime_path = Path(selected_runtime).expanduser() if selected_runtime else runtime_path()
        self.port: int | None = None
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self._listener = None
        self._error: BaseException | None = None
        self._stop_lock = threading.Lock()
        self._stopped = False

    @property
    def base_url(self) -> str:
        if self.port is None:
            raise DesktopError("Desktop controller has not started")
        return f"http://127.0.0.1:{self.port}"

    @property
    def url(self) -> str:
        query = urlencode({"token": self.token})
        return f"{self.base_url}/?{query}"

    def start(self) -> None:
        if self._thread is not None:
            return

        application = create_app(data_dir=self.data_dir, token=self.token)
        config = uvicorn.Config(
            application,
            host="127.0.0.1",
            port=0,
            log_level="warning",
            access_log=False,
        )
        self._server = uvicorn.Server(config)
        self._listener = config.bind_socket()
        self.port = int(self._listener.getsockname()[1])
        self._thread = threading.Thread(
            target=self._serve,
            name="service-console-desktop-server",
            daemon=False,
        )
        self._thread.start()

        try:
            self._wait_until_ready()
            self._publish_runtime_connection()
        except BaseException:
            self.stop()
            raise

    def _publish_runtime_connection(self) -> None:
        connection = RuntimeConnection(
            instance_id=self.instance_id,
            pid=os.getpid(),
            base_url=self.base_url,
            token=self.token,
            started_at=datetime.now(UTC).isoformat(),
        )
        try:
            write_runtime_connection(self.runtime_path, connection)
        except (OSError, ValueError) as exc:
            raise DesktopError(f"Unable to publish desktop controller descriptor: {exc}") from exc

    def _serve(self) -> None:
        assert self._server is not None
        assert self._listener is not None
        try:
            self._server.run(sockets=[self._listener])
        except BaseException as exc:  # surfaced on the UI thread by _wait_until_ready
            self._error = exc
        finally:
            self._listener.close()

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + self.startup_timeout
        request = Request(
            f"http://127.0.0.1:{self.port}/api/health",
            headers={"Authorization": f"Bearer {self.token}"},
        )
        while time.monotonic() < deadline:
            if self._error is not None:
                raise DesktopError(f"Desktop controller startup failed: {self._error}") from self._error
            if self._thread is not None and not self._thread.is_alive():
                raise DesktopError("Desktop controller exited during startup")
            try:
                with urlopen(request, timeout=0.35) as response:
                    if response.status == 200:
                        return
            except (OSError, TimeoutError, URLError):
                time.sleep(0.05)
        raise DesktopError(f"Desktop controller did not become ready within {self.startup_timeout:g} seconds")

    def request_stop(self, *_args: object) -> None:
        """Ask Uvicorn to run its graceful lifespan shutdown."""

        if self._server is not None:
            self._server.should_exit = True

    def stop(self) -> None:
        """Wait for FastAPI shutdown, which stops every managed child process."""

        with self._stop_lock:
            if self._stopped:
                return
            self._stopped = True
            try:
                remove_runtime_connection(self.runtime_path, self.instance_id)
            except OSError:
                # Descriptor cleanup must never prevent the managed processes from stopping.
                pass
            self.request_stop()
            if self._thread is not None and self._thread.is_alive():
                self._thread.join()
            elif self._listener is not None:
                self._listener.close()


def _load_webview() -> ModuleType:
    try:
        import webview
    except ImportError as exc:
        raise DesktopError(
            "Desktop dependencies are missing; install them with `uv sync --group desktop`"
        ) from exc
    return webview


def run_desktop(
    data_dir: str | Path = "~/.service-console",
    *,
    width: int = 1440,
    height: int = 900,
    debug: bool = False,
    runtime_file: str | Path | None = None,
) -> None:
    """Open the dashboard in a native window and own its local controller."""

    webview = _load_webview()
    controller = DesktopController(data_dir, runtime_file=runtime_file)
    controller.start()
    try:
        window = webview.create_window(
            "Service Console",
            controller.url,
            width=max(900, width),
            height=max(640, height),
            min_size=(760, 560),
            text_select=True,
        )
        window.events.closed += controller.request_stop
        webview.start(debug=debug)
    finally:
        controller.stop()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="service-console-desktop")
    parser.add_argument("--data-dir", default="~/.service-console")
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--runtime-file")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        run_desktop(
            data_dir=args.data_dir,
            width=args.width,
            height=args.height,
            debug=args.debug,
            runtime_file=args.runtime_file,
        )
    except DesktopError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
