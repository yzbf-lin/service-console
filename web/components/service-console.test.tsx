import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceConsole } from "@/components/service-console";
import type { AppUpdateStatus, NormalizedProcessCandidate, ViewId } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getProcess: vi.fn(),
  notify: vi.fn(),
  appUpdateStatus: null as AppUpdateStatus | null,
}));

vi.mock("@/components/ports-view", () => ({
  PortsView: ({ onImportProcess }: { onImportProcess: (pid: number) => Promise<void> }) => (
    <button type="button" onClick={() => void onImportProcess(42)}>导入端口进程</button>
  ),
}));
vi.mock("@/components/service-control-view", () => ({ ServiceControlView: () => <div>服务视图</div> }));
vi.mock("@/components/service-form-dialog", () => ({
  ServiceFormDialog: ({ sourceProcess }: { sourceProcess: NormalizedProcessCandidate | null }) => (
    <div data-testid="service-form">{sourceProcess ? `进程 ${sourceProcess.pid}` : "手动配置"}</div>
  ),
}));
vi.mock("@/components/service-list-panel", () => ({ ServiceListPanel: () => null }));
vi.mock("@/components/settings-view", () => ({ SettingsView: () => <div>设置视图</div> }));
vi.mock("@/components/sidebar-nav", () => ({
  SidebarNav: ({
    children,
    updateAvailable,
    onViewChange,
  }: {
    children?: ReactNode;
    updateAvailable?: boolean;
    onViewChange: (view: ViewId) => void;
  }) => (
    <aside data-testid="sidebar" data-update-available={String(Boolean(updateAvailable))}>
      {children}
      <button type="button" onClick={() => onViewChange("services")}>切换服务页</button>
    </aside>
  ),
}));
vi.mock("@/components/topbar", () => ({
  Topbar: ({ onAddService }: { onAddService: () => void }) => (
    <button type="button" onClick={onAddService}>手动添加服务</button>
  ),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe("ServiceConsole process shortcut coordination", () => {
  beforeEach(() => {
    mocks.getProcess.mockReset();
    mocks.notify.mockReset();
    mocks.appUpdateStatus = null;
  });

  it("does not replace a manually opened form with a late process response", async () => {
    const pending = deferred<NormalizedProcessCandidate>();
    mocks.getProcess.mockReturnValueOnce(pending.promise);
    render(<ServiceConsole />);

    fireEvent.click(screen.getByRole("button", { name: "导入端口进程" }));
    fireEvent.click(screen.getByRole("button", { name: "手动添加服务" }));
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
});
