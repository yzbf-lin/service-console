export const SERVICE_STATES = [
  "STOPPED",
  "STARTING",
  "RUNNING",
  "STOPPING",
  "EXITED",
  "FAILED",
] as const;

export type ServiceState = (typeof SERVICE_STATES)[number];
export type ServiceStatus = ServiceState | "UNKNOWN";
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;
export type ViewId = "services" | "ports" | "settings";
export type ConnectionState = "pending" | "ok" | "error";

export const APP_UPDATE_STATES = [
  "idle",
  "checking",
  "up_to_date",
  "available",
  "unsupported",
  "downloading",
  "downloaded",
  "installing",
  "restarting",
  "error",
] as const;

export type AppUpdateState = (typeof APP_UPDATE_STATES)[number];

export const MCP_INTEGRATION_STATES = [
  "unavailable",
  "not_installed",
  "installed",
  "conflict",
  "error",
] as const;

export type McpIntegrationState = (typeof MCP_INTEGRATION_STATES)[number];

export interface McpTestResult {
  ok: boolean;
  tested_at: string;
  error: string | null;
}

export interface McpIntegrationStatus {
  state: McpIntegrationState;
  transport: "stdio";
  controller_ready: boolean;
  bridge_available: boolean;
  codex_cli_available: boolean;
  codex_registered: boolean;
  server_name: string;
  bridge_command: string | null;
  bridge_args: string[];
  config_snippet: string | null;
  tools: string[];
  last_test: McpTestResult | null;
  error: string | null;
}

export interface AppUpdateStatus {
  state: AppUpdateState;
  current_version: string;
  latest_version: string | null;
  release_url: string | null;
  published_at: string | null;
  notes: string | null;
  platform: string;
  platform_supported: boolean;
  can_install: boolean;
  reason: string | null;
  error: string | null;
  downloaded_bytes: number;
  total_bytes: number | null;
  download_progress: number | null;
  downloaded: boolean;
  restart_required: boolean;
}

export interface ServiceDefinition {
  name: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  auto_start: boolean;
  stop_timeout: number;
}

export type ServiceCreateInput = ServiceDefinition;
export type ServiceUpdateInput = Omit<ServiceDefinition, "name">;

export interface ServiceSnapshot extends ServiceDefinition {
  state: ServiceState;
  pid: number | null;
  exit_code: number | null;
  started_at: string | null;
  stopped_at: string | null;
  cpu_percent: number;
  memory_rss: number;
  uptime_seconds: number;
  restart_count: number;
  last_error: string | null;
}

export interface NormalizedService {
  name: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  autoStart: boolean;
  stopTimeout: number;
  status: ServiceStatus;
  pid: number | null;
  uptimeSeconds: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryPercent: number | null;
  exitCode: number | null;
  restartCount: number | null;
  lastError: string | null;
  raw: Record<string, unknown>;
}

export interface LogEntry {
  timestamp: string;
  stream: string;
  message: string;
}

export interface NormalizedLogEntry {
  timestamp: string | null;
  stream: string;
  message: string;
}

export interface PortRow {
  protocol: string;
  local_address: string;
  port: number;
  pid: number | null;
  process_name: string | null;
  command: string | string[] | null;
  username: string | null;
}

export interface NormalizedPortRow {
  protocol: string;
  localAddress: string;
  port: number;
  pid: number | null;
  processName: string;
  command: string;
  username: string;
}

export interface ProcessCandidate {
  pid: number;
  ppid: number | null;
  create_time: number | null;
  started_at: string | null;
  process_name: string | null;
  command: string | null;
  cwd: string | null;
  username: string | null;
  ports: number[];
  suggested_name: string | null;
  safe_env: Record<string, string>;
  restorable: boolean;
  warnings: string[];
  managed_service: string | null;
}

export interface NormalizedProcessCandidate {
  pid: number;
  parentPid: number | null;
  createTime: number | null;
  startedAt: string | null;
  processName: string;
  command: string;
  cwd: string;
  username: string;
  ports: number[];
  suggestedName: string;
  safeEnv: Record<string, string>;
  restorable: boolean;
  warnings: string[];
  managedService: string | null;
}

export type ServiceLifecycleAction = "start" | "stop" | "restart";
export type ServiceDefinitionAction = "edit" | "copy" | "delete";
export type ServiceAction = ServiceLifecycleAction | ServiceDefinitionAction;
export type ServiceActionDisabled = Record<ServiceAction, boolean>;

export interface ProcessTerminateInput {
  expected_port: number | null;
  force: boolean;
  timeout: number;
}

export interface ProcessTerminateResult {
  pid: number;
  expected_port: number | null;
  action: "terminate" | "kill" | string;
  force: boolean;
  terminated: boolean;
  exit_code: number | null;
}

export interface WsStatusEvent {
  type: "status";
  service: string;
  data: unknown;
}

export interface WsLogEvent {
  type: "log";
  service: string;
  data: unknown;
}

export interface WsCommandResultEvent {
  type: "command_result";
  id: unknown;
  action?: unknown;
  service?: unknown;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type WsEvent = WsStatusEvent | WsLogEvent | WsCommandResultEvent;

export interface WsLifecycleCommand {
  id: string;
  action: ServiceLifecycleAction;
  service: string;
}
