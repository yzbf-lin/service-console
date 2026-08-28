"""Perform a real MCP handshake against a packaged Service Console helper."""

from __future__ import annotations

import argparse
import asyncio
import tempfile
from pathlib import Path

from mcp import Client
from mcp.client.stdio import StdioServerParameters

from service_console.mcp_integration import MCP_TOOL_NAMES

EXPECTED_TOOLS = set(MCP_TOOL_NAMES)


async def verify(helper: Path, timeout: float) -> None:
    with tempfile.TemporaryDirectory(prefix="service-console-mcp-smoke-") as temporary:
        root = Path(temporary)
        parameters = StdioServerParameters(
            command=str(helper),
            args=[
                "--runtime-file",
                str(root / "controller.json"),
                "--data-dir",
                str(root / "data"),
            ],
        )
        async with Client(parameters, read_timeout_seconds=timeout) as client:
            response = await client.list_tools()

    discovered = {tool.name for tool in response.tools}
    if discovered != EXPECTED_TOOLS:
        missing = sorted(EXPECTED_TOOLS - discovered)
        unexpected = sorted(discovered - EXPECTED_TOOLS)
        raise RuntimeError(f"MCP tool mismatch; missing={missing}, unexpected={unexpected}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("helper", type=Path)
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()
    helper = args.helper.expanduser().resolve()
    if not helper.is_file():
        parser.error(f"helper does not exist: {helper}")
    asyncio.run(verify(helper, args.timeout))
    print(f"MCP handshake passed: {helper} ({len(EXPECTED_TOOLS)} tools)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
