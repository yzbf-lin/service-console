from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from service_console.desktop import DesktopController
from service_console.runtime import load_runtime_connection


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


def test_desktop_controller_honors_runtime_file_override(monkeypatch, tmp_path) -> None:
    runtime_file = tmp_path / "custom" / "desktop.json"
    monkeypatch.setenv("SERVICE_CONSOLE_RUNTIME_FILE", str(runtime_file))

    controller = DesktopController(tmp_path / "data")

    assert controller.runtime_path == runtime_file


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
