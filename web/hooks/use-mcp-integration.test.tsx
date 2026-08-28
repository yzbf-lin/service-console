import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useMcpIntegration } from "@/hooks/use-mcp-integration";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { McpIntegrationStatus } from "@/lib/types";

function status(
  state: McpIntegrationStatus["state"],
  overrides: Partial<McpIntegrationStatus> = {},
): McpIntegrationStatus {
  return {
    state,
    transport: "stdio",
    controller_ready: true,
    bridge_available: true,
    codex_cli_available: true,
    codex_registered: state === "installed",
    server_name: "service-console",
    bridge_command: "service-console-mcp",
    bridge_args: [],
    config_snippet: "codex mcp add service-console -- service-console-mcp",
    tools: [],
    last_test: null,
    error: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function apiFixture(overrides: Partial<ServiceConsoleApiClient> = {}) {
  return {
    getMcpIntegrationStatus: vi.fn().mockResolvedValue(status("not_installed")),
    installMcpIntegration: vi.fn().mockResolvedValue(status("installed")),
    testMcpIntegration: vi.fn().mockResolvedValue(status("installed", {
      tools: ["service_list", "service_restart"],
      last_test: { ok: true, tested_at: "2026-08-28T12:00:00Z", error: null },
    })),
    removeMcpIntegration: vi.fn().mockResolvedValue(status("not_installed")),
    ...overrides,
  } as unknown as ServiceConsoleApiClient;
}

describe("useMcpIntegration", () => {
  it("loads status and reports a successful install", async () => {
    const api = apiFixture();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useMcpIntegration({ api, onError: vi.fn(), onSuccess }));

    await act(async () => { await Promise.resolve(); });
    expect(result.current.status?.state).toBe("not_installed");

    await act(async () => { await result.current.install(); });
    expect(api.installMcpIntegration).toHaveBeenCalledOnce();
    expect(result.current.status?.state).toBe("installed");
    expect(onSuccess).toHaveBeenCalledWith("已安装到 Codex", expect.stringContaining("重启 Codex"));
  });

  it("does not allow a late initial response to overwrite an operation", async () => {
    const initialStatus = deferred<McpIntegrationStatus>();
    const api = apiFixture({
      getMcpIntegrationStatus: vi.fn().mockReturnValue(initialStatus.promise),
      installMcpIntegration: vi.fn().mockResolvedValue(status("installed")),
    });
    const { result } = renderHook(() => useMcpIntegration({
      api,
      onError: vi.fn(),
      onSuccess: vi.fn(),
    }));

    await act(async () => { await result.current.install(); });
    expect(result.current.status?.state).toBe("installed");

    await act(async () => {
      initialStatus.resolve(status("not_installed"));
      await Promise.resolve();
    });
    expect(result.current.status?.state).toBe("installed");
  });

  it("does not report installation success when the registration remains conflicting", async () => {
    const api = apiFixture({
      installMcpIntegration: vi.fn().mockResolvedValue(status("conflict", {
        codex_registered: true,
      })),
    });
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useMcpIntegration({ api, onError, onSuccess }));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.install(); });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Codex MCP 集成尚未生效", expect.any(String));
  });

  it("serializes operations while a connection test is pending", async () => {
    const pendingTest = deferred<McpIntegrationStatus>();
    const api = apiFixture({
      getMcpIntegrationStatus: vi.fn().mockResolvedValue(status("installed")),
      testMcpIntegration: vi.fn().mockReturnValue(pendingTest.promise),
    });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useMcpIntegration({ api, onError: vi.fn(), onSuccess }));
    await act(async () => { await Promise.resolve(); });

    let testOperation!: Promise<McpIntegrationStatus | null>;
    act(() => { testOperation = result.current.testConnection(); });
    expect(result.current.operation).toBe("testing");
    await act(async () => { await result.current.remove(); });
    expect(api.removeMcpIntegration).not.toHaveBeenCalled();

    await act(async () => {
      pendingTest.resolve(status("installed", {
        tools: ["service_list"],
        last_test: { ok: true, tested_at: "2026-08-28T12:00:00Z", error: null },
      }));
      await testOperation;
    });
    expect(result.current.operation).toBeNull();
    expect(onSuccess).toHaveBeenCalledWith("MCP 连接正常", expect.stringContaining("1 个"));
  });

  it("does not report a successful handshake when the registration is conflicting", async () => {
    const api = apiFixture({
      getMcpIntegrationStatus: vi.fn().mockResolvedValue(status("installed")),
      testMcpIntegration: vi.fn().mockResolvedValue(status("conflict", {
        codex_registered: true,
        last_test: { ok: true, tested_at: "2026-08-28T12:00:00Z", error: null },
      })),
    });
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useMcpIntegration({ api, onError, onSuccess }));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.testConnection(); });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("MCP 连接测试未通过", expect.any(String));
  });

  it.each([
    ["error response", status("error", { error: "读取配置失败" })],
    ["generic unavailable response", status("unavailable", {
      controller_ready: false,
      bridge_available: false,
      codex_registered: false,
    })],
  ])("does not report removal success for an %s", async (_label, removalStatus) => {
    const api = apiFixture({
      getMcpIntegrationStatus: vi.fn().mockResolvedValue(status("installed")),
      removeMcpIntegration: vi.fn().mockResolvedValue(removalStatus),
    });
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useMcpIntegration({ api, onError, onSuccess }));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.remove(); });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Codex MCP 集成仍然存在", expect.any(String));
  });

  it("reports removal success when a stale registration is removed without a packaged Bridge", async () => {
    const api = apiFixture({
      getMcpIntegrationStatus: vi.fn().mockResolvedValue(status("unavailable", {
        controller_ready: true,
        bridge_available: false,
        codex_registered: true,
      })),
      removeMcpIntegration: vi.fn().mockResolvedValue(status("unavailable", {
        controller_ready: true,
        bridge_available: false,
        codex_registered: false,
      })),
    });
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useMcpIntegration({ api, onError, onSuccess }));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.remove(); });
    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith("已移除 Codex 集成", expect.any(String));
  });

  it("reports an operation error and silently refreshes status", async () => {
    const getStatus = vi.fn().mockResolvedValue(status("not_installed"));
    const api = apiFixture({
      getMcpIntegrationStatus: getStatus,
      installMcpIntegration: vi.fn().mockRejectedValue(new Error("codex command failed")),
    });
    const onError = vi.fn();
    const { result } = renderHook(() => useMcpIntegration({ api, onError, onSuccess: vi.fn() }));
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await result.current.install(); });
    expect(onError).toHaveBeenCalledWith("安装 Codex MCP 集成失败", "codex command failed");
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status?.state).toBe("not_installed");
  });
});
