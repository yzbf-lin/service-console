from __future__ import annotations

import json
import signal
import sys
import time
from urllib.parse import parse_qs, urlparse

import service_console.desktop as desktop_module
from service_console.desktop import DesktopController
from service_console.runtime import load_runtime_connection
from service_console.update import UPDATE_RESTART_ARGUMENTS_ENV, encode_restart_arguments


def test_desktop_controller_uses_environment_token(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("SERVICE_CONSOLE_DESKTOP_TOKEN", "fixed-local-token")
    controller = DesktopController(tmp_path)
    controller.port = 43210

    parsed = urlparse(controller.url)
    assert parsed.hostname == "127.0.0.1"
    assert parsed.port == 43210
    assert parse_qs(parsed.query) == {"token": ["fixed-local-token"]}


def test_desktop_controller_defaults_to_random_token(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("SERVICE_CONSOLE_DESKTOP_TOKEN", raising=False)
    first = DesktopController(tmp_path)
    second = DesktopController(tmp_path)

    assert len(first.token) >= 32
    assert first.token != second.token


def test_desktop_controller_publishes_and_removes_runtime_descriptor(tmp_path) -> None:
    controller = DesktopController(
        tmp_path / "data",
        token="fixed-local-token",
        runtime_file=tmp_path / "controller.json",
    )
    controller.port = 43210

    controller._publish_runtime_connection()

    connection = load_runtime_connection(controller.runtime_path)
    assert connection is not None
    assert connection.instance_id == controller.instance_id
    assert connection.pid > 0
    assert connection.base_url == "http://127.0.0.1:43210"
    assert connection.token == "fixed-local-token"

    controller.stop()
    assert not controller.runtime_path.exists()


def test_desktop_keeps_runtime_descriptor_when_process_cleanup_is_unconfirmed(tmp_path) -> None:
    controller = DesktopController(
        tmp_path / "data",
        token="fixed-local-token",
        runtime_file=tmp_path / "controller.json",
    )
    controller.port = 43210
    controller._publish_runtime_connection()

    class FinishedThread:
        def is_alive(self) -> bool:
            return False

    class FailedManager:
        shutdown_succeeded = False

    controller._thread = FinishedThread()  # type: ignore[assignment]
    controller._service_manager = FailedManager()  # type: ignore[assignment]
    controller.stop()

    assert controller.runtime_path.exists()


def test_desktop_controller_honors_runtime_file_override(monkeypatch, tmp_path) -> None:
    runtime_file = tmp_path / "custom" / "desktop.json"
    monkeypatch.setenv("SERVICE_CONSOLE_RUNTIME_FILE", str(runtime_file))

    controller = DesktopController(tmp_path / "data")

    assert controller.runtime_path == runtime_file


def test_desktop_controller_resolves_service_environment_once(monkeypatch, tmp_path) -> None:
    calls = 0

    def fake_environment() -> dict[str, str]:
        nonlocal calls
        calls += 1
        return {"PATH": "/opt/homebrew/bin:/usr/bin", "UV_HOME": "/Users/me/.local/share/uv"}

    monkeypatch.setattr(desktop_module, "resolve_desktop_service_environment", fake_environment)

    controller = DesktopController(tmp_path)

    assert controller.service_environment == {
        "PATH": "/opt/homebrew/bin:/usr/bin",
        "UV_HOME": "/Users/me/.local/share/uv",
    }
    assert calls == 1


def test_desktop_stop_continues_when_runtime_cleanup_fails(monkeypatch, tmp_path) -> None:
    controller = DesktopController(tmp_path)

    class FakeServer:
        should_exit = False

    server = FakeServer()
    controller._server = server

    def fail_cleanup(*_args) -> None:
        raise OSError("fixture cleanup failure")

    monkeypatch.setattr("service_console.desktop.remove_runtime_connection", fail_cleanup)

    controller.stop()

    assert server.should_exit is True


def test_desktop_update_exit_closes_window_and_stops_server(tmp_path) -> None:
    controller = DesktopController(tmp_path)

    class FakeServer:
        should_exit = False

    class FakeWindow:
        destroyed = False

        def destroy(self) -> None:
            self.destroyed = True

    server = FakeServer()
    window = FakeWindow()
    controller._server = server
    controller.attach_window(window)

    controller._close_for_update()

    assert window.destroyed is True
    assert server.should_exit is True


def test_desktop_signal_handler_uses_window_close_path_and_restores_handler(tmp_path) -> None:
    controller = DesktopController(tmp_path)

    class FakeServer:
        should_exit = False

    class FakeWindow:
        destroyed = False

        def destroy(self) -> None:
            self.destroyed = True

    server = FakeServer()
    window = FakeWindow()
    controller._server = server  # type: ignore[assignment]
    controller.attach_window(window)
    previous = signal.getsignal(signal.SIGTERM)

    with desktop_module._desktop_signal_handlers(controller):
        handler = signal.getsignal(signal.SIGTERM)
        assert callable(handler)
        handler(signal.SIGTERM, None)

    assert signal.getsignal(signal.SIGTERM) is previous
    assert window.destroyed is True
    assert server.should_exit is True


def test_run_desktop_wires_window_close_signal_and_final_shutdown(monkeypatch, tmp_path) -> None:
    calls: list[str] = []

    class FakeEvent:
        def __init__(self) -> None:
            self.handlers: list[object] = []

        def __iadd__(self, handler: object):
            self.handlers.append(handler)
            return self

        def emit(self) -> None:
            for handler in self.handlers:
                handler()  # type: ignore[operator]

    class FakeWindow:
        def __init__(self) -> None:
            self.events = type("Events", (), {"shown": FakeEvent(), "closed": FakeEvent()})()

    window = FakeWindow()

    class FakeController:
        _service_manager = None
        url = "http://127.0.0.1:12345/?token=fixture"

        def __init__(self, *_args, **_kwargs) -> None:
            calls.append("init")

        def start(self) -> None:
            calls.append("start")

        def attach_window(self, _window: object) -> None:
            calls.append("attach")

        def mark_application_ready(self, *_args: object) -> None:
            calls.append("shown")

        def request_stop(self, *_args: object) -> None:
            calls.append("request-stop")

        def request_application_exit(self, *_args: object) -> None:
            calls.append("signal-exit")
            self.request_stop()

        def stop(self) -> None:
            calls.append("stop")

    class FakeWebview:
        @staticmethod
        def create_window(*_args, **_kwargs):
            return window

        @staticmethod
        def start(*, debug: bool) -> None:
            assert debug is False
            window.events.shown.emit()
            handler = signal.getsignal(signal.SIGTERM)
            assert callable(handler)
            handler(signal.SIGTERM, None)
            window.events.closed.emit()

    monkeypatch.setattr(desktop_module, "DesktopController", FakeController)
    monkeypatch.setattr(desktop_module, "_load_webview", lambda: FakeWebview())

    desktop_module.run_desktop(tmp_path)

    assert calls == [
        "init",
        "start",
        "attach",
        "shown",
        "signal-exit",
        "request-stop",
        "request-stop",
        "stop",
    ]


def test_desktop_stop_uses_guardian_when_server_thread_is_stuck(tmp_path) -> None:
    controller = DesktopController(tmp_path, shutdown_timeout=0.25)

    class FakeServer:
        should_exit = False
        force_exit = False

    class StuckThread:
        def __init__(self) -> None:
            self.join_timeouts: list[float | None] = []

        def is_alive(self) -> bool:
            return True

        def join(self, timeout: float | None = None) -> None:
            self.join_timeouts.append(timeout)

    class FakeManager:
        emergency_calls = 0

        def emergency_shutdown(self) -> None:
            self.emergency_calls += 1

    server = FakeServer()
    thread = StuckThread()
    manager = FakeManager()
    controller._server = server  # type: ignore[assignment]
    controller._thread = thread  # type: ignore[assignment]
    controller._service_manager = manager  # type: ignore[assignment]

    controller.stop()

    assert thread.join_timeouts == [0.25, 1.0]
    assert manager.emergency_calls == 1
    assert server.should_exit is True
    assert server.force_exit is True


def test_desktop_marks_update_ready_after_shown_window_is_stable(tmp_path) -> None:
    ready_file = tmp_path / "updates with spaces" / "install-update.ready"
    controller = DesktopController(
        tmp_path,
        update_ready_file=ready_file,
        update_ready_delay=0,
    )

    class FakeServer:
        should_exit = False

    class FakeThread:
        def is_alive(self) -> bool:
            return True

    controller._server = FakeServer()  # type: ignore[assignment]
    controller._thread = FakeThread()  # type: ignore[assignment]

    controller.mark_application_ready()

    deadline = time.monotonic() + 2
    while not ready_file.is_file() and time.monotonic() < deadline:
        time.sleep(0.01)
    payload = json.loads(ready_file.read_text(encoding="utf-8"))
    assert payload["pid"] > 0
    assert payload["version"]
    assert payload["ready_at"]


def test_desktop_does_not_mark_update_ready_after_shutdown(tmp_path) -> None:
    ready_file = tmp_path / "install-update.ready"
    controller = DesktopController(
        tmp_path,
        update_ready_file=ready_file,
        update_ready_delay=60,
    )

    class FakeServer:
        should_exit = False

    controller._server = FakeServer()  # type: ignore[assignment]
    controller.mark_application_ready()
    controller.stop()

    assert not ready_file.exists()


def test_desktop_main_restores_helper_arguments_with_spaces(monkeypatch, tmp_path) -> None:
    arguments = [
        "--data-dir",
        str(tmp_path / "data directory"),
        "--runtime-file",
        str(tmp_path / "runtime descriptor.json"),
        "--debug",
    ]
    monkeypatch.setenv(UPDATE_RESTART_ARGUMENTS_ENV, encode_restart_arguments(arguments))
    monkeypatch.setattr(sys, "argv", ["Service Console"])
    captured: dict[str, object] = {}

    def fake_run_desktop(data_dir, **kwargs) -> None:
        captured["data_dir"] = data_dir
        captured.update(kwargs)

    monkeypatch.setattr(desktop_module, "run_desktop", fake_run_desktop)

    assert desktop_module.main() == 0
    assert captured == {
        "data_dir": str(tmp_path / "data directory"),
        "width": 1440,
        "height": 900,
        "debug": True,
        "runtime_file": str(tmp_path / "runtime descriptor.json"),
    }
    assert sys.argv[1:] == arguments
    assert UPDATE_RESTART_ARGUMENTS_ENV not in desktop_module.os.environ
