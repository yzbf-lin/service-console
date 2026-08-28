import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useAppUpdate } from "@/hooks/use-app-update";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { AppUpdateStatus } from "@/lib/types";

function updateStatus(
  state: AppUpdateStatus["state"],
  overrides: Partial<AppUpdateStatus> = {},
): AppUpdateStatus {
  return {
    state,
    current_version: "0.1.0",
    latest_version: state === "idle" ? null : "0.2.0",
    release_url: "https://github.com/yzbf-lin/service-console/releases/tag/v0.2.0",
    published_at: null,
    notes: null,
    platform: "darwin-arm64",
    platform_supported: true,
    can_install: true,
    reason: null,
    error: null,
    downloaded_bytes: 0,
    total_bytes: 1_000,
    download_progress: 0,
    downloaded: state === "downloaded" || state === "restarting",
    restart_required: false,
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
    getAppUpdateStatus: vi.fn().mockResolvedValue(updateStatus("idle")),
    checkAppUpdate: vi.fn().mockResolvedValue(updateStatus("available")),
    downloadAppUpdate: vi.fn().mockResolvedValue(updateStatus("downloaded")),
    installAppUpdate: vi.fn().mockResolvedValue(updateStatus("restarting")),
    ...overrides,
  } as unknown as ServiceConsoleApiClient;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useAppUpdate", () => {
  it("loads the local version immediately and checks for a release after 2.5 seconds", async () => {
    vi.useFakeTimers();
    const api = apiFixture();
    const onError = vi.fn();
    const { result } = renderHook(() => useAppUpdate({ api, onError }));

    await act(async () => { await Promise.resolve(); });
    expect(api.getAppUpdateStatus).toHaveBeenCalledOnce();
    expect(api.checkAppUpdate).not.toHaveBeenCalled();
    expect(result.current.status?.state).toBe("idle");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_499); });
    expect(api.checkAppUpdate).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.checkAppUpdate).toHaveBeenCalledOnce();
    expect(result.current.status?.state).toBe("available");
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not let a late initial status response overwrite an automatic check", async () => {
    vi.useFakeTimers();
    const initialStatus = deferred<AppUpdateStatus>();
    const api = apiFixture({
      getAppUpdateStatus: vi.fn().mockReturnValue(initialStatus.promise),
      checkAppUpdate: vi.fn().mockResolvedValue(updateStatus("available")),
    });
    const { result } = renderHook(() => useAppUpdate({ api, onError: vi.fn() }));

    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(result.current.status?.state).toBe("available");

    await act(async () => {
      initialStatus.resolve(updateStatus("idle", { latest_version: null }));
      await Promise.resolve();
    });
    expect(result.current.status?.state).toBe("available");
  });

  it("polls download progress until the update package is ready", async () => {
    vi.useFakeTimers();
    const pendingDownload = deferred<AppUpdateStatus>();
    const getStatus = vi.fn()
      .mockResolvedValueOnce(updateStatus("available"))
      .mockResolvedValue(updateStatus("downloading", {
        downloaded_bytes: 500,
        download_progress: 0.5,
      }));
    const api = apiFixture({
      getAppUpdateStatus: getStatus,
      downloadAppUpdate: vi.fn().mockReturnValue(pendingDownload.promise),
    });
    const { result } = renderHook(() => useAppUpdate({ api, onError: vi.fn() }));
    await act(async () => { await Promise.resolve(); });

    let operation!: Promise<AppUpdateStatus | null>;
    act(() => { operation = result.current.downloadUpdate(); });
    expect(result.current.operation).toBe("downloading");

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(getStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status).toMatchObject({ state: "downloading", downloaded_bytes: 500 });

    await act(async () => {
      pendingDownload.resolve(updateStatus("downloaded", {
        downloaded_bytes: 1_000,
        download_progress: 1,
      }));
      await operation;
    });
    expect(result.current.operation).toBeNull();
    expect(result.current.status?.state).toBe("downloaded");
  });

  it("serializes progress polls and ignores a poll response that arrives after completion", async () => {
    vi.useFakeTimers();
    const pendingPoll = deferred<AppUpdateStatus>();
    const pendingDownload = deferred<AppUpdateStatus>();
    const getStatus = vi.fn()
      .mockResolvedValueOnce(updateStatus("available"))
      .mockReturnValueOnce(pendingPoll.promise);
    const api = apiFixture({
      getAppUpdateStatus: getStatus,
      downloadAppUpdate: vi.fn().mockReturnValue(pendingDownload.promise),
    });
    const { result } = renderHook(() => useAppUpdate({ api, onError: vi.fn() }));
    await act(async () => { await Promise.resolve(); });

    let operation!: Promise<AppUpdateStatus | null>;
    act(() => { operation = result.current.downloadUpdate(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(getStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      pendingDownload.resolve(updateStatus("downloaded", {
        downloaded_bytes: 1_000,
        download_progress: 100,
      }));
      await operation;
    });
    expect(result.current.status?.state).toBe("downloaded");

    await act(async () => {
      pendingPoll.resolve(updateStatus("downloading", {
        downloaded_bytes: 500,
        download_progress: 50,
      }));
      await Promise.resolve();
    });
    expect(result.current.status?.state).toBe("downloaded");
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});
