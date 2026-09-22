import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "@/lib/api-client";

afterEach(() => vi.useRealTimers());

describe("application diagnostic API client", () => {
  it("reads a bounded snapshot with authentication and cancellation", async () => {
    const snapshot = { logs: [], path: "logs/service-console.log", max_file_bytes: 1_048_576, retained_files: 3 };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot)));
    const api = createApiClient({ token: "test-token", fetch: fetchMock });
    const controller = new AbortController();
    await expect(api.getAppLogs(controller.signal)).resolves.toEqual(snapshot);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/app-logs?limit=500");
    const options = fetchMock.mock.calls[0][1]!;
    expect(new Headers(options.headers).get("Authorization")).toBe("Bearer test-token");
    expect(options.signal).toBe(controller.signal);
    expect(options.cache).toBe("no-store");
  });

  it("bounds, redacts and deduplicates reports without recursively reporting transport errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
    const api = createApiClient({ token: "private-token", fetch: fetchMock });
    const message = `failure private-token ${"x".repeat(5_000)}`;
    await api.reportClientError("ui.error", message);
    await api.reportClientError("ui.error", message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.message).not.toContain("private-token");
    expect(body.message).toContain("[redacted]");
    expect(body.message).toHaveLength(4_000);
    expect(body.event).toBe("ui.error");
    await vi.advanceTimersByTimeAsync(60_001);
    await api.reportClientError("ui.error", message);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
