from __future__ import annotations

import argparse
import os
from typing import Any

import pytest

from service_console import cli
from service_console.runtime import RuntimeConnection, write_runtime_connection


@pytest.fixture(autouse=True)
def isolate_desktop_runtime_file(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """Keep CLI tests independent from a real desktop instance on the host."""

    monkeypatch.delenv("SERVICE_CONSOLE_URL", raising=False)
    monkeypatch.delenv("SERVICE_CONSOLE_TOKEN", raising=False)
    monkeypatch.setenv("SERVICE_CONSOLE_RUNTIME_FILE", str(tmp_path / "missing-controller.json"))


def test_cli_discovers_running_desktop_controller(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    runtime_file = tmp_path / "controller.json"
    write_runtime_connection(
        runtime_file,
        RuntimeConnection(
            instance_id="desktop-one",
            pid=os.getpid(),
            base_url="http://127.0.0.1:43210",
            token="desktop-token",
            started_at="2026-08-28T00:00:00+00:00",
        ),
    )
    captured: dict[str, object] = {}

    def fake_request(args, method, path, *, json=None):
        captured.update(url=args.url, token=args.token, method=method, path=path)
        return {"services": []}

    monkeypatch.setattr(cli, "_request", fake_request)

    assert cli.main(["--runtime-file", str(runtime_file), "list"]) == 0
    assert captured == {
        "url": "http://127.0.0.1:43210",
        "token": "desktop-token",
        "method": "GET",
        "path": "/api/services",
    }


def test_explicit_url_does_not_reuse_desktop_token(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    runtime_file = tmp_path / "controller.json"
    write_runtime_connection(
        runtime_file,
        RuntimeConnection(
            instance_id="desktop-one",
            pid=os.getpid(),
            base_url="http://127.0.0.1:43210",
            token="must-not-leak",
            started_at="2026-08-28T00:00:00+00:00",
        ),
    )
    captured: dict[str, object] = {}

    def fake_request(args, _method, _path, *, json=None):
        captured.update(url=args.url, token=args.token)
        return {"services": []}

    monkeypatch.setattr(cli, "_request", fake_request)

    assert cli.main(
        [
            "--url",
            "http://127.0.0.1:9999",
            "--runtime-file",
            str(runtime_file),
            "list",
        ]
    ) == 0
    assert captured == {"url": "http://127.0.0.1:9999", "token": None}


def test_ports_command_filters_and_prints_owners(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[tuple[str, str, dict[str, object] | None]] = []

    def fake_request(
        _args: argparse.Namespace,
        method: str,
        path: str,
        *,
        json: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        calls.append((method, path, json))
        return {
            "ports": [
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
        }

    monkeypatch.setattr(cli, "_request", fake_request)

    assert cli.main(["ports", "--port", "8123"]) == 0
    assert calls == [("GET", "/api/ports?port=8123", None)]
    output = capsys.readouterr().out
    assert "PROTO" in output
    assert "127.0.0.1" in output
    assert "8123" in output
    assert "321" in output
    assert "python app.py" in output


def test_kill_process_command_sends_safety_options(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    calls: list[tuple[str, str, dict[str, object] | None]] = []

    def fake_request(
        _args: argparse.Namespace,
        method: str,
        path: str,
        *,
        json: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        calls.append((method, path, json))
        return {
            "result": {
                "pid": 321,
                "expected_port": 8123,
                "action": "kill",
                "terminated": True,
                "force": True,
                "exit_code": -9,
            }
        }

    monkeypatch.setattr(cli, "_request", fake_request)

    assert cli.main(
        ["kill-process", "321", "--port", "8123", "--force", "--timeout", "0.25"]
    ) == 0
    assert calls == [
        (
            "POST",
            "/api/processes/321/terminate",
            {"expected_port": 8123, "force": True, "timeout": 0.25},
        )
    ]
    assert capsys.readouterr().out == "Process 321 on port 8123: killed\n"


@pytest.mark.parametrize(
    "argv",
    [
        ["ports", "--port", "0"],
        ["ports", "--port", "65536"],
        ["kill-process", "0"],
        ["kill-process", "1", "--timeout", "0"],
        ["kill-process", "1", "--timeout", "-1"],
        ["kill-process", "1", "--timeout", "nan"],
    ],
)
def test_port_commands_reject_invalid_arguments(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as exc_info:
        cli.main(argv)
    assert exc_info.value.code == 2
