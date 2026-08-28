import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { McpIntegrationCard } from "@/components/mcp-integration-card";
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
    bridge_args: ["--runtime-file", "/tmp/controller.json"],
    config_snippet: "codex mcp add service-console -- service-console-mcp",
    tools: [],
    last_test: null,
    error: null,
    ...overrides,
  };
}

function renderCard(
  integrationStatus: McpIntegrationStatus,
  operation: "installing" | "testing" | "removing" | null = null,
) {
  const handlers = {
    onInstall: vi.fn(),
    onRefresh: vi.fn(),
    onTest: vi.fn(),
    onCopyConfig: vi.fn(),
    onRemove: vi.fn(),
  };
  render(<McpIntegrationCard status={integrationStatus} operation={operation} {...handlers} />);
  return handlers;
}

describe("McpIntegrationCard", () => {
  it("offers installation and configuration copy before Codex is registered", () => {
    const handlers = renderCard(status("not_installed"));

    fireEvent.click(screen.getByRole("button", { name: "安装到 Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "复制配置" }));
    expect(handlers.onInstall).toHaveBeenCalledOnce();
    expect(handlers.onCopyConfig).toHaveBeenCalledWith(
      "codex mcp add service-console -- service-console-mcp",
    );
    expect(screen.queryByRole("button", { name: "移除集成" })).toBeNull();
  });

  it("shows verified tools and protects removal with confirmation", () => {
    const handlers = renderCard(status("installed", {
      tools: ["service_list", "service_restart"],
      last_test: { ok: true, tested_at: "2026-08-28T12:00:00Z", error: null },
    }));

    expect(screen.getByRole("status").textContent).toBe("连接正常");
    expect(screen.getByText("可用工具 2 个")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(handlers.onTest).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "移除集成" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/不会删除 Service Console 中的服务定义/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    expect(handlers.onRemove).toHaveBeenCalledOnce();
  });

  it("offers repair for a conflicting Codex registration", () => {
    const handlers = renderCard(status("conflict", {
      codex_registered: true,
      error: "同名 MCP 指向其他命令",
    }));

    expect(screen.getByRole("status").textContent).toBe("配置冲突");
    expect(screen.getByRole("alert").textContent).toContain("同名 MCP");
    fireEvent.click(screen.getByRole("button", { name: "修复 Codex 配置" }));
    expect(handlers.onInstall).toHaveBeenCalledOnce();
  });

  it.each([
    ["error", { error: "读取 Codex MCP 配置失败" }],
    ["unavailable", { bridge_available: false, config_snippet: null }],
  ] as const)("blocks installation and offers detection again for %s", (stateName, overrides) => {
    const handlers = renderCard(status(stateName, overrides));

    const install = screen.getByRole("button", { name: "安装到 Codex" });
    expect(install.hasAttribute("disabled")).toBe(true);
    fireEvent.click(install);
    expect(handlers.onInstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    expect(handlers.onRefresh).toHaveBeenCalledOnce();
  });

  it("keeps stale registration removable when the packaged Bridge is missing", () => {
    renderCard(status("unavailable", {
      codex_registered: true,
      bridge_available: false,
      config_snippet: null,
    }));

    expect(screen.queryByRole("button", { name: "安装到 Codex" })).toBeNull();
    expect(screen.getByRole("button", { name: "测试连接" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "重新检测" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "移除集成" })).toBeTruthy();
  });

  it("disables actions while an operation is running", () => {
    renderCard(status("installed"), "testing");

    expect(screen.getByRole("status").textContent).toBe("测试中");
    expect(screen.getByRole("button", { name: "测试中" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "复制配置" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "移除集成" }).hasAttribute("disabled")).toBe(true);
  });
});
