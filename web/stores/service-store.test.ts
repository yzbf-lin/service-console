import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { NormalizedLogEntry, NormalizedService } from "@/lib/types";
import { resetServiceStore, useServiceStore } from "@/stores/service-store";

function serviceFixture(overrides: Partial<NormalizedService> = {}): NormalizedService {
  return {
    name: "backend",
    group: null,
    sortOrder: 0,
    command: "uv run backend/run.py",
    cwd: "/workspace",
    env: {},
    autoStart: false,
    stopTimeout: 10,
    status: "STOPPED",
    pid: null,
    uptimeSeconds: null,
    startedAt: null,
    stoppedAt: null,
    cpuPercent: 0,
    memoryBytes: 0,
    memoryPercent: null,
    exitCode: null,
    restartCount: 0,
    lastError: null,
    raw: {},
    ...overrides,
  };
}

function logEntry(message: string, timestamp = "2026-08-28T00:00:00Z"): NormalizedLogEntry {
  return { timestamp, stream: "stdout", message };
}

function apiFixture(overrides: Partial<ServiceConsoleApiClient> = {}): ServiceConsoleApiClient {
  return {
    listServices: vi.fn().mockResolvedValue([serviceFixture()]),
    listServiceGroups: vi.fn().mockResolvedValue([]),
    checkHealth: vi.fn().mockResolvedValue(true),
    getLogs: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ServiceConsoleApiClient;
}

function configure(api: ServiceConsoleApiClient, onError = vi.fn()) {
  useServiceStore.getState().configure(api, onError);
  return onError;
}

describe("service store", () => {
  beforeEach(() => {
    resetServiceStore();
  });

  it("selects the first service and keeps the selection across refreshes", async () => {
    const api = apiFixture({
      listServices: vi.fn().mockResolvedValue([
        serviceFixture({ name: "worker" }),
        serviceFixture({ name: "backend" }),
      ]),
      listServiceGroups: vi.fn().mockResolvedValue(["平台", "工具"]),
    });
    configure(api);

    await useServiceStore.getState().loadServices();

    const state = useServiceStore.getState();
    expect(state.services.map((service) => service.name)).toEqual(["backend", "worker"]);
    expect(state.groups).toEqual(["工具", "平台"]);
    expect(state.selectedName).toBe("backend");
    expect(state.apiStatus).toBe("ok");
    expect(state.loading).toBe(false);
  });

  it("falls back to the first remaining service when the selection is deleted", async () => {
    const api = apiFixture({
      listServices: vi.fn().mockResolvedValue([
        serviceFixture({ name: "backend" }),
        serviceFixture({ name: "worker" }),
      ]),
      deleteService: vi.fn().mockResolvedValue(undefined),
    });
    configure(api);
    await useServiceStore.getState().loadServices();
    useServiceStore.getState().selectService("worker");

    await useServiceStore.getState().deleteService("worker");

    expect(useServiceStore.getState().services.map((service) => service.name)).toEqual(["backend"]);
    expect(useServiceStore.getState().selectedName).toBe("backend");
    expect(useServiceStore.getState().logsByName.has("worker")).toBe(false);
  });

  it("merges websocket log frames without dropping fetched history", async () => {
    const api = apiFixture({ getLogs: vi.fn().mockResolvedValue([logEntry("first")]) });
    configure(api);
    useServiceStore.setState({
      servicesByName: new Map([["backend", serviceFixture()]]),
      services: [serviceFixture()],
      selectedName: "backend",
    });

    await useServiceStore.getState().loadLogs("backend");
    useServiceStore.getState().handleSocketMessage({
      type: "log",
      service: "backend",
      data: { timestamp: "2026-08-28T00:00:01Z", stream: "stdout", message: "second" },
    });

    expect(useServiceStore.getState().selectedLogs.map((entry) => entry.message)).toEqual([
      "first",
      "second",
    ]);
    expect(useServiceStore.getState().logRevision).toBe(2);
  });

  it("keeps a websocket status frame from clearing logs", () => {
    configure(apiFixture());
    useServiceStore.setState({
      servicesByName: new Map([["backend", serviceFixture()]]),
      services: [serviceFixture()],
      selectedName: "backend",
      selectedLogs: [logEntry("before")],
    });

    useServiceStore.getState().handleSocketMessage({
      type: "status",
      service: "backend",
      data: { status: "RUNNING", pid: 4321 },
    });

    const state = useServiceStore.getState();
    expect(state.services[0].status).toBe("RUNNING");
    expect(state.services[0].pid).toBe(4321);
    expect(state.selectedLogs.map((entry) => entry.message)).toEqual(["before"]);
  });

  it("marks services busy for the duration of an action and reports failures", async () => {
    const failure = new Error("启动失败");
    const api = apiFixture({ runServiceAction: vi.fn().mockRejectedValue(failure) });
    configure(api);
    useServiceStore.setState({
      servicesByName: new Map([["backend", serviceFixture()]]),
      services: [serviceFixture()],
    });

    const pending = useServiceStore.getState().runAction("backend", "start");
    expect(useServiceStore.getState().busyServices.has("backend")).toBe(true);

    await expect(pending).rejects.toThrow("启动失败");
    expect(useServiceStore.getState().busyServices.has("backend")).toBe(false);
  });

  it("clears only the visible log buffer and bumps the revision", () => {
    configure(apiFixture());
    useServiceStore.setState({
      servicesByName: new Map([["backend", serviceFixture()]]),
      services: [serviceFixture()],
      selectedName: "backend",
      selectedLogs: [logEntry("first")],
      logsByName: new Map([["backend", [logEntry("first")]]]),
    });

    useServiceStore.getState().clearVisibleLogs();

    const state = useServiceStore.getState();
    expect(state.selectedLogs).toEqual([]);
    expect(state.logsByName.get("backend")).toEqual([]);
    expect(state.logRevision).toBe(1);
  });

  it("reports load failures unless the refresh is silent", async () => {
    const onError = configure(apiFixture({
      listServices: vi.fn().mockRejectedValue(new Error("offline")),
      listServiceGroups: vi.fn().mockResolvedValue([]),
    }));

    await useServiceStore.getState().loadServices({ silent: true });
    expect(onError).not.toHaveBeenCalled();
    expect(useServiceStore.getState().apiStatus).toBe("error");

    await useServiceStore.getState().loadServices();
    expect(onError).toHaveBeenCalledWith("读取服务失败", "offline");
  });
});
