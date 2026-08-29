import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceConsole } from "@/components/service-console";
import { ApiError } from "@/lib/api-client";
import type {
  AppUpdateStatus,
  McpIntegrationStatus,
  NormalizedProcessCandidate,
  ViewId,
} from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getProcess: vi.fn(),
  notify: vi.fn(),
  appUpdateStatus: null as AppUpdateStatus | null,
  installMcp: vi.fn(),
  refreshMcp: vi.fn(),
  mcpStatus: null as McpIntegrationStatus | null,
}));

vi.mock("@/components/ports-view", () => ({
  PortsView: ({ onImportProcess }: {
    onImportProcess: (process: { pid: number; processName: string; ports: number[] }) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() => void onImportProcess({ pid: 42, processName: "node", ports: [8000] })}
    >
      导入端口进程
    </button>
  ),
}));
vi.mock("@/components/service-control-view", () => ({
  ServiceControlView: ({ onAddService }: { onAddService: () => void }) => (
    <div>
      服务视图
      <button type="button" onClick={onAddService}>内容区添加服务</button>
    </div>
  ),
}));
vi.mock("@/components/service-form-dialog", () => ({
  ServiceFormDialog: ({ sourceProcess }: { sourceProcess: NormalizedProcessCandidate | null }) => (
    <>
      <div
        data-testid="service-form"
        data-command={sourceProcess?.command ?? ""}
        data-restorable={String(sourceProcess?.restorable ?? true)}
      >
        {sourceProcess ? `进程 ${sourceProcess.pid}` : "手动配置"}
      </div>
      {sourceProcess ? (
        <div data-testid="process-warning">{sourceProcess.warnings.join("；")}</div>
      ) : null}
    </>
  ),
}));
vi.mock("@/components/settings-view", () => ({
  SettingsView: ({
    mcpStatus,
    onInstallMcp,
    onRefreshMcp,
    onCopyMcpConfig,
  }: {
    mcpStatus: McpIntegrationStatus | null;
    onInstallMcp: () => void;
    onRefreshMcp: () => void;
    onCopyMcpConfig: (config: string) => void;
  }) => (
    <div data-testid="settings-view" data-mcp-state={mcpStatus?.state || "loading"}>
      <button type="button" onClick={onInstallMcp}>安装 MCP</button>
      <button type="button" onClick={onRefreshMcp}>重新检测 MCP</button>
      <button type="button" onClick={() => onCopyMcpConfig("codex mcp add service-console")}>复制 MCP 配置</button>
    </div>
  ),
}));
vi.mock("@/components/sidebar-nav", () => ({
  SidebarNav: ({
    updateAvailable,
    onViewChange,
  }: {
    updateAvailable?: boolean;
    onViewChange: (view: ViewId) => void;
  }) => (
    <aside data-testid="sidebar" data-update-available={String(Boolean(updateAvailable))}>
      <button type="button" onClick={() => onViewChange("services")}>切换服务页</button>
      <button type="button" onClick={() => onViewChange("settings")}>切换设置页</button>
    </aside>
  ),
}));
vi.mock("@/components/topbar", () => ({
  Topbar: () => <div>公共顶部栏</div>,
}));
vi.mock("@/components/toast-provider", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useToast: () => ({ notify: mocks.notify }),
}));
vi.mock("@/hooks/use-hash-view", async () => {
  const { useState } = await import("react");
  return {
    useHashView: () => {
      const [activeView, setActiveView] = useState<ViewId>("ports");
      return { activeView, setActiveView };
    },
  };
});
vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({
    preference: "system",
    resolvedTheme: "light",
    setPreference: vi.fn(),
    toggleTheme: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-app-update", () => ({
  useAppUpdate: () => ({
    status: mocks.appUpdateStatus,
    operation: null,
    busy: false,
    refreshStatus: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installUpdate: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-mcp-integration", () => ({
  useMcpIntegration: () => ({
    status: mocks.mcpStatus,
    operation: null,
    busy: false,
    refreshStatus: mocks.refreshMcp,
    install: mocks.installMcp,
    testConnection: vi.fn(),
    remove: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-services", () => ({
  useServices: () => ({
    api: { getProcess: mocks.getProcess },
    apiStatus: "ok",
    socketStatus: "ok",
    services: [],
    selectedName: null,
    selectedService: null,
    selectedLogs: [],
    logRevision: 0,
    busyServices: new Set<string>(),
    checkHealth: vi.fn().mockResolvedValue(true),
    loadServices: vi.fn().mockResolvedValue(undefined),
    clearVisibleLogs: vi.fn(),
    selectService: vi.fn(),
    runAction: vi.fn(),
    createService: vi.fn(),
    updateService: vi.fn(),
    deleteService: vi.fn(),
  }),
}));

function processFixture(): NormalizedProcessCandidate {
  return {
    pid: 42,
    parentPid: 1,
    createTime: 123,
    startedAt: null,
    processName: "python",
    command: "python app.py",
    cwd: "/workspace",
    username: "developer",
    ports: [8000],
    suggestedName: "backend",
    safeEnv: {},
    restorable: true,
    warnings: [],
    managedService: null,
  };
}

function availableUpdateFixture(): AppUpdateStatus {
  return {
    state: "available",
    current_version: "0.1.0",
    latest_version: "0.2.0",
    release_url: "https://github.com/yzbf-lin/service-console/releases/tag/v0.2.0",
    published_at: null,
    notes: "更新说明",
    platform: "darwin-arm64",
    platform_supported: true,
    can_install: true,
    reason: null,
    error: null,
    downloaded_bytes: 0,
    total_bytes: 1_000,
    download_progress: 0,
    downloaded: false,
    restart_required: false,
  };
}

function installedMcpFixture(): McpIntegrationStatus {
  return {
    state: "installed",
    transport: "stdio",
    controller_ready: true,
    bridge_available: true,
    codex_cli_available: true,
    codex_registered: true,
    server_name: "service-console",
    bridge_command: "service-console-mcp",
    bridge_args: [],
    config_snippet: "codex mcp add service-console",
    tools: ["service_list"],
    last_test: null,
    error: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe("ServiceConsole process shortcut coordination", () => {
  beforeEach(() => {
    mocks.getProcess.mockReset();
    mocks.notify.mockReset();
    mocks.installMcp.mockReset();
    mocks.refreshMcp.mockReset();
    mocks.appUpdateStatus = null;
    mocks.mcpStatus = null;
  });

  it("does not replace a manually opened form with a late process response", async () => {
    const pending = deferred<NormalizedProcessCandidate>();
    mocks.getProcess.mockReturnValueOnce(pending.promise);
    render(<ServiceConsole />);

    fireEvent.click(screen.getByRole("button", { name: "导入端口进程" }));
    fireEvent.click(screen.getByRole("button", { name: "切换服务页" }));
    fireEvent.click(screen.getByRole("button", { name: "内容区添加服务" }));
    expect(screen.getByTestId("service-form").textContent).toBe("手动配置");

    await act(async () => pending.resolve(processFixture()));
    await waitFor(() => expect(screen.getByTestId("service-form").textContent).toBe("手动配置"));
  });

  it("does not open a form after navigating away from the ports view", async () => {
    const pending = deferred<NormalizedProcessCandidate>();
    mocks.getProcess.mockReturnValueOnce(pending.promise);
    render(<ServiceConsole />);

    fireEvent.click(screen.getByRole("button", { name: "导入端口进程" }));
    fireEvent.click(screen.getByRole("button", { name: "切换服务页" }));
    await act(async () => pending.resolve(processFixture()));

    await waitFor(() => expect(screen.queryByTestId("service-form")).toBeNull());
  });

  it("opens manual completion when process detail returns a restricted snapshot", async () => {
    mocks.getProcess.mockResolvedValueOnce({
      ...processFixture(),
      command: "",
      cwd: "",
      restorable: false,
      warnings: ["权限受限，需手动补全启动信息"],
    });
    render(<ServiceConsole />);

    fireEvent.click(screen.getByRole("button", { name: "导入端口进程" }));

    await waitFor(() => expect(screen.getByTestId("service-form").textContent).toBe("进程 42"));
    expect(screen.getByTestId("service-form").getAttribute("data-restorable")).toBe("false");
    expect(screen.getByTestId("service-form").getAttribute("data-command")).toBe("");
    expect(screen.getByTestId("process-warning").textContent).toContain("手动补全");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("opens a safe empty draft instead of a toast for permission-denied detail", async () => {
    mocks.getProcess.mockRejectedValueOnce(new ApiError(
      "permission denied while inspecting process 42 owned by another user",
      409,
    ));
    render(<ServiceConsole />);

    fireEvent.click(screen.getByRole("button", { name: "导入端口进程" }));

    await waitFor(() => expect(screen.getByTestId("service-form").textContent).toBe("进程 42"));
    expect(screen.getByTestId("service-form").getAttribute("data-restorable")).toBe("false");
    expect(screen.getByTestId("service-form").getAttribute("data-command")).toBe("");
    expect(screen.getByTestId("process-warning").textContent).toContain("当前权限不足");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("announces each discovered update once and marks the Settings navigation", async () => {
    mocks.appUpdateStatus = availableUpdateFixture();
    render(<ServiceConsole />);

    await waitFor(() => expect(mocks.notify).toHaveBeenCalledOnce());
    expect(mocks.notify).toHaveBeenCalledWith(
      "发现新版本 v0.2.0",
      "前往设置下载并安装更新。",
      "info",
    );
    expect(screen.getByTestId("sidebar").getAttribute("data-update-available")).toBe("true");

    mocks.appUpdateStatus = {
      ...availableUpdateFixture(),
      state: "downloaded",
      downloaded_bytes: 1_000,
      download_progress: 100,
      downloaded: true,
    };
    fireEvent.click(screen.getByRole("button", { name: "切换服务页" }));
    await act(async () => { await Promise.resolve(); });
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it("wires MCP actions and clipboard feedback through the Settings view", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.mcpStatus = installedMcpFixture();
    render(<ServiceConsole />);

    fireEvent.click(screen.getByRole("button", { name: "切换设置页" }));
    expect(screen.getByTestId("settings-view").getAttribute("data-mcp-state")).toBe("installed");
    fireEvent.click(screen.getByRole("button", { name: "安装 MCP" }));
    expect(mocks.installMcp).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "重新检测 MCP" }));
    expect(mocks.refreshMcp).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "复制 MCP 配置" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("codex mcp add service-console"));
    expect(mocks.notify).toHaveBeenCalledWith(
      "MCP 配置已复制",
      "可粘贴到 Codex 配置或终端中使用。",
      "success",
    );
  });
});
