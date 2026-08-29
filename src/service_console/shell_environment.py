"""Recover a terminal-like environment for frozen macOS desktop launches."""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path


_ENVIRONMENT_MARKER = b"\x00SERVICE_CONSOLE_LOGIN_ENVIRONMENT_V1\x00"
_PRINT_ENVIRONMENT_COMMAND = (
    "printf '\\000SERVICE_CONSOLE_LOGIN_ENVIRONMENT_V1\\000'; /usr/bin/env -0"
)
_PRESERVED_PROCESS_KEYS = frozenset(
    {
        "OLDPWD",
        "PWD",
        "SHLVL",
        "TERM",
        "TERM_PROGRAM",
        "TERM_SESSION_ID",
        "_",
    }
)


def resolve_desktop_service_environment(
    environment: Mapping[str, str] | None = None,
    *,
    platform_name: str | None = None,
    frozen: bool | None = None,
    shell: str | Path | None = None,
    timeout: float = 8.0,
) -> dict[str, str]:
    """Return the child-process environment expected by a packaged desktop app.

    Terminal launches already inherit the user's shell environment. A frozen macOS
    app launched by Finder does not, so capture one interactive login shell once and
    merge its exported variables over the desktop process environment.
    """

    selected_environment = os.environ if environment is None else environment
    base_environment = _normalized_environment(selected_environment)
    selected_platform = platform_name if platform_name is not None else sys.platform
    selected_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if selected_platform != "darwin" or not selected_frozen:
        return base_environment
    if timeout <= 0:
        return base_environment

    shell_path = _select_login_shell(base_environment, shell)
    if shell_path is None:
        return base_environment

    capture_environment = dict(base_environment)
    capture_environment["TERM"] = "dumb"
    try:
        completed = subprocess.run(
            [str(shell_path), "-l", "-i", "-c", _PRINT_ENVIRONMENT_COMMAND],
            cwd=str(Path.home()),
            env=capture_environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return base_environment

    shell_environment = _parse_environment_output(completed.stdout)
    if not shell_environment.get("PATH"):
        return base_environment

    merged = dict(base_environment)
    merged.update(shell_environment)
    for key in _PRESERVED_PROCESS_KEYS:
        if key in base_environment:
            merged[key] = base_environment[key]
        else:
            merged.pop(key, None)
    return merged


def _select_login_shell(
    environment: Mapping[str, str],
    shell: str | Path | None,
) -> Path | None:
    candidates: list[str | Path] = []
    if shell is not None:
        candidates.append(shell)
    else:
        try:
            import pwd

            candidates.append(pwd.getpwuid(os.getuid()).pw_shell)
        except (ImportError, KeyError, OSError):
            pass
        configured_shell = environment.get("SHELL")
        if configured_shell:
            candidates.append(configured_shell)
        candidates.append("/bin/zsh")

    for candidate in candidates:
        path = Path(candidate).expanduser()
        if path.is_absolute() and path.is_file() and os.access(path, os.X_OK):
            return path
    return None


def _parse_environment_output(output: bytes) -> dict[str, str]:
    _prefix, marker, payload = output.rpartition(_ENVIRONMENT_MARKER)
    if not marker:
        return {}
    environment: dict[str, str] = {}
    for item in payload.split(b"\x00"):
        if b"=" not in item:
            continue
        encoded_key, encoded_value = item.split(b"=", 1)
        key = os.fsdecode(encoded_key)
        if not key or "\x00" in key or "=" in key:
            continue
        environment[key] = os.fsdecode(encoded_value)
    return environment


def _normalized_environment(environment: Mapping[str, str]) -> dict[str, str]:
    return {str(key): str(value) for key, value in dict(environment).items()}
