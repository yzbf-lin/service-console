import { describe, expect, it, vi } from "vitest";

import { createApiClient, tokenFromSearch } from "./api-client";
import {
  extractPorts,
  extractProcesses,
  extractServices,
  formatBytes,
  formatDuration,
  formatPercent,
  getServiceActionDisabled,
  mergeLogEntries,
  nextCopyName,
  normalizeLogEntry,
  normalizeProcessCandidate,
  normalizeService,
  parseEnvironment,
  sanitizeTerminalMessage,
  serializeEnvironment,
  serviceInputFromProcess,
} from "./service-logic";
import type { NormalizedLogEntry, ServiceState } from "./types";

describe("service normalization", () => {
  it("normalizes nested definitions, runtime values and metrics", () => {
    const service = normalizeService({
      definition: {
        name: "backend",
        group: "workers",
        command: "uv run backend/run.py",
        cwd: "/workspace",
        env: { PORT: 8000 },
        auto_start: true,
        stop_timeout: "12.5",
      },
      runtime: {
        state: "running",
        pid: "321",
        started_at: "2026-08-28T00:00:00Z",
        metrics: { cpu: "2.5", memory_rss: "4096" },
      },
    });

    expect(service).toMatchObject({
      name: "backend",
      group: "workers",
      command: "uv run backend/run.py",
      cwd: "/workspace",
      env: { PORT: "8000" },
      autoStart: true,
      stopTimeout: 12.5,
      status: "RUNNING",
      pid: 321,
      cpuPercent: 2.5,
      memoryBytes: 4096,
    });
  });

  it("accepts object and array service payloads and drops unnamed rows", () => {
    expect(extractServices({
      services: {
        worker: { command: "worker", state: "STOPPED" },
        api: { command: "api", state: "RUNNING" },
      },
    }).map((service) => service.name)).toEqual(["worker", "api"]);
    expect(extractServices([{ command: "missing name" }])).toEqual([]);
  });
});

describe("port normalization", () => {
  it("joins command arrays, removes invalid ports and sorts by port then pid", () => {
    const ports = extractPorts({ ports: [
      { protocol: "tcp", port: 9000, pid: 8, command: ["python", "app.py"] },
      { protocol: "udp", local_port: 8000, pid: 9 },
      { protocol: "tcp", port: 8000, pid: 2 },
      { port: 0, pid: 1 },
    ] });

    expect(ports.map(({ port, pid }) => [port, pid])).toEqual([[8000, 2], [8000, 9], [9000, 8]]);
    expect(ports[2]?.command).toBe("python app.py");
  });
});

describe("running process normalization", () => {
  it("normalizes commands, ports and safe environment from process responses", () => {
    const process = normalizeProcessCandidate({
      pid: "42",
      ppid: 1,
      create_time: "123.5",
      started_at: "2026-08-28T00:00:00Z",
      process_name: "celery",
      command: "uv run fba celery worker",
      cwd: "/workspace",
      username: "developer",
      ports: [9000, 0, 8000, 9000, 70_000],
      suggested_name: "QA worker",
      safe_env: { PYTHONUNBUFFERED: 1 },
      restorable: true,
      warnings: ["确认参数"],
      managed_service: null,
    });

    expect(process).toMatchObject({
      pid: 42,
      parentPid: 1,
      createTime: 123.5,
      processName: "celery",
      command: "uv run fba celery worker",
      cwd: "/workspace",
      ports: [8000, 9000],
      suggestedName: "QA worker",
      safeEnv: { PYTHONUNBUFFERED: "1" },
      restorable: true,
    });
  });

  it("rejects unexpected command arrays instead of losing argument boundaries", () => {
    const process = normalizeProcessCandidate({
      pid: 42,
      process_name: "python",
      command: ["python", "app.py", "--label", "hello world"],
      cwd: "/workspace",
      safe_env: {},
      restorable: true,
      warnings: [],
    });

    expect(process.command).toBe("");
    expect(process.restorable).toBe(false);
    expect(process.warnings).toContain("进程命令格式无效，无法安全恢复参数边界。");
  });

  it("drops invalid PIDs, marks incomplete candidates unavailable and creates unique service input", () => {
    expect(extractProcesses({ processes: [
      { pid: 0, process_name: "invalid", command: "x", cwd: "/tmp", restorable: true },
      { pid: 8, process_name: "python", command: "", cwd: "/tmp", restorable: true },
    ] })).toHaveLength(1);
    expect(extractProcesses({ processes: [
      { pid: 8, process_name: "python", command: "", cwd: "/tmp", restorable: true },
    ] })[0]?.restorable).toBe(false);

    const input = serviceInputFromProcess(normalizeProcessCandidate({
      pid: 9,
      process_name: "python",
      command: "python app.py",
      cwd: "/workspace",
      suggested_name: "QA worker",
      safe_env: { PYTHONUNBUFFERED: "1" },
      restorable: true,
    }), ["QA-worker"]);
    expect(input).toEqual({
      name: "QA-worker-2",
      group: null,
      command: "python app.py",
      cwd: "/workspace",
      env: { PYTHONUNBUFFERED: "1" },
      auto_start: false,
      stop_timeout: 10,
    });
  });
});

describe("formatters", () => {
  it("formats runtime, memory and percentages", () => {
    expect(formatDuration(3_661)).toBe("1时 1分");
    expect(formatDuration(-1)).toBe("—");
    expect(formatBytes(1_536)).toBe("1.50 KB");
    expect(formatPercent(0.25)).toBe("0.25%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("service action matrix", () => {
  const states: Record<ServiceState, ReturnType<typeof getServiceActionDisabled>> = {
    RUNNING: { start: true, stop: false, restart: false, edit: false, copy: false, delete: false },
    STARTING: { start: true, stop: false, restart: true, edit: true, copy: false, delete: false },
    STOPPING: { start: true, stop: true, restart: true, edit: true, copy: false, delete: false },
    STOPPED: { start: false, stop: true, restart: false, edit: false, copy: false, delete: false },
    EXITED: { start: false, stop: true, restart: false, edit: false, copy: false, delete: false },
    FAILED: { start: false, stop: true, restart: false, edit: false, copy: false, delete: false },
  };

  it.each(Object.entries(states))("applies the %s action rules", (status, expected) => {
    expect(getServiceActionDisabled(status as ServiceState)).toEqual(expected);
  });

  it("disables every action while a request is busy or status is unknown", () => {
    expect(Object.values(getServiceActionDisabled("RUNNING", true))).toEqual(Array(6).fill(true));
    expect(Object.values(getServiceActionDisabled("UNKNOWN"))).toEqual(Array(6).fill(true));
  });
});

describe("environment helpers", () => {
  it("parses JSON and KEY=VALUE formats without truncating values", () => {
    expect(parseEnvironment('{"PORT":8000,"ENABLED":true}')).toEqual({
      PORT: "8000",
      ENABLED: "true",
    });
    expect(parseEnvironment("# comment\nTOKEN=a=b=c\n EMPTY= ")).toEqual({
      TOKEN: "a=b=c",
      EMPTY: "",
    });
  });

  it("reports malformed input with the source line", () => {
    expect(() => parseEnvironment("GOOD=1\nBAD LINE")).toThrow("第 2 行");
    expect(() => parseEnvironment("9PORT=1")).toThrow("不合法");
    expect(() => parseEnvironment("[]")).toThrow("第 1 行");
  });

  it("serializes a non-empty environment as readable JSON", () => {
    expect(serializeEnvironment({ A: "1" })).toBe('{\n  "A": "1"\n}');
    expect(serializeEnvironment({})).toBe("");
  });

  it("generates bounded unique copy names", () => {
    expect(nextCopyName("worker", new Set(["worker-copy", "worker-copy-2"]))).toBe("worker-copy-3");
    const bounded = nextCopyName("x".repeat(80), [], 80);
    expect(bounded).toHaveLength(80);
    expect(bounded.endsWith("-copy")).toBe(true);
  });
});

describe("log safety and reconciliation", () => {
  it("normalizes primitive and aliased log rows", () => {
    expect(normalizeLogEntry("ready")).toEqual({ timestamp: null, stream: "stdout", message: "ready" });
    expect(normalizeLogEntry({ time: "now", channel: "STDERR", line: 42 })).toEqual({
      timestamp: "now",
      stream: "stderr",
      message: "42",
    });
  });

  it("keeps SGR colors while stripping title, clipboard and cursor controls", () => {
    const value = [
      "safe",
      "\u001b[31mred\u001b[0m",
      "\u001b]0;title\u0007",
      "\u001b]52;c;clipboard\u0007",
      "\u001b[2J",
      "\u001b[10;10H",
    ].join("");
    const sanitized = sanitizeTerminalMessage(value);
    expect(sanitized).toContain("\u001b[31mred\u001b[0m");
    expect(sanitized).not.toContain("title");
    expect(sanitized).not.toContain("clipboard");
    expect(sanitized).not.toContain("\u001b[2J");
    expect(sanitized).not.toContain("\u001b[10;10H");
  });

  it("deduplicates, sorts and caps REST/WS log reconciliation", () => {
    const first: NormalizedLogEntry = {
      timestamp: "2026-08-28T00:00:01Z",
      stream: "stdout",
      message: "first",
    };
    const second: NormalizedLogEntry = {
      timestamp: "2026-08-28T00:00:02Z",
      stream: "stderr",
      message: "second",
    };
    const result = mergeLogEntries([second], [first, second], 2);
    expect(result).toEqual([first, second]);
    expect(mergeLogEntries([first, second], [], 1)).toEqual([second]);
  });
});

describe("API client", () => {
  it("reads the desktop token and sends it as a Bearer header", async () => {
    expect(tokenFromSearch("?token=desktop-token&view=services")).toBe("desktop-token");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ status: "ok" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const client = createApiClient({ token: "desktop-token", fetch: fetchMock });

    await expect(client.checkHealth()).resolves.toBe(true);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer desktop-token");
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
  });

  it("serializes service payloads and URL-encodes names", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      service: {
        name: "api worker",
        command: "worker",
        cwd: "/tmp",
        env: {},
        auto_start: false,
        stop_timeout: 5,
        state: "RUNNING",
      },
    }), { status: 200 }));
    const client = createApiClient({ fetch: fetchMock });
    await client.restartService("api worker");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/services/api%20worker/restart");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("creates, assigns, controls, and deletes service groups", async () => {
    const service = {
      name: "api worker",
      group: "后端/核心",
      command: "worker",
      cwd: "/tmp",
      env: {},
      auto_start: false,
      stop_timeout: 5,
      state: "STOPPED",
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ groups: ["后端/核心"] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ group: "后端/核心" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ service }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: { group: "后端/核心", action: "start", services: [service], errors: [] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ services: [{ ...service, group: null }] }), { status: 200 }));
    const client = createApiClient({ fetch: fetchMock });

    await expect(client.listServiceGroups()).resolves.toEqual(["后端/核心"]);
    await expect(client.createServiceGroup("后端/核心")).resolves.toBe("后端/核心");
    await expect(client.assignServiceGroup("api worker", "后端/核心")).resolves.toMatchObject({ group: "后端/核心" });
    await expect(client.runServiceGroupAction("后端/核心", "start")).resolves.toMatchObject({
      group: "后端/核心",
      action: "start",
      services: [{ name: "api worker", group: "后端/核心" }],
      errors: [],
    });
    await expect(client.deleteServiceGroup("后端/核心")).resolves.toMatchObject([{ name: "api worker", group: null }]);

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/service-groups");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ name: "后端/核心" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/services/api%20worker/group");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ group: "后端/核心" });
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/service-groups/%E5%90%8E%E7%AB%AF%2F%E6%A0%B8%E5%BF%83/start");
    expect(fetchMock.mock.calls[4]?.[0]).toBe("/api/service-groups/%E5%90%8E%E7%AB%AF%2F%E6%A0%B8%E5%BF%83");
  });

  it("lists and reads normalized running processes", async () => {
    const payload = {
      pid: 42,
      ppid: 1,
      process_name: "python",
      command: "python app.py",
      cwd: "/workspace",
      ports: [8000],
      safe_env: {},
      restorable: true,
      warnings: [],
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ processes: [payload] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ process: payload }), { status: 200 }));
    const client = createApiClient({ fetch: fetchMock });

    await expect(client.listProcesses("python worker")).resolves.toMatchObject([
      { pid: 42, command: "python app.py", cwd: "/workspace" },
    ]);
    await expect(client.getProcess(42)).resolves.toMatchObject({ pid: 42, processName: "python" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/processes?query=python+worker");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/processes/42");
  });

  it("turns structured HTTP failures into ApiError", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      detail: [{ msg: "field required" }, { message: "invalid value" }],
    }), { status: 422 }));
    const client = createApiClient({ fetch: fetchMock });

    await expect(client.listServices()).rejects.toMatchObject({
      name: "ApiError",
      status: 422,
      message: "field required；invalid value",
    });
  });
});
