import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PortsView } from "@/components/ports-view";
import { usePorts } from "@/hooks/use-ports";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { NormalizedPortRow } from "@/lib/types";

vi.mock("@/hooks/use-ports", () => ({
  usePorts: vi.fn(),
}));

const usePortsMock = vi.mocked(usePorts);
type NotificationHandler = (title: string, message: string) => void;

function portFixture(overrides: Partial<NormalizedPortRow> = {}): NormalizedPortRow {
  return {
    protocol: "TCP",
    localAddress: "127.0.0.1",
    port: 8_000,
    pid: 42,
    processName: "node",
    command: "node server.js",
    username: "developer",
    ...overrides,
  };
}

function renderPortsView({
  ports,
  filter = null,
  api,
  terminate = vi.fn().mockResolvedValue({ needsForce: false, terminated: true }),
  onError = vi.fn(),
  onSuccess = vi.fn(),
  onImportProcess,
}: {
  ports: NormalizedPortRow[];
  filter?: number | null;
  api?: ServiceConsoleApiClient;
  terminate?: ReturnType<typeof vi.fn>;
  onError?: NotificationHandler;
  onSuccess?: NotificationHandler;
  onImportProcess?: (pid: number) => Promise<void>;
}) {
  const loadPorts = vi.fn();
  const apiClient = api ?? ({ listPorts: vi.fn() } as unknown as ServiceConsoleApiClient);
  const importProcess = vi.fn(onImportProcess ?? (async () => undefined));

  usePortsMock.mockReturnValue({
    ports,
    filter,
    loading: false,
    loaded: true,
    busyPids: new Set<number>(),
    setFilter: vi.fn(),
    loadPorts,
    terminate,
  } as unknown as ReturnType<typeof usePorts>);

  render(
    <PortsView
      api={apiClient}
      active={false}
      onError={onError}
      onSuccess={onSuccess}
      onImportProcess={importProcess}
      refreshSignal={0}
    />,
  );

  return { api: apiClient, loadPorts, onError, onSuccess, onImportProcess: importProcess, terminate };
}

describe("PortsView process grouping", () => {
  it("sends a process PID to the add-service shortcut and disables unknown processes", async () => {
    const onImportProcess = vi.fn<(pid: number) => Promise<void>>().mockResolvedValue(undefined);
    const { onImportProcess: importProcess } = renderPortsView({
      ports: [portFixture(), portFixture({ port: 9_000, pid: null, processName: "未知进程" })],
      onImportProcess,
    });

    fireEvent.click(screen.getByRole("button", { name: "将 PID 42 添加为服务" }));
    await waitFor(() => expect(importProcess).toHaveBeenCalledWith(42));
    expect(onImportProcess).toHaveBeenCalledWith(42);
    expect((screen.getByRole("button", { name: "缺少 PID，添加服务不可用" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("groups rows by PID, keeps unidentified rows separate, and expands protocol details", () => {
    renderPortsView({
      ports: [
        portFixture(),
        portFixture({ protocol: "UDP", localAddress: "0.0.0.0", port: 8_001 }),
        portFixture({ port: 9_000, pid: null, processName: "未知进程", command: "", username: "—" }),
      ],
    });

    expect(screen.getByText("2 组")).toBeTruthy();
    expect(screen.getByText("8000")).toBeTruthy();
    expect(screen.getByText("8001")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "node 的监听明细" })).toBeNull();

    const expandButton = screen.getByRole("button", {
      name: "展开 node，PID 42，监听端口 8000、8001 的监听明细",
    });
    fireEvent.click(expandButton);

    const details = screen.getByRole("region", { name: "node 的监听明细" });
    expect(within(details).getByText("TCP")).toBeTruthy();
    expect(within(details).getByText("UDP")).toBeTruthy();
    expect(within(details).getByText("127.0.0.1")).toBeTruthy();
    expect(within(details).getByText("0.0.0.0")).toBeTruthy();
    const unknownTerminate = screen.getByRole("button", { name: "缺少 PID，终止操作不可用" }) as HTMLButtonElement;
    expect(unknownTerminate.disabled).toBe(true);
    expect(screen.queryByRole("row")).toBeNull();
  });

  it("loads the complete PID port set before filtered termination and preserves force escalation", async () => {
    const filteredRow = portFixture();
    const allRows = [filteredRow, portFixture({ protocol: "UDP", localAddress: "0.0.0.0", port: 8_001 })];
    const api = {
      listPorts: vi.fn().mockResolvedValue(allRows),
    } as unknown as ServiceConsoleApiClient;
    const terminate = vi.fn()
      .mockResolvedValueOnce({ needsForce: true, terminated: false })
      .mockResolvedValueOnce({ needsForce: false, terminated: true });
    const onSuccess = vi.fn();

    renderPortsView({ ports: [filteredRow], filter: 8_000, api, terminate, onSuccess });
    fireEvent.click(screen.getByRole("button", { name: "终止 PID 42" }));

    expect(await screen.findByText("完整端口集合：8000、8001")).toBeTruthy();
    expect(api.listPorts).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByRole("button", { name: "普通终止" }));
    expect(await screen.findByRole("heading", { name: "进程未在 3 秒内退出" })).toBeTruthy();
    expect(screen.getByText("完整端口集合：8000、8001")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "强制结束" }));
    await waitFor(() => expect(terminate).toHaveBeenCalledTimes(2));

    expect(terminate).toHaveBeenNthCalledWith(1, expect.objectContaining({ pid: 42, port: 8_000 }), false);
    expect(terminate).toHaveBeenNthCalledWith(2, expect.objectContaining({ pid: 42, port: 8_000 }), true);
    expect(onSuccess).toHaveBeenCalledWith("进程已终止", "PID 42 已释放端口 8000、8001");
  });

  it("refreshes an unfiltered snapshot and terminates with the port selected before refresh", async () => {
    const selectedRow = portFixture({ port: 8_000 });
    const refreshedExpectedRow = portFixture({ port: 8_000, command: "node refreshed.js" });
    const lowerPortRow = portFixture({ port: 7_000, localAddress: "0.0.0.0" });
    const api = {
      listPorts: vi.fn().mockResolvedValue([lowerPortRow, refreshedExpectedRow]),
    } as unknown as ServiceConsoleApiClient;
    const terminate = vi.fn().mockResolvedValue({ needsForce: false, terminated: true });

    renderPortsView({ ports: [selectedRow], api, terminate });
    fireEvent.click(screen.getByRole("button", { name: "终止 PID 42" }));

    expect(await screen.findByText("完整端口集合：7000、8000")).toBeTruthy();
    expect(api.listPorts).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByRole("button", { name: "普通终止" }));
    await waitFor(() => expect(terminate).toHaveBeenCalledTimes(1));

    expect(terminate).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 42, port: 8_000, command: "node refreshed.js" }),
      false,
    );
  });

  it("cancels termination when a reused PID no longer owns the originally selected port", async () => {
    const selectedRow = portFixture({ port: 8_000 });
    const reusedPidRow = portFixture({
      port: 9_000,
      processName: "python",
      command: "python replacement.py",
    });
    const api = {
      listPorts: vi.fn().mockResolvedValue([reusedPidRow]),
    } as unknown as ServiceConsoleApiClient;
    const terminate = vi.fn();
    const onError = vi.fn();

    const { loadPorts } = renderPortsView({ ports: [selectedRow], api, terminate, onError });
    fireEvent.click(screen.getByRole("button", { name: "终止 PID 42" }));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        "进程状态已变化",
        "PID 42 已不再监听端口 8000，终止操作已取消，请刷新后重试",
      );
    });
    expect(api.listPorts).toHaveBeenCalledWith(null);
    expect(terminate).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "终止进程 python" })).toBeNull();
    expect(loadPorts).toHaveBeenCalledWith({ silent: true });
  });
});
