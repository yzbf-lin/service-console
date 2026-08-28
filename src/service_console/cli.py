"""Command-line client for Service Console."""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import math
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

import httpx

from .runtime import load_runtime_connection, runtime_path


DEFAULT_URL = "http://127.0.0.1:8787"


class ClientError(RuntimeError):
    """A concise error suitable for command-line output."""


def _resolve_connection(args: argparse.Namespace) -> None:
    """Resolve an unspecified client endpoint from the running desktop instance."""

    if args.command_name == "serve" or args.url:
        return
    try:
        connection = load_runtime_connection(args.runtime_file)
    except ValueError as exc:
        raise ClientError(f"Invalid desktop controller descriptor: {exc}") from exc
    if connection is None:
        args.url = DEFAULT_URL
        return
    args.url = connection.base_url
    if not args.token:
        args.token = connection.token


def _port_number(value: str) -> int:
    port = int(value)
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def _positive_pid(value: str) -> int:
    pid = int(value)
    if pid <= 0:
        raise argparse.ArgumentTypeError("PID must be positive")
    return pid


def _positive_timeout(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("timeout must be a finite positive number")
    return number


def _headers(token: str | None) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


def _websocket_url(base_url: str, token: str | None) -> str:
    parts = urlsplit(base_url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    path = f"{parts.path.rstrip('/')}/ws/events"
    query = urlencode({"token": token}) if token else ""
    return urlunsplit((scheme, parts.netloc, path, query, ""))


def _request(
    args: argparse.Namespace,
    method: str,
    path: str,
    *,
    json: dict[str, object] | None = None,
) -> dict[str, object]:
    try:
        response = httpx.request(
            method,
            f"{args.url.rstrip('/')}{path}",
            headers=_headers(args.token),
            json=json,
            timeout=60,
        )
    except httpx.RequestError as exc:
        raise ClientError(f"Unable to reach {args.url}: {exc}") from exc

    if response.is_error:
        try:
            detail = response.json().get("detail", response.text)
        except ValueError:
            detail = response.text
        raise ClientError(f"HTTP {response.status_code}: {detail}")

    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError as exc:
        raise ClientError("Server returned invalid JSON") from exc


def _parse_env(values: Sequence[str]) -> dict[str, str]:
    env: dict[str, str] = {}
    for value in values:
        key, separator, item = value.partition("=")
        if not separator or not key:
            raise ClientError(f"Invalid environment value {value!r}; expected KEY=VALUE")
        env[key] = item
    return env


def _service_value(service: dict[str, object], key: str, default: object = "-") -> object:
    value = service.get(key)
    if value is None and isinstance(service.get("runtime"), dict):
        value = service["runtime"].get(key)  # type: ignore[union-attr]
    return default if value is None else value


def _print_service(service: dict[str, object]) -> None:
    print(f"{_service_value(service, 'name')}: {_service_value(service, 'state')}")


def command_add(args: argparse.Namespace) -> int:
    result = _request(
        args,
        "POST",
        "/api/services",
        json={
            "name": args.name,
            "command": args.command,
            "cwd": args.cwd,
            "env": _parse_env(args.env),
            "auto_start": args.auto_start,
            "stop_timeout": args.stop_timeout,
        },
    )
    _print_service(result["service"])  # type: ignore[arg-type]
    return 0


def command_list(args: argparse.Namespace) -> int:
    result = _request(args, "GET", "/api/services")
    services = result.get("services", [])
    if not isinstance(services, list) or not services:
        print("No services registered.")
        return 0

    print(f"{'NAME':<24} {'STATE':<10} {'PID':<8} COMMAND")
    for service in services:
        if not isinstance(service, dict):
            continue
        print(
            f"{str(_service_value(service, 'name')):<24} "
            f"{str(_service_value(service, 'state')):<10} "
            f"{str(_service_value(service, 'pid')):<8} "
            f"{_service_value(service, 'command')}"
        )
    return 0


def command_ports(args: argparse.Namespace) -> int:
    path = "/api/ports"
    if args.port is not None:
        path = f"{path}?{urlencode({'port': args.port})}"
    result = _request(args, "GET", path)
    ports = result.get("ports", [])
    if not isinstance(ports, list) or not ports:
        print("No listening ports found.")
        return 0

    print(
        f"{'PROTO':<6} {'ADDRESS':<24} {'PORT':<6} {'PID':<8} "
        f"{'PROCESS':<20} {'USER':<16} COMMAND"
    )
    for entry in ports:
        if not isinstance(entry, dict):
            continue
        command = entry.get("command") or "-"
        print(
            f"{str(entry.get('protocol') or '-'):<6} "
            f"{str(entry.get('local_address') or '-'):<24} "
            f"{str(entry.get('port') or '-'):<6} "
            f"{str(entry.get('pid') or '-'):<8} "
            f"{str(entry.get('process_name') or '-'):<20} "
            f"{str(entry.get('username') or '-'):<16} "
            f"{command}"
        )
    return 0


def command_kill_process(args: argparse.Namespace) -> int:
    result = _request(
        args,
        "POST",
        f"/api/processes/{args.pid}/terminate",
        json={
            "expected_port": args.expected_port,
            "force": args.force,
            "timeout": args.timeout,
        },
    )
    termination = result.get("result", {})
    if not isinstance(termination, dict):
        termination = {}
    raw_action = termination.get("action") or ("kill" if args.force else "terminate")
    action = {"kill": "killed", "terminate": "terminated"}.get(str(raw_action), raw_action)
    pid = termination.get("pid", args.pid)
    port = termination.get("expected_port", args.expected_port)
    suffix = f" on port {port}" if port is not None else ""
    print(f"Process {pid}{suffix}: {action}")
    return 0


def command_action(args: argparse.Namespace) -> int:
    name = quote(args.name, safe="")
    result = _request(args, "POST", f"/api/services/{name}/{args.command_name}")
    _print_service(result["service"])  # type: ignore[arg-type]
    return 0


def command_delete(args: argparse.Namespace) -> int:
    name = quote(args.name, safe="")
    _request(args, "DELETE", f"/api/services/{name}")
    print(f"Deleted {args.name}")
    return 0


def _format_log(entry: object) -> str:
    if not isinstance(entry, dict):
        return str(entry)
    timestamp = entry.get("timestamp", "")
    stream = entry.get("stream", "")
    message = entry.get("message", entry.get("line", ""))
    prefix = " ".join(str(value) for value in (timestamp, stream) if value)
    return f"[{prefix}] {message}" if prefix else str(message)


def command_logs(args: argparse.Namespace) -> int:
    name = quote(args.name, safe="")
    result = _request(args, "GET", f"/api/services/{name}/logs?tail={args.tail}")
    logs = result.get("logs", [])
    if isinstance(logs, list):
        for entry in logs:
            print(_format_log(entry))
    if args.follow:
        asyncio.run(_follow_logs(args))
    return 0


async def _follow_logs(args: argparse.Namespace) -> None:
    import websockets

    try:
        async with websockets.connect(_websocket_url(args.url, args.token)) as socket:
            async for raw_event in socket:
                event = json.loads(raw_event)
                if (
                    isinstance(event, dict)
                    and event.get("type") == "log"
                    and event.get("service") == args.name
                ):
                    print(_format_log(event.get("data")), flush=True)
    except (OSError, ValueError, websockets.WebSocketException) as exc:
        raise ClientError(f"Log stream disconnected: {exc}") from exc


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def command_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from .api import create_app

    token = args.serve_token if args.serve_token is not None else args.token
    if not _is_loopback(args.host) and not token:
        raise ClientError("A token is required when serving on a non-loopback address")
    uvicorn.run(
        create_app(data_dir=Path(args.data_dir).expanduser(), token=token),
        host=args.host,
        port=args.port,
    )
    return 0


def command_tui(args: argparse.Namespace) -> int:
    from .tui import run_tui

    run_tui(args.url, args.token)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="service-console")
    parser.add_argument("--url", default=os.getenv("SERVICE_CONSOLE_URL"))
    parser.add_argument("--token", default=os.getenv("SERVICE_CONSOLE_TOKEN"))
    parser.add_argument(
        "--runtime-file",
        default=os.getenv("SERVICE_CONSOLE_RUNTIME_FILE", str(runtime_path())),
        help="desktop controller descriptor used when --url is omitted",
    )
    subparsers = parser.add_subparsers(dest="command_name", required=True)

    serve = subparsers.add_parser("serve", help="run the local controller and web interface")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8787)
    serve.add_argument("--data-dir", default="~/.service-console")
    serve.add_argument("--token", dest="serve_token")
    serve.set_defaults(handler=command_serve)

    add = subparsers.add_parser("add", help="register a service")
    add.add_argument("name")
    add.add_argument("--command", required=True)
    add.add_argument("--cwd", required=True)
    add.add_argument("--env", action="append", default=[], metavar="KEY=VALUE")
    add.add_argument("--auto-start", action="store_true")
    add.add_argument("--stop-timeout", type=float, default=5.0)
    add.set_defaults(handler=command_add)

    list_parser = subparsers.add_parser("list", help="list services")
    list_parser.set_defaults(handler=command_list)

    ports = subparsers.add_parser("ports", help="show local listening port ownership")
    ports.add_argument("--port", type=_port_number)
    ports.set_defaults(handler=command_ports)

    kill_process = subparsers.add_parser("kill-process", help="terminate a process by PID")
    kill_process.add_argument("pid", type=_positive_pid)
    kill_process.add_argument("--port", dest="expected_port", type=_port_number)
    kill_process.add_argument("--force", action="store_true")
    kill_process.add_argument("--timeout", type=_positive_timeout, default=3.0)
    kill_process.set_defaults(handler=command_kill_process)

    for action in ("start", "stop", "restart"):
        action_parser = subparsers.add_parser(action, help=f"{action} a service")
        action_parser.add_argument("name")
        action_parser.set_defaults(handler=command_action)

    delete = subparsers.add_parser("delete", help="delete a stopped service")
    delete.add_argument("name")
    delete.set_defaults(handler=command_delete)

    logs = subparsers.add_parser("logs", help="show recent service logs")
    logs.add_argument("name")
    logs.add_argument("--tail", type=int, default=500)
    logs.add_argument("--follow", action="store_true")
    logs.set_defaults(handler=command_logs)

    tui = subparsers.add_parser("tui", help="open the terminal interface")
    tui.set_defaults(handler=command_tui)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        _resolve_connection(args)
        return args.handler(args)
    except ClientError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
