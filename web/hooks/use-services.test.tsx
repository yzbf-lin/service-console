import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useServices } from "@/hooks/use-services";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { NormalizedLogEntry, NormalizedService } from "@/lib/types";

const { createApiClientMock } = vi.hoisted(() => ({
  createApiClientMock: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  createApiClient: createApiClientMock,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type FakeSocketListener = (event: MessageEvent<string>) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  private readonly listeners = new Map<string, Set<FakeSocketListener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: FakeSocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeSocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {}

  emitMessage(data: unknown): void {
    const event = new MessageEvent<string>("message", { data: JSON.stringify(data) });
    this.listeners.get("message")?.forEach((listener) => listener(event));
  }
}

function serviceFixture(): NormalizedService {
  return {
    name: "backend",
    command: "uv run backend/run.py",
    cwd: "/workspace",
    env: {},
    autoStart: false,
    stopTimeout: 10,
    status: "RUNNING",
    pid: 123,
    uptimeSeconds: 60,
    startedAt: null,
    stoppedAt: null,
    cpuPercent: 0,
    memoryBytes: 0,
    memoryPercent: null,
    exitCode: null,
    restartCount: 0,
    lastError: null,
    raw: {},
  };
}

describe("useServices log reconciliation", () => {
  beforeEach(() => {
    createApiClientMock.mockReset();
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves WebSocket logs when a concurrent REST log request fails", async () => {
    const logRequest = deferred<NormalizedLogEntry[]>();
    const api = {
      listServices: vi.fn().mockResolvedValue([serviceFixture()]),
      checkHealth: vi.fn().mockResolvedValue(true),
      getLogs: vi.fn().mockReturnValue(logRequest.promise),
    } as unknown as ServiceConsoleApiClient;
    const onError = vi.fn();
    createApiClientMock.mockReturnValue(api);

    const { result } = renderHook(() => useServices({ token: "", enabled: true, onError }));

    await waitFor(() => expect(api.getLogs).toHaveBeenCalledWith("backend", 500));
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket?.emitMessage({
        type: "log",
        service: "backend",
        data: { timestamp: "2026-08-28T00:00:01Z", stream: "stdout", message: "during request" },
      });
    });
    expect(result.current.selectedLogs.map((entry) => entry.message)).toEqual(["during request"]);

    await act(async () => {
      logRequest.reject(new Error("REST unavailable"));
      await Promise.resolve();
    });
    await waitFor(() => expect(onError).toHaveBeenCalledWith("读取日志失败", "REST unavailable"));

    act(() => {
      socket?.emitMessage({
        type: "log",
        service: "backend",
        data: { timestamp: "2026-08-28T00:00:02Z", stream: "stdout", message: "after failure" },
      });
    });
    expect(result.current.selectedLogs.map((entry) => entry.message)).toEqual([
      "during request",
      "after failure",
    ]);
  });
});
