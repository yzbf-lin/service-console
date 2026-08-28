import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceConsole } from "@/components/service-console";
import type { NormalizedProcessCandidate, ViewId } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getProcess: vi.fn(),
  notify: vi.fn(),
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
  SidebarNav: ({ children, onViewChange }: { children?: ReactNode; onViewChange: (view: ViewId) => void }) => (
    <aside>
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

describe("ServiceConsole process shortcut coordination", () => {
  beforeEach(() => {
    mocks.getProcess.mockReset();
    mocks.notify.mockReset();
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
});
