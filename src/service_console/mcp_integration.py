"""Codex registration and health checks for the local MCP sidecar."""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any

import httpx
from mcp import Client
from mcp.client.stdio import StdioServerParameters

from .runtime import load_runtime_connection, runtime_path


MCP_SERVER_NAME = "service-console"
MCP_TOOL_NAMES = (
    "project_apply_config",
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
)
_CODEX_CONFIGURATION_FIELDS = {
    "name",
    "enabled",
    "disabled_reason",
    "transport",
    "enabled_tools",
    "disabled_tools",
    "startup_timeout_sec",
    "tool_timeout_sec",
}
_STDIO_TRANSPORT_FIELDS = {"type", "command", "args", "env", "env_vars", "cwd"}
_HTTP_TRANSPORT_FIELDS = {
    "type",
    "url",
    "bearer_token_env_var",
    "http_headers",
    "env_http_headers",
    "http_headers_helper",
}


class McpIntegrationError(RuntimeError):
    """A concise error suitable for the settings UI."""


class McpIntegrationManager:
    """Inspect and update the current user's Codex MCP registration."""

    def __init__(
        self,
        data_dir: str | Path = "~/.service-console",
        *,
        runtime_file: str | Path | None = None,
        bridge_command: list[str] | tuple[str, ...] | None = None,
        codex_command: str | Path | None = None,
        command_timeout: float = 15.0,
        registration_enabled: bool = True,
    ) -> None:
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.runtime_file = (
            Path(runtime_file).expanduser().resolve()
            if runtime_file is not None
            else runtime_path(self.data_dir).resolve()
        )
        self._bridge_override = tuple(bridge_command) if bridge_command else None
        self._codex_override = Path(codex_command).expanduser() if codex_command else None
        self.command_timeout = command_timeout
        self.registration_enabled = registration_enabled
        self._last_test: dict[str, object] | None = None
        self._lock = RLock()

    def _bridge_launch(self) -> tuple[str, list[str], bool]:
        bridge_arguments = [
            "--runtime-file",
            str(self.runtime_file),
            "--data-dir",
            str(self.data_dir),
        ]
        if self._bridge_override:
            command, *arguments = self._bridge_override
            return command, [*arguments, *bridge_arguments], _is_executable(command)

        if getattr(sys, "frozen", False):
            executable = Path(sys.executable).resolve()
            helper_name = "Service Console MCP.exe" if os.name == "nt" else "Service Console MCP"
            helper = executable.with_name(helper_name)
            return str(helper), bridge_arguments, helper.is_file()

        module = Path(__file__).with_name("mcp_server.py")
        return (
            sys.executable,
            ["-m", "service_console.mcp_server", *bridge_arguments],
            module.is_file() and _is_executable(sys.executable),
        )

    def _codex_path(self) -> Path | None:
        if self._codex_override is not None:
            return self._codex_override if self._codex_override.is_file() else None

        environment_path = os.environ.get("CODEX_CLI_PATH", "").strip()
        discovered = shutil.which(environment_path or "codex")
        candidates = [
            Path(discovered) if discovered else None,
            Path.home() / ".local" / "bin" / "codex",
            Path.home() / ".local" / "bin" / "codex.exe",
            Path("/opt/homebrew/bin/codex"),
            Path("/usr/local/bin/codex"),
            Path("/Applications/ChatGPT.app/Contents/Resources/codex"),
            Path("/Applications/Codex.app/Contents/Resources/codex"),
        ]
        for candidate in candidates:
            if candidate is not None and candidate.is_file():
                return candidate
        return None

    def _codex_invocation(self, arguments: list[str]) -> list[str]:
        executable = self._codex_path()
        if executable is None:
            raise McpIntegrationError(
                "未找到 Codex CLI；仍可复制配置命令，在安装 Codex CLI 的终端中执行"
            )
        if os.name == "nt" and executable.suffix.lower() in {".bat", ".cmd"}:
            return _windows_batch_invocation(executable, arguments)
        return [str(executable), *arguments]

    def _run_codex(self, arguments: list[str]) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run(
                self._codex_invocation(arguments),
                capture_output=True,
                check=False,
                encoding="utf-8",
                errors="replace",
                timeout=self.command_timeout,
                shell=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise McpIntegrationError(f"Codex MCP 配置命令执行失败：{exc}") from exc

    def _registered_configuration(self) -> dict[str, Any] | None:
        result = self._run_codex(["mcp", "get", MCP_SERVER_NAME, "--json"])
        if result.returncode != 0:
            combined = f"{result.stdout}\n{result.stderr}".lower()
            if any(marker in combined for marker in ("not found", "does not exist", "no mcp server")):
                return None
            raise McpIntegrationError(_command_error(result, "读取 Codex MCP 配置失败"))
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise McpIntegrationError("Codex CLI 返回了无效的 MCP 配置") from exc
        if not isinstance(payload, dict):
            raise McpIntegrationError("Codex MCP 配置必须是 JSON 对象")
        transport = payload.get("transport")
        if not isinstance(transport, dict):
            raise McpIntegrationError("Codex MCP 配置缺少 transport 字段")
        return payload

    def _registration(self, command: str, arguments: list[str]) -> tuple[bool, bool]:
        if self._codex_path() is None:
            return False, False
        configuration = self._registered_configuration()
        if configuration is None:
            return False, False
        return True, _is_current_configuration(configuration, command, arguments)

    def _restore_configuration(self, configuration: dict[str, Any]) -> str | None:
        arguments = _configuration_add_arguments(configuration)
        if arguments is None:
            return "原配置包含当前版本无法自动恢复的选项"
        restored = self._run_codex(arguments)
        if restored.returncode != 0:
            return _command_error(restored, "原 Codex MCP 配置恢复失败")
        return None

    def _controller_ready(self) -> bool:
        try:
            connection = load_runtime_connection(self.runtime_file)
        except ValueError:
            return False
        if connection is None:
            return False
        try:
            response = httpx.get(
                f"{connection.base_url}/api/health",
                headers={"Authorization": f"Bearer {connection.token}"},
                timeout=1.5,
            )
        except httpx.HTTPError:
            return False
        return response.status_code == 200

    def _config_command(self, command: str, arguments: list[str]) -> str:
        values = ["codex", "mcp", "add", MCP_SERVER_NAME, "--", command, *arguments]
        return subprocess.list2cmdline(values) if os.name == "nt" else shlex.join(values)

    def status(self) -> dict[str, object]:
        """Return a token-free integration status for the settings UI."""

        with self._lock:
            command, arguments, bridge_available = self._bridge_launch()
            if not self.registration_enabled:
                return {
                    "state": "unavailable",
                    "transport": "stdio",
                    "controller_ready": False,
                    "bridge_available": False,
                    "codex_cli_available": self._codex_path() is not None,
                    "codex_registered": False,
                    "server_name": MCP_SERVER_NAME,
                    "bridge_command": None,
                    "bridge_args": arguments,
                    "config_snippet": None,
                    "tools": list(MCP_TOOL_NAMES),
                    "last_test": self._last_test,
                    "error": "MCP 一键集成仅在 Service Console 桌面应用中启用",
                }
            codex_available = self._codex_path() is not None
            registered = False
            current = False
            error: str | None = None
            # Codex registration is independent from the packaged Bridge file.  Keep
            # reporting a stale registration when an installation is incomplete so
            # the UI can still offer a safe removal action.
            if codex_available:
                try:
                    registered, current = self._registration(command, arguments)
                except McpIntegrationError as exc:
                    error = str(exc)

            if error:
                state = "error"
            elif registered and not current:
                state = "conflict"
            elif not bridge_available:
                state = "unavailable"
            elif current:
                state = "installed"
            else:
                state = "not_installed"

            return {
                "state": state,
                "transport": "stdio",
                "controller_ready": self._controller_ready(),
                "bridge_available": bridge_available,
                "codex_cli_available": codex_available,
                "codex_registered": registered,
                "server_name": MCP_SERVER_NAME,
                "bridge_command": command if bridge_available else None,
                "bridge_args": arguments,
                "config_snippet": self._config_command(command, arguments) if bridge_available else None,
                "tools": list(MCP_TOOL_NAMES),
                "last_test": self._last_test,
                "error": error,
            }

    def install(self) -> dict[str, object]:
        """Register the packaged sidecar, repairing a confirmed same-name conflict."""

        with self._lock:
            if not self.registration_enabled:
                raise McpIntegrationError("MCP 一键集成仅在 Service Console 桌面应用中启用")
            command, arguments, available = self._bridge_launch()
            if not available:
                raise McpIntegrationError("Service Console MCP Bridge 不存在，请重新安装应用")
            previous = self._registered_configuration()
            current = previous is not None and _is_current_configuration(
                previous,
                command,
                arguments,
            )
            if previous is not None and not current:
                if _configuration_add_arguments(previous) is None:
                    raise McpIntegrationError(
                        "同名 Codex MCP 配置包含无法安全恢复的选项，请先在 Codex 中手工处理冲突"
                    )
                removed = self._run_codex(["mcp", "remove", MCP_SERVER_NAME])
                if removed.returncode != 0:
                    raise McpIntegrationError(
                        _command_error(removed, "移除冲突的 Codex MCP 配置失败")
                    )
            if not current:
                result = self._run_codex(
                    ["mcp", "add", MCP_SERVER_NAME, "--", command, *arguments]
                )
                if result.returncode != 0:
                    detail = _command_error(result, "安装 Codex MCP 配置失败")
                    if previous is not None:
                        rollback_error = self._restore_configuration(previous)
                        detail += (
                            f"；{rollback_error}"
                            if rollback_error
                            else "；原有同名 MCP 配置已恢复"
                        )
                    raise McpIntegrationError(detail)
            return self.status()

    def remove(self) -> dict[str, object]:
        """Remove the confirmed same-name Codex registration."""

        with self._lock:
            if not self.registration_enabled:
                raise McpIntegrationError("MCP 一键集成仅在 Service Console 桌面应用中启用")
            command, arguments, _ = self._bridge_launch()
            registered, _current = self._registration(command, arguments)
            if registered:
                result = self._run_codex(["mcp", "remove", MCP_SERVER_NAME])
                if result.returncode != 0:
                    raise McpIntegrationError(_command_error(result, "移除 Codex MCP 配置失败"))
            self._last_test = None
            return self.status()

    def test(self) -> dict[str, object]:
        """Perform a real stdio handshake and call the read-only service_list tool."""

        with self._lock:
            if not self.registration_enabled:
                self._last_test = {
                    "ok": False,
                    "tested_at": datetime.now(UTC).isoformat(),
                    "error": "MCP 一键集成仅在 Service Console 桌面应用中启用",
                }
                return self.status()
            command, arguments, available = self._bridge_launch()
            tested_at = datetime.now(UTC).isoformat()
            if not available:
                self._last_test = {
                    "ok": False,
                    "tested_at": tested_at,
                    "error": "Service Console MCP Bridge 不存在",
                }
                return self.status()
            try:
                registered, current = self._registration(command, arguments)
            except McpIntegrationError as exc:
                self._last_test = {
                    "ok": False,
                    "tested_at": tested_at,
                    "error": str(exc),
                }
                return self.status()
            if not registered or not current:
                self._last_test = {
                    "ok": False,
                    "tested_at": tested_at,
                    "error": (
                        "Codex MCP 尚未注册"
                        if not registered
                        else "Codex MCP 注册与当前 Bridge 不一致或未启用"
                    ),
                }
                return self.status()
            try:
                discovered = asyncio.run(self._test_bridge(command, arguments))
            except Exception as exc:
                self._last_test = {
                    "ok": False,
                    "tested_at": tested_at,
                    "error": str(exc) or type(exc).__name__,
                }
            else:
                missing = sorted(set(MCP_TOOL_NAMES) - set(discovered))
                unexpected = sorted(set(discovered) - set(MCP_TOOL_NAMES))
                differences: list[str] = []
                if missing:
                    differences.append(f"缺少工具：{', '.join(missing)}")
                if unexpected:
                    differences.append(f"发现未记录工具：{', '.join(unexpected)}")
                self._last_test = {
                    "ok": not differences,
                    "tested_at": tested_at,
                    "error": "；".join(differences) or None,
                }
            return self.status()

    async def _test_bridge(self, command: str, arguments: list[str]) -> list[str]:
        parameters = StdioServerParameters(command=command, args=arguments)
        async with Client(parameters, read_timeout_seconds=self.command_timeout) as client:
            listed = await client.list_tools()
            result = await client.call_tool("service_list", {})
            if result.is_error:
                detail = "；".join(
                    str(getattr(item, "text", "")) for item in result.content if getattr(item, "text", "")
                )
                raise McpIntegrationError(detail or "MCP service_list 调用失败")
            return [tool.name for tool in listed.tools]


def _is_executable(value: str) -> bool:
    path = Path(value).expanduser()
    return path.is_file() and (os.name == "nt" or os.access(path, os.X_OK))


def _windows_batch_invocation(
    executable: Path,
    arguments: list[str],
) -> list[str]:
    """Invoke an npm-style Windows shim without sending values through cmd.exe.

    npm installs a ``.ps1`` shim next to each ``.cmd`` shim.  PowerShell's
    ``-File`` mode receives all following values as argv, so paths containing
    cmd.exe metacharacters remain data instead of becoming command syntax.
    """

    powershell_script = executable.with_suffix(".ps1")
    powershell = _windows_powershell_executable()
    if not powershell_script.is_file() or powershell is None:
        raise McpIntegrationError(
            "检测到 Codex 批处理启动器，但未找到可安全调用的同名 "
            "PowerShell 启动器；"
            "请重新安装 Codex CLI，或将 CODEX_CLI_PATH 指向 codex.exe"
        )
    return [
        powershell,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(powershell_script),
        *arguments,
    ]


def _windows_powershell_executable() -> str | None:
    for command in ("powershell.exe", "pwsh.exe"):
        discovered = shutil.which(command)
        if discovered:
            return discovered

    system_root = os.environ.get("SystemRoot", "").strip()
    if system_root:
        bundled = (
            Path(system_root)
            / "System32"
            / "WindowsPowerShell"
            / "v1.0"
            / "powershell.exe"
        )
        if bundled.is_file():
            return str(bundled)
    return None


def _is_current_configuration(
    configuration: dict[str, Any],
    command: str,
    arguments: list[str],
) -> bool:
    transport = configuration.get("transport")
    return (
        set(configuration) <= _CODEX_CONFIGURATION_FIELDS
        and configuration.get("name") in (None, MCP_SERVER_NAME)
        and configuration.get("enabled") is True
        and configuration.get("disabled_reason") is None
        and configuration.get("enabled_tools") is None
        and configuration.get("disabled_tools") is None
        and configuration.get("startup_timeout_sec") is None
        and configuration.get("tool_timeout_sec") is None
        and isinstance(transport, dict)
        and set(transport) <= _STDIO_TRANSPORT_FIELDS
        and transport.get("type") == "stdio"
        and transport.get("command") == command
        and transport.get("args") == arguments
        and transport.get("env") in (None, {})
        and transport.get("env_vars") in (None, [])
        and transport.get("cwd") in (None, "")
    )


def _configuration_add_arguments(configuration: dict[str, Any]) -> list[str] | None:
    if (
        not set(configuration) <= _CODEX_CONFIGURATION_FIELDS
        or configuration.get("name") not in (None, MCP_SERVER_NAME)
        or configuration.get("enabled") is not True
        or configuration.get("disabled_reason") is not None
        or configuration.get("enabled_tools") is not None
        or configuration.get("disabled_tools") is not None
        or configuration.get("startup_timeout_sec") is not None
        or configuration.get("tool_timeout_sec") is not None
    ):
        return None
    transport = configuration.get("transport")
    if not isinstance(transport, dict):
        return None
    return _transport_add_arguments(transport)


def _transport_add_arguments(transport: dict[str, Any]) -> list[str] | None:
    transport_type = transport.get("type")
    if transport_type == "stdio":
        command = transport.get("command")
        arguments = transport.get("args", [])
        environment = transport.get("env")
        if environment is None:
            environment = {}
        working_directory = transport.get("cwd")
        forwarded_environment = transport.get("env_vars")
        if forwarded_environment is None:
            forwarded_environment = []
        if (
            not set(transport) <= _STDIO_TRANSPORT_FIELDS
            or not isinstance(command, str)
            or not command
            or not isinstance(arguments, list)
            or not all(isinstance(value, str) for value in arguments)
            or not isinstance(environment, dict)
            or not all(
                isinstance(key, str)
                and bool(key)
                and "=" not in key
                and isinstance(value, str)
                for key, value in environment.items()
            )
            or working_directory not in (None, "")
            or forwarded_environment not in (None, [])
        ):
            return None
        env_arguments = [
            item
            for key, value in sorted(environment.items())
            for item in ("--env", f"{key}={value}")
        ]
        return [
            "mcp",
            "add",
            *env_arguments,
            MCP_SERVER_NAME,
            "--",
            command,
            *arguments,
        ]
    if transport_type in {"http", "streamable_http"}:
        url = transport.get("url")
        bearer = transport.get("bearer_token_env_var")
        if (
            not set(transport) <= _HTTP_TRANSPORT_FIELDS
            or not isinstance(url, str)
            or not url
            or (bearer not in (None, "") and not isinstance(bearer, str))
            or transport.get("http_headers") is not None
            or transport.get("env_http_headers") is not None
            or transport.get("http_headers_helper") is not None
        ):
            return None
        options = ["--url", url]
        if isinstance(bearer, str) and bearer:
            options.extend(["--bearer-token-env-var", bearer])
        return ["mcp", "add", *options, MCP_SERVER_NAME]
    return None


def _command_error(result: subprocess.CompletedProcess[str], fallback: str) -> str:
    detail = (result.stderr or result.stdout).strip()
    return f"{fallback}：{detail}" if detail else fallback
