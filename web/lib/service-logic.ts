import {
  SERVICE_STATES,
  type NormalizedLogEntry,
  type NormalizedPortRow,
  type NormalizedService,
  type ServiceActionDisabled,
  type ServiceState,
  type ServiceStatus,
} from "./types";
import { isRecord } from "./utils";

export const MAX_LOG_ENTRIES = 2_000;

const SERVICE_STATE_SET = new Set<string>(SERVICE_STATES);

function asNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
  }
  return null;
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value);
}

function normalizeEnvironment(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

export function normalizeServiceState(value: unknown, fallback: ServiceState = "STOPPED"): ServiceStatus {
  if (value === null || value === undefined || value === "") return fallback;
  const normalized = String(value).toUpperCase();
  return SERVICE_STATE_SET.has(normalized) ? (normalized as ServiceState) : "UNKNOWN";
}

export function normalizeService(raw: unknown, fallbackName = ""): NormalizedService {
  const source = isRecord(raw) ? raw : {};
  const definition = isRecord(source.definition) ? source.definition : {};
  const runtime = isRecord(source.runtime) ? source.runtime : {};
  const metrics = isRecord(source.metrics)
    ? source.metrics
    : isRecord(runtime.metrics)
      ? runtime.metrics
      : {};
  const env = source.env ?? definition.env;

  return {
    name: String(source.name ?? definition.name ?? fallbackName),
    command: String(source.command ?? definition.command ?? ""),
    cwd: String(source.cwd ?? definition.cwd ?? ""),
    env: normalizeEnvironment(env),
    autoStart: Boolean(source.auto_start ?? definition.auto_start ?? false),
    stopTimeout: asNumber(source.stop_timeout, definition.stop_timeout) ?? 10,
    status: normalizeServiceState(source.status ?? source.state ?? runtime.status ?? runtime.state),
    pid: asNumber(source.pid, runtime.pid),
    uptimeSeconds: asNumber(
      source.uptime_seconds,
      source.uptime,
      runtime.uptime_seconds,
      runtime.uptime,
    ),
    startedAt: asNullableString(
      source.started_at ?? source.start_time ?? runtime.started_at ?? runtime.start_time,
    ),
    stoppedAt: asNullableString(source.stopped_at ?? runtime.stopped_at),
    cpuPercent: asNumber(
      source.cpu_percent,
      source.cpu,
      runtime.cpu_percent,
      runtime.cpu,
      metrics.cpu_percent,
      metrics.cpu,
    ),
    memoryBytes: asNumber(
      source.memory_bytes,
      source.memory_rss,
      runtime.memory_bytes,
      runtime.memory_rss,
      metrics.memory_bytes,
      metrics.memory_rss,
    ),
    memoryPercent: asNumber(source.memory_percent, runtime.memory_percent, metrics.memory_percent),
    exitCode: asNumber(source.exit_code, runtime.exit_code),
    restartCount: asNumber(source.restart_count, runtime.restart_count),
    lastError: asNullableString(source.last_error ?? runtime.last_error),
    raw: source,
  };
}

export function extractServices(payload: unknown): NormalizedService[] {
  let services: unknown = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? payload.services ?? payload.data ?? []
      : [];

  if (isRecord(services)) {
    services = Object.entries(services).map(([name, service]) => ({
      name,
      ...(isRecord(service) ? service : {}),
    }));
  }

  return Array.isArray(services)
    ? services.map((service) => normalizeService(service)).filter((service) => service.name)
    : [];
}

export function normalizePort(raw: unknown): NormalizedPortRow {
  const source = isRecord(raw) ? raw : {};
  const commandValue = source.command ?? source.cmdline ?? "";
  const command = Array.isArray(commandValue)
    ? commandValue.map(String).join(" ")
    : String(commandValue || "");

  return {
    protocol: String(source.protocol ?? "tcp").toUpperCase(),
    localAddress: String(source.local_address ?? source.address ?? ""),
    port: asNumber(source.port, source.local_port) ?? Number.NaN,
    pid: asNumber(source.pid),
    processName: String(source.process_name ?? source.name ?? "未知进程"),
    command,
    username: String(source.username ?? source.user ?? "—"),
  };
}

export function extractPorts(payload: unknown): NormalizedPortRow[] {
  const ports = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? payload.ports ?? payload.data ?? []
      : [];
  if (!Array.isArray(ports)) return [];

  return ports
    .map(normalizePort)
    .filter((item) => Number.isInteger(item.port) && item.port >= 1 && item.port <= 65_535)
    .sort((left, right) => left.port - right.port || (left.pid ?? 0) - (right.pid ?? 0));
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds) || (seconds as number) < 0) return "—";
  const whole = Math.floor(seconds as number);
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const remainingSeconds = whole % 60;
  if (days > 0) return `${days}天 ${hours}时`;
  if (hours > 0) return `${hours}时 ${minutes}分`;
  if (minutes > 0) return `${minutes}分 ${remainingSeconds}秒`;
  return `${remainingSeconds}秒`;
}

export function currentUptime(service: NormalizedService, now = Date.now()): number | null {
  if (service.status !== "RUNNING" && service.status !== "STARTING") return null;
  if (service.startedAt) {
    const startedAt = new Date(service.startedAt).getTime();
    if (Number.isFinite(startedAt)) return Math.max(0, (now - startedAt) / 1_000);
  }
  return service.uptimeSeconds;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!Number.isFinite(bytes) || (bytes as number) < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes as number;
  let index = 0;
  while (value >= 1_024 && index < units.length - 1) {
    value /= 1_024;
    index += 1;
  }
  const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value as number).toFixed((value as number) >= 10 ? 1 : 2)}%`;
}

export function statusLabel(status: ServiceStatus): string {
  const labels: Record<ServiceStatus, string> = {
    RUNNING: "运行中",
    STARTING: "启动中",
    STOPPING: "停止中",
    STOPPED: "已停止",
    EXITED: "已退出",
    FAILED: "失败",
    UNKNOWN: "未知",
  };
  return labels[status];
}

export function getServiceActionDisabled(
  status: ServiceStatus,
  isBusy = false,
): ServiceActionDisabled {
  if (isBusy || status === "UNKNOWN") {
    return { start: true, stop: true, restart: true, edit: true, copy: true, delete: true };
  }

  const active = status === "RUNNING" || status === "STARTING" || status === "STOPPING";
  const transitioning = status === "STARTING" || status === "STOPPING";
  return {
    start: active,
    stop: !active || status === "STOPPING",
    restart: transitioning,
    edit: transitioning,
    copy: false,
    delete: false,
  };
}

export function normalizeLogEntry(entry: unknown): NormalizedLogEntry {
  if (typeof entry === "string" || typeof entry === "number") {
    return { timestamp: null, stream: "stdout", message: String(entry) };
  }
  const source = isRecord(entry) ? entry : {};
  return {
    timestamp: asNullableString(source.timestamp ?? source.time ?? source.created_at),
    stream: String(source.stream ?? source.channel ?? "stdout").toLowerCase(),
    message: String(source.message ?? source.line ?? source.text ?? ""),
  };
}

export function extractLogs(payload: unknown): NormalizedLogEntry[] {
  const logs = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? payload.logs ?? payload.data ?? []
      : [];
  const entries = Array.isArray(logs) ? logs : [logs];
  return entries.map(normalizeLogEntry);
}

function logEntryKey(entry: NormalizedLogEntry): string {
  return `${entry.timestamp ?? ""}\u0000${entry.stream}\u0000${entry.message}`;
}

export function mergeLogEntries(
  existing: readonly NormalizedLogEntry[],
  incoming: readonly NormalizedLogEntry[],
  maxEntries = MAX_LOG_ENTRIES,
): NormalizedLogEntry[] {
  if (!Number.isInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError("maxEntries must be a non-negative integer");
  }
  const seen = new Set<string>();
  const merged: NormalizedLogEntry[] = [];
  for (const entry of [...existing, ...incoming]) {
    const key = logEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  merged.sort((left, right) => {
    const leftTime = Date.parse(left.timestamp || "");
    const rightTime = Date.parse(right.timestamp || "");
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    return leftTime - rightTime;
  });
  return maxEntries === 0 ? [] : merged.slice(-maxEntries);
}

export function formatLogTime(timestamp: string | null | undefined): string {
  if (!timestamp) return "--:--:--.---";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp.slice(0, 12);
  const base = new Intl.DateTimeFormat("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
  return `${base}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

export function sanitizeTerminalMessage(message: unknown): string {
  return String(message)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[P^_X][\s\S]*?\u001b\\/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, (sequence) => (
      /^\u001b\[[0-9;:]*m$/.test(sequence) ? sequence : ""
    ))
    .replace(/\u001b\][^\r\n]*/g, "")
    .replace(/\u001b(?!\[[0-9;:]*m)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

export function formatTerminalEntry(entry: NormalizedLogEntry): string {
  const timestamp = formatLogTime(entry.timestamp).replace(/[\u0000-\u001f\u007f]/g, "");
  const streamName = String(entry.stream || "stdout")
    .replace(/[^a-z0-9_-]/gi, "")
    .slice(0, 8)
    .toUpperCase() || "STDOUT";
  const paddedStream = streamName.padEnd(8, " ");
  const streamColor = streamName === "STDERR" ? "\u001b[31m" : "\u001b[90m";
  return `\u001b[90m${timestamp}\u001b[0m ${streamColor}${paddedStream}\u001b[0m ${sanitizeTerminalMessage(entry.message)}\u001b[0m\r\n`;
}

export function parseEnvironment(value: string): Record<string, string> {
  const text = value.trim();
  if (!text) return {};
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`环境变量 JSON 格式错误：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(parsed)) throw new Error("环境变量 JSON 必须是对象");
    return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]));
  }

  const environment: Record<string, string> = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`环境变量第 ${index + 1} 行应为 KEY=VALUE`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`环境变量名“${key}”不合法`);
    }
    environment[key] = line.slice(separator + 1);
  }
  return environment;
}

export function serializeEnvironment(environment: unknown): string {
  if (!isRecord(environment)) return "";
  return Object.keys(environment).length ? JSON.stringify(environment, null, 2) : "";
}

type NameLookup = Iterable<string> | { has(name: string): boolean };

function nameExists(names: NameLookup, candidate: string): boolean {
  const lookup = names as { has?: (name: string) => boolean };
  if (typeof lookup.has === "function") return lookup.has(candidate);
  return new Set(names as Iterable<string>).has(candidate);
}

export function nextCopyName(sourceName: string, existingNames: NameLookup = [], maxLength = 80): string {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive integer");
  }
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "-copy" : `-copy-${index}`;
    const base = sourceName.slice(0, Math.max(1, maxLength - suffix.length));
    const candidate = `${base}${suffix}`.slice(0, maxLength);
    if (!nameExists(existingNames, candidate)) return candidate;
  }
}
