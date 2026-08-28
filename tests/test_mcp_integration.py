from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

import service_console.mcp_integration as mcp_integration_module
from service_console.mcp_integration import McpIntegrationError, McpIntegrationManager
from service_console.mcp_integration import _windows_batch_invocation


def executable(path: Path) -> Path:
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o700)
    return path


def manager(tmp_path: Path) -> McpIntegrationManager:
    return McpIntegrationManager(
        tmp_path / "data",
        runtime_file=tmp_path / "controller.json",
        bridge_command=[str(executable(tmp_path / "Service Console MCP"))],
        codex_command=executable(tmp_path / "codex"),
    )


def codex_configuration(
    transport: dict[str, object],
    **overrides: object,
) -> dict[str, object]:
    configuration: dict[str, object] = {
        "name": "service-console",
        "enabled": True,
        "disabled_reason": None,
        "transport": transport,
        "enabled_tools": None,
        "disabled_tools": None,
        "startup_timeout_sec": None,
        "tool_timeout_sec": None,
    }
    configuration.update(overrides)
    return configuration


def current_configuration(integration: McpIntegrationManager) -> dict[str, object]:
    command, arguments, _ = integration._bridge_launch()
    return codex_configuration(
        {
            "type": "stdio",
            "command": command,
            "args": arguments,
            "env": {},
            "env_vars": [],
            "cwd": None,
        }
    )


def test_status_reports_a_token_free_stdio_command(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    integration = manager(tmp_path)
    monkeypatch.setattr(integration, "_registered_configuration", lambda: None)
    monkeypatch.setattr(integration, "_controller_ready", lambda: True)

    status = integration.status()

    assert status["state"] == "not_installed"
    assert status["controller_ready"] is True
    assert status["codex_cli_available"] is True
    assert status["bridge_args"] == [
        "--runtime-file",
        str(tmp_path / "controller.json"),
        "--data-dir",
        str((tmp_path / "data").resolve()),
    ]
    assert "service_list" in status["tools"]
    assert "Authorization" not in str(status)
    assert "Bearer " not in str(status)


def test_browser_controller_disables_desktop_only_registration(tmp_path: Path) -> None:
    integration = McpIntegrationManager(
        tmp_path / "data",
        runtime_file=tmp_path / "controller.json",
        bridge_command=[str(executable(tmp_path / "Service Console MCP"))],
        codex_command=executable(tmp_path / "codex"),
        registration_enabled=False,
    )

    status = integration.status()

    assert status["state"] == "unavailable"
    assert status["bridge_available"] is False
    assert status["config_snippet"] is None
    with pytest.raises(McpIntegrationError, match="仅在 Service Console 桌面应用"):
        integration.install()


def test_status_detects_an_existing_conflicting_registration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    integration = manager(tmp_path)
    conflict = True

    def configuration() -> dict[str, object]:
        command, arguments, _ = integration._bridge_launch()
        return codex_configuration(
            {"type": "stdio", "command": "/another/bridge", "args": []}
            if conflict
            else {"type": "stdio", "command": command, "args": arguments}
        )

    calls: list[list[str]] = []

    def run(arguments: list[str]) -> subprocess.CompletedProcess[str]:
        nonlocal conflict
        calls.append(arguments)
        if arguments[1] == "add":
            conflict = False
        return subprocess.CompletedProcess(arguments, 0, "", "")

    monkeypatch.setattr(integration, "_registered_configuration", configuration)
    monkeypatch.setattr(integration, "_run_codex", run)
    monkeypatch.setattr(integration, "_controller_ready", lambda: True)

    assert integration.status()["state"] == "conflict"
    assert integration.install()["state"] == "installed"
    assert [call[1] for call in calls] == ["remove", "add"]


def test_install_and_remove_are_idempotent(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    integration = manager(tmp_path)
    registered = False
    calls: list[list[str]] = []

    def configuration() -> dict[str, object] | None:
        if not registered:
            return None
        return current_configuration(integration)

    def run(arguments: list[str]) -> subprocess.CompletedProcess[str]:
        nonlocal registered
        calls.append(arguments)
        registered = arguments[1] == "add"
        return subprocess.CompletedProcess(arguments, 0, "", "")

    monkeypatch.setattr(integration, "_registered_configuration", configuration)
    monkeypatch.setattr(integration, "_run_codex", run)
    monkeypatch.setattr(integration, "_controller_ready", lambda: True)

    assert integration.install()["state"] == "installed"
    assert integration.install()["state"] == "installed"
    assert integration.remove()["state"] == "not_installed"
    assert integration.remove()["state"] == "not_installed"
    assert [call[1] for call in calls] == ["add", "remove"]


def test_conflict_install_restores_previous_transport_when_add_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    integration = manager(tmp_path)
    previous = codex_configuration(
        {
            "type": "stdio",
            "command": "/old bridge",
            "args": ["--old"],
            "env": {"PROFILE": "previous"},
        }
    )
    calls: list[list[str]] = []

    def run(arguments: list[str]) -> subprocess.CompletedProcess[str]:
        calls.append(arguments)
        if len(calls) == 2:
            return subprocess.CompletedProcess(arguments, 1, "", "new add failed")
        return subprocess.CompletedProcess(arguments, 0, "", "")

    monkeypatch.setattr(integration, "_registered_configuration", lambda: previous)
    monkeypatch.setattr(integration, "_run_codex", run)

    with pytest.raises(McpIntegrationError, match="原有同名 MCP 配置已恢复"):
        integration.install()

    assert [call[1] for call in calls] == ["remove", "add", "add"]
    assert calls[-1] == [
        "mcp",
        "add",
        "--env",
        "PROFILE=previous",
        "service-console",
        "--",
        "/old bridge",
        "--old",
    ]


def test_conflict_with_non_restorable_options_is_left_untouched(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    integration = manager(tmp_path)
    calls: list[list[str]] = []
    monkeypatch.setattr(
        integration,
        "_registered_configuration",
        lambda: codex_configuration(
            {
                "type": "stdio",
                "command": "/old bridge",
                "args": [],
                "cwd": "/custom/workspace",
            }
        ),
    )
    monkeypatch.setattr(
        integration,
        "_run_codex",
        lambda arguments: calls.append(arguments),
    )

    with pytest.raises(McpIntegrationError, match="无法安全恢复"):
        integration.install()

    assert calls == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("enabled", False),
        ("enabled_tools", ["service_list"]),
        ("disabled_tools", ["service_restart"]),
        ("startup_timeout_sec", 5.0),
        ("tool_timeout_sec", 30.0),
    ],
)
def test_non_default_codex_options_are_conflicts_and_are_not_removed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    integration = manager(tmp_path)
    configuration = current_configuration(integration)
    configuration[field] = value
    calls: list[list[str]] = []
    monkeypatch.setattr(integration, "_registered_configuration", lambda: configuration)
    monkeypatch.setattr(integration, "_run_codex", lambda arguments: calls.append(arguments))
    monkeypatch.setattr(integration, "_controller_ready", lambda: True)

    assert integration.status()["state"] == "conflict"
    with pytest.raises(McpIntegrationError, match="无法安全恢复"):
        integration.install()
    assert calls == []


def test_registration_with_extra_environment_is_not_current(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    integration = manager(tmp_path)
    configuration = current_configuration(integration)
    transport = configuration["transport"]
    assert isinstance(transport, dict)
    transport["env"] = {"SERVICE_CONSOLE_DESKTOP_EXECUTABLE": "/unexpected/app"}
    monkeypatch.setattr(integration, "_registered_configuration", lambda: configuration)
    monkeypatch.setattr(integration, "_controller_ready", lambda: True)

    assert integration.status()["state"] == "conflict"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("http_headers", {"X-Profile": "legacy"}),
        ("env_http_headers", {"Authorization": "LEGACY_TOKEN"}),
        ("http_headers_helper", "legacy-helper"),
    ],
)
def test_http_header_configuration_is_not_deleted_when_it_cannot_be_restored(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    integration = manager(tmp_path)
    transport: dict[str, object] = {
        "type": "streamable_http",
        "url": "https://example.test/mcp",
        "bearer_token_env_var": None,
        field: value,
    }
    configuration = codex_configuration(transport)
    calls: list[list[str]] = []
    monkeypatch.setattr(integration, "_registered_configuration", lambda: configuration)
    monkeypatch.setattr(integration, "_run_codex", lambda arguments: calls.append(arguments))

    with pytest.raises(McpIntegrationError, match="无法安全恢复"):
        integration.install()
    assert calls == []


def test_registered_configuration_preserves_codex_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    integration = manager(tmp_path)
    configuration = current_configuration(integration)
    configuration["enabled_tools"] = ["service_list"]
    monkeypatch.setattr(
        integration,
        "_run_codex",
        lambda arguments: subprocess.CompletedProcess(
            arguments,
            0,
            json.dumps(configuration),
            "",
        ),
    )

    assert integration._registered_configuration() == configuration


def test_windows_batch_invocation_keeps_cmd_metacharacters_in_argv(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Windows filenames permit &, ^, and %, while |, <, and > can still occur
    # in forwarded values and must likewise stay outside command-language parsing.
    shim_directory = tmp_path / "Codex &^% tools"
    shim_directory.mkdir()
    batch_shim = shim_directory / "codex.cmd"
    batch_shim.write_text("@echo off\r\n", encoding="utf-8")
    powershell_shim = shim_directory / "codex.ps1"
    powershell_shim.write_text(
        "$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\n",
        encoding="utf-8",
    )
    powershell = tmp_path / "Windows & PowerShell" / "powershell.exe"
    powershell.parent.mkdir()
    powershell.write_bytes(b"")
    monkeypatch.setattr(
        mcp_integration_module,
        "_windows_powershell_executable",
        lambda: str(powershell),
    )
    bridge_argument = r"C:\Service &^% Console\helper|input<output>.exe"
    arguments = ["mcp", "add", "service-console", "--", bridge_argument]

    invocation = _windows_batch_invocation(batch_shim, arguments)

    assert invocation == [
        str(powershell),
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(powershell_shim),
        *arguments,
    ]
    assert "cmd.exe" not in invocation


def test_windows_batch_invocation_rejects_an_unsafe_cmd_only_install(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    batch_shim = tmp_path / "codex.cmd"
    batch_shim.write_text("@echo off\r\n", encoding="utf-8")
    monkeypatch.setattr(
        mcp_integration_module,
        "_windows_powershell_executable",
        lambda: r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
    )

    with pytest.raises(McpIntegrationError, match="同名 PowerShell 启动器"):
        _windows_batch_invocation(batch_shim, ["mcp", "get", "service-console", "--json"])


def test_connection_test_records_real_bridge_result(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    integration = manager(tmp_path)
    monkeypatch.setattr(
        integration,
        "_registered_configuration",
        lambda: current_configuration(integration),
    )
    monkeypatch.setattr(integration, "_controller_ready", lambda: True)

    async def successful_test(_command: str, _arguments: list[str]) -> list[str]:
        return list(integration.status()["tools"])

    monkeypatch.setattr(integration, "_test_bridge", successful_test)

    status = integration.test()

    assert status["state"] == "installed"
    assert status["last_test"]["ok"] is True  # type: ignore[index]
    assert status["last_test"]["error"] is None  # type: ignore[index]


def test_connection_test_rejects_an_incomplete_tool_surface(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    integration = manager(tmp_path)
    monkeypatch.setattr(
        integration,
        "_registered_configuration",
        lambda: current_configuration(integration),
    )
    monkeypatch.setattr(integration, "_controller_ready", lambda: True)

    async def incomplete_test(_command: str, _arguments: list[str]) -> list[str]:
        return ["service_list"]

    monkeypatch.setattr(integration, "_test_bridge", incomplete_test)

    status = integration.test()

    assert status["last_test"]["ok"] is False  # type: ignore[index]
    assert "缺少工具" in str(status["last_test"]["error"])  # type: ignore[index]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("enabled", False),
        ("enabled_tools", ["service_list"]),
    ],
)
def test_connection_test_does_not_start_bridge_for_unusable_registration(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    integration = manager(tmp_path)
    configuration = current_configuration(integration)
    configuration[field] = value
    bridge_started = False
    monkeypatch.setattr(integration, "_registered_configuration", lambda: configuration)
    monkeypatch.setattr(integration, "_controller_ready", lambda: True)

    async def should_not_start(_command: str, _arguments: list[str]) -> list[str]:
        nonlocal bridge_started
        bridge_started = True
        return []

    monkeypatch.setattr(integration, "_test_bridge", should_not_start)

    status = integration.test()

    assert bridge_started is False
    assert status["state"] == "conflict"
    assert status["last_test"]["ok"] is False  # type: ignore[index]
    assert "不一致或未启用" in str(status["last_test"]["error"])  # type: ignore[index]
