import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "@/lib/api-client";
import type { AppUpdateStatus } from "@/lib/types";

function updateStatus(state: AppUpdateStatus["state"]): AppUpdateStatus {
  return {
    state,
    current_version: "0.1.0",
    latest_version: "0.2.0",
    release_url: "https://github.com/yzbf-lin/service-console/releases/tag/v0.2.0",
    published_at: "2026-08-28T00:00:00Z",
    notes: "更新说明",
    platform: "darwin-arm64",
    platform_supported: true,
    can_install: true,
    reason: null,
    error: null,
    downloaded_bytes: 0,
    total_bytes: 1_024,
    download_progress: 0,
    downloaded: state === "downloaded" || state === "restarting",
    restart_required: false,
  };
}

describe("app update API client", () => {
  it("uses the status, check, download and install endpoints", async () => {
    const responses = ["idle", "available", "downloaded", "restarting"]
      .map((state) => new Response(JSON.stringify({
        update: updateStatus(state as AppUpdateStatus["state"]),
      }), { status: 200 }));
    const fetchMock = vi.fn<typeof fetch>();
    responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));
    const client = createApiClient({ fetch: fetchMock });

    await expect(client.getAppUpdateStatus()).resolves.toMatchObject({ state: "idle" });
    await expect(client.checkAppUpdate()).resolves.toMatchObject({ state: "available" });
    await expect(client.downloadAppUpdate()).resolves.toMatchObject({ state: "downloaded" });
    await expect(client.installAppUpdate()).resolves.toMatchObject({ state: "restarting" });

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/api/app-update", undefined],
      ["/api/app-update/check", "POST"],
      ["/api/app-update/download", "POST"],
      ["/api/app-update/install", "POST"],
    ]);
  });
});
