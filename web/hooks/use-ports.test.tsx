import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { usePorts } from "@/hooks/use-ports";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { NormalizedPortRow } from "@/lib/types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function portFixture(port: number, pid: number): NormalizedPortRow {
  return {
    protocol: "tcp",
    localAddress: "127.0.0.1",
    port,
    pid,
    processName: "python",
    command: "python app.py",
    username: "developer",
  };
}

describe("usePorts request ordering", () => {
  it("ignores an older scan that resolves after the latest filtered request", async () => {
    const olderRequest = deferred<NormalizedPortRow[]>();
    const latestRequest = deferred<NormalizedPortRow[]>();
    const api = {
      listPorts: vi.fn()
        .mockReturnValueOnce(olderRequest.promise)
        .mockReturnValueOnce(latestRequest.promise),
    } as unknown as ServiceConsoleApiClient;
    const onError = vi.fn();
    const { result } = renderHook(() => usePorts({ api, active: false, onError }));

    let olderLoad!: Promise<void>;
    act(() => {
      olderLoad = result.current.loadPorts();
    });

    act(() => {
      result.current.setFilter(8000);
    });
    expect(result.current.filter).toBe(8000);

    let latestLoad!: Promise<void>;
    act(() => {
      latestLoad = result.current.loadPorts();
    });

    const filteredPort = portFixture(8000, 80);
    await act(async () => {
      latestRequest.resolve([filteredPort]);
      await latestLoad;
    });
    expect(result.current.ports).toEqual([filteredPort]);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      olderRequest.resolve([filteredPort, portFixture(9000, 90)]);
      await olderLoad;
    });
    expect(result.current.ports).toEqual([filteredPort]);
    expect(result.current.loading).toBe(false);
    expect(api.listPorts).toHaveBeenNthCalledWith(1, null);
    expect(api.listPorts).toHaveBeenNthCalledWith(2, 8000);
    expect(onError).not.toHaveBeenCalled();
  });
});
