import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppLogsView } from "@/components/app-logs-view";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { AppLogEntry, AppLogSnapshot } from "@/lib/types";

const entries: AppLogEntry[] = [
  { id: "1", timestamp: "2026-09-22T00:00:00Z", level: "INFO", event: "desktop.ready", message: "窗口已就绪" },
  { id: "2", timestamp: "2026-09-22T00:00:01Z", level: "WARN", event: "api.rejected", message: "Jenkins 连接失败" },
  { id: "3", timestamp: "2026-09-22T00:00:02Z", level: "ERROR", event: "ui.error", message: "保存操作异常" },
];

function fixture(logs = entries): AppLogSnapshot {
  return { logs, path: "/data/logs/service-console.log", max_file_bytes: 1_048_576, retained_files: 3 };
}

async function mount() {
  vi.useFakeTimers();
  const getAppLogs = vi.fn().mockResolvedValue(fixture());
  const api = { getAppLogs } as unknown as ServiceConsoleApiClient;
  const view = render(<AppLogsView api={api} refreshSignal={0} />);
  await act(async () => { await Promise.resolve(); });
  return { ...view, api, getAppLogs };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("application log viewer", () => {
  it("filters severity and search, copies visible entries and shows rotation limits", async () => {
    await mount();
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    fireEvent.click(screen.getByRole("button", { name: "警告与错误" }));
    expect(screen.queryByText("窗口已就绪")).toBeNull();
    expect(screen.getByText("Jenkins 连接失败")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索应用日志" }), { target: { value: "保存" } });
    expect(screen.queryByText("Jenkins 连接失败")).toBeNull();
    expect(screen.getByText("保存操作异常")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制筛选结果" })));
    expect(clipboard).toHaveBeenCalledWith("2026-09-22T00:00:02Z ERROR ui.error 保存操作异常");
    expect(screen.getByText(/单文件 1 MiB，保留 2 个备份/)).toBeTruthy();
    expect(screen.getByText("/data/logs/service-console.log")).toBeTruthy();
  });

  it("keeps existing rows mounted, polls serially and preserves a reader's scroll position", async () => {
    const { getAppLogs } = await mount();
    const firstRow = screen.getByText("窗口已就绪").closest("li");
    const region = screen.getByRole("region", { name: "应用日志内容" });
    Object.defineProperties(region, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 100 },
    });
    region.scrollTop = 100;
    fireEvent.scroll(region);
    expect(screen.getByRole("button", { name: "回到最新" })).toBeTruthy();
    getAppLogs.mockResolvedValue(fixture([...entries, { ...entries[0], id: "4", message: "后续记录" }]));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(getAppLogs).toHaveBeenCalledTimes(2);
    expect(screen.getByText("窗口已就绪").closest("li")).toBe(firstRow);
    expect(screen.getByText("后续记录")).toBeTruthy();
    expect(region.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
    expect(region.scrollTop).toBe(1_000);
  });

  it("pauses polling, allows manual refresh and retains previous results on failure", async () => {
    const { getAppLogs, unmount } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "暂停刷新" }));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(getAppLogs).toHaveBeenCalledTimes(1);
    getAppLogs.mockRejectedValueOnce(new Error("controller offline"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新" })));
    expect(screen.getByRole("alert").textContent).toContain("controller offline");
    expect(within(screen.getByRole("list", { name: "日志记录" })).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "自动刷新" }));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.queryByRole("alert")).toBeNull();
    const signal = getAppLogs.mock.calls.at(-1)?.[0] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    const calls = getAppLogs.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(getAppLogs).toHaveBeenCalledTimes(calls);
  });

  it("honors the topbar refresh signal and shows a useful empty state", async () => {
    const { api, getAppLogs, rerender } = await mount();
    getAppLogs.mockResolvedValue(fixture([]));
    await act(async () => rerender(<AppLogsView api={api} refreshSignal={1} />));
    expect(getAppLogs).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/暂无应用日志/)).toBeTruthy();
  });
});
