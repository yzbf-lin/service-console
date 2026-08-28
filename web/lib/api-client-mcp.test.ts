import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "@/lib/api-client";
import type { McpIntegrationStatus } from "@/lib/types";

function mcpStatus(state: McpIntegrationStatus["state"]): McpIntegrationStatus {
  return {
    state,
    transport: "stdio",
    controller_ready: true,
    bridge_available: true,
    codex_cli_available: true,
    codex_registered: state === "installed",
    server_name: "service-console",
    bridge_command: "/Applications/Service Console.app/Contents/MacOS/service-console-mcp",
    bridge_args: ["--runtime-file", "/Users/test/.service-console/controller.json"],
    config_snippet: "codex mcp add service-console -- service-console-mcp",
    tools: state === "installed" ? ["service_list", "service_restart"] : [],
    last_test: null,
    error: null,
  };
}

describe("MCP integration API client", () => {
  it("uses the status, install, test and remove endpoints", async () => {
    const responses = ["not_installed", "installed", "installed", "not_installed"]
      .map((state) => new Response(JSON.stringify({
        mcp: mcpStatus(state as McpIntegrationStatus["state"]),
      }), { status: 200 }));
    const fetchMock = vi.fn<typeof fetch>();
    responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));
    const client = createApiClient({ fetch: fetchMock });

    await expect(client.getMcpIntegrationStatus()).resolves.toMatchObject({ state: "not_installed" });
    await expect(client.installMcpIntegration()).resolves.toMatchObject({ state: "installed" });
    await expect(client.testMcpIntegration()).resolves.toMatchObject({ state: "installed" });
    await expect(client.removeMcpIntegration()).resolves.toMatchObject({ state: "not_installed" });

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/api/mcp-integration", undefined],
      ["/api/mcp-integration/install", "POST"],
      ["/api/mcp-integration/test", "POST"],
      ["/api/mcp-integration", "DELETE"],
    ]);
  });
});
