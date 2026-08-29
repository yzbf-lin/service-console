from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import service_console.shell_environment as shell_environment


def _executable_shell(tmp_path: Path) -> Path:
    shell = tmp_path / "login-shell"
    shell.write_text("#!/bin/sh\n", encoding="utf-8")
    shell.chmod(0o700)
    return shell


def test_packaged_macos_captures_interactive_login_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shell = _executable_shell(tmp_path)
    base = {
        "BASE_VALUE": "desktop",
        "PATH": "/usr/bin:/bin",
        "PWD": "/Applications",
        "TERM": "xterm-256color",
    }
    captured_calls: list[tuple[list[str], dict[str, object]]] = []
    payload = (
        b"profile banner\n"
        + shell_environment._ENVIRONMENT_MARKER
        + b"BASE_VALUE=login\x00"
        + b"PATH=/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin\x00"
        + b"PWD=/Users/me\x00"
        + b"TERM=dumb\x00"
        + b"UV_TOOL_DIR=/Users/me/.local/share/uv\x00"
        + b"logout banner\n"
    )

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        captured_calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, stdout=payload, stderr=b"")

    monkeypatch.setattr(shell_environment.subprocess, "run", fake_run)

    environment = shell_environment.resolve_desktop_service_environment(
        base,
        platform_name="darwin",
        frozen=True,
        shell=shell,
    )

    assert environment["PATH"] == "/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin"
    assert environment["BASE_VALUE"] == "login"
    assert environment["UV_TOOL_DIR"] == "/Users/me/.local/share/uv"
    assert environment["PWD"] == "/Applications"
    assert environment["TERM"] == "xterm-256color"
    command, kwargs = captured_calls[0]
    assert command[:4] == [str(shell), "-l", "-i", "-c"]
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["timeout"] == 8.0
    assert kwargs["env"]["TERM"] == "dumb"  # type: ignore[index]


@pytest.mark.parametrize(
    ("platform_name", "frozen"),
    [("darwin", False), ("linux", True), ("win32", True)],
)
def test_non_packaged_macos_keeps_process_environment_without_starting_shell(
    monkeypatch: pytest.MonkeyPatch,
    platform_name: str,
    frozen: bool,
) -> None:
    def fail_run(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("login shell should not be started")

    monkeypatch.setattr(shell_environment.subprocess, "run", fail_run)
    base = {"PATH": "/existing/bin", "EXISTING": "yes"}

    assert shell_environment.resolve_desktop_service_environment(
        base,
        platform_name=platform_name,
        frozen=frozen,
    ) == base


def test_login_shell_capture_failure_falls_back_to_process_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shell = _executable_shell(tmp_path)
    base = {"PATH": "/usr/bin", "EXISTING": "yes"}

    def timeout(*_args: object, **_kwargs: object) -> None:
        raise subprocess.TimeoutExpired(str(shell), 8)

    monkeypatch.setattr(shell_environment.subprocess, "run", timeout)

    assert shell_environment.resolve_desktop_service_environment(
        base,
        platform_name="darwin",
        frozen=True,
        shell=shell,
    ) == base


def test_login_shell_output_without_marker_is_not_trusted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shell = _executable_shell(tmp_path)
    base = {"PATH": "/usr/bin"}
    monkeypatch.setattr(
        shell_environment.subprocess,
        "run",
        lambda command, **_kwargs: subprocess.CompletedProcess(
            command,
            0,
            stdout=b"PATH=/untrusted/bin\x00",
            stderr=b"",
        ),
    )

    assert shell_environment.resolve_desktop_service_environment(
        base,
        platform_name="darwin",
        frozen=True,
        shell=shell,
    ) == base
