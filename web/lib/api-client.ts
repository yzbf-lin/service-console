import {
  extractLogs,
  extractPorts,
  extractProcesses,
  extractServices,
  normalizeProcessCandidate,
  normalizeService,
} from "./service-logic";
import {
  extractJenkinsBuilds,
  extractJenkinsInstances,
  extractJenkinsJobs,
  extractJenkinsQueue,
  normalizeJenkinsBuild,
  normalizeJenkinsConnection,
  normalizeJenkinsInstance,
  normalizeJenkinsJob,
  normalizeJenkinsLog,
  normalizeJenkinsTrigger,
} from "./jenkins";
import type {
  AppUpdateStatus,
  JenkinsBuild,
  JenkinsBuildParameterValue,
  JenkinsBuildTriggerResult,
  JenkinsConnectionResult,
  JenkinsInstance,
  JenkinsInstanceInput,
  JenkinsJob,
  JenkinsLogChunk,
  JenkinsQueueItem,
  McpIntegrationStatus,
  NormalizedLogEntry,
  NormalizedPortRow,
  NormalizedProcessCandidate,
  NormalizedService,
  ProcessTerminateInput,
  ProcessTerminateResult,
  ServiceCreateInput,
  ServiceLifecycleAction,
  ServiceUpdateInput,
  ThemePreference,
} from "./types";
import { errorMessage, isRecord } from "./utils";

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function tokenFromSearch(search: string): string {
  return new URLSearchParams(search).get("token") || "";
}

export interface ApiClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
}

export interface ServiceConsoleApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  checkHealth(): Promise<boolean>;
  listServices(): Promise<NormalizedService[]>;
  createService(input: ServiceCreateInput): Promise<NormalizedService>;
  updateService(name: string, input: ServiceUpdateInput): Promise<NormalizedService>;
  deleteService(name: string): Promise<void>;
  runServiceAction(name: string, action: ServiceLifecycleAction): Promise<NormalizedService>;
  startService(name: string): Promise<NormalizedService>;
  stopService(name: string): Promise<NormalizedService>;
  restartService(name: string): Promise<NormalizedService>;
  getLogs(name: string, tail?: number): Promise<NormalizedLogEntry[]>;
  listPorts(port?: number | null): Promise<NormalizedPortRow[]>;
  listProcesses(query?: string): Promise<NormalizedProcessCandidate[]>;
  getProcess(pid: number): Promise<NormalizedProcessCandidate>;
  terminateProcess(pid: number, input: ProcessTerminateInput): Promise<ProcessTerminateResult>;
  updateTheme(theme: ThemePreference): Promise<ThemePreference>;
  getAppUpdateStatus(): Promise<AppUpdateStatus>;
  checkAppUpdate(): Promise<AppUpdateStatus>;
  downloadAppUpdate(): Promise<AppUpdateStatus>;
  installAppUpdate(): Promise<AppUpdateStatus>;
  getMcpIntegrationStatus(): Promise<McpIntegrationStatus>;
  installMcpIntegration(): Promise<McpIntegrationStatus>;
  testMcpIntegration(): Promise<McpIntegrationStatus>;
  removeMcpIntegration(): Promise<McpIntegrationStatus>;
  listJenkinsInstances(): Promise<JenkinsInstance[]>;
  createJenkinsInstance(input: JenkinsInstanceInput): Promise<JenkinsInstance>;
  updateJenkinsInstance(id: string, input: JenkinsInstanceInput): Promise<JenkinsInstance>;
  deleteJenkinsInstance(id: string): Promise<void>;
  testJenkinsInstance(id: string): Promise<JenkinsConnectionResult>;
  listJenkinsJobs(id: string, folder?: string, query?: string): Promise<JenkinsJob[]>;
  getJenkinsJob(id: string, job: string, includeParameterOptions?: boolean): Promise<JenkinsJob>;
  listJenkinsBuilds(id: string, job: string, limit?: number): Promise<JenkinsBuild[]>;
  getJenkinsBuild(id: string, job: string, number: number): Promise<JenkinsBuild>;
  triggerJenkinsBuild(
    id: string,
    job: string,
    parameters: Record<string, JenkinsBuildParameterValue>,
  ): Promise<JenkinsBuildTriggerResult>;
  stopJenkinsBuild(id: string, job: string, number: number): Promise<void>;
  listJenkinsQueue(id: string): Promise<JenkinsQueueItem[]>;
  cancelJenkinsQueueItem(id: string, queueId: number): Promise<void>;
  getJenkinsBuildLog(id: string, job: string, number: number, start?: number): Promise<JenkinsLogChunk>;
}

function responseRecord(payload: unknown, key: string): Record<string, unknown> {
  if (!isRecord(payload) || !isRecord(payload[key])) {
    throw new ApiError(`响应缺少 ${key} 字段`, 0, payload);
  }
  return payload[key];
}

function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path;
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function jenkinsPath(instanceId: string, suffix = ""): string {
  return `/api/jenkins/instances/${encodeURIComponent(instanceId)}${suffix}`;
}

function withQuery(path: string, values: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, String(value));
  });
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export function createApiClient(options: ApiClientOptions = {}): ServiceConsoleApiClient {
  const token = options.token || "";
  const baseUrl = options.baseUrl || "";
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const headers = new Headers(requestOptions.headers || {});
    headers.set("Accept", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);

    let body = requestOptions.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetcher(joinUrl(baseUrl, path), {
        ...requestOptions,
        headers,
        body: body as BodyInit | null | undefined,
      });
    } catch (error) {
      throw new ApiError(
        `连接服务端失败：${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      throw new ApiError(
        errorMessage(payload, `请求失败（HTTP ${response.status}）`),
        response.status,
        payload,
      );
    }
    return payload as T;
  }

  async function runServiceAction(
    name: string,
    action: ServiceLifecycleAction,
  ): Promise<NormalizedService> {
    const payload = await request<unknown>(`/api/services/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
    });
    return normalizeService(responseRecord(payload, "service"), name);
  }

  return {
    request,
    async checkHealth() {
      const payload = await request<unknown>("/api/health");
      if (!isRecord(payload) || payload.status === undefined) return true;
      return ["ok", "healthy"].includes(String(payload.status).toLowerCase());
    },
    async listServices() {
      return extractServices(await request<unknown>("/api/services"));
    },
    async createService(input) {
      const payload = await request<unknown>("/api/services", { method: "POST", body: input });
      return normalizeService(responseRecord(payload, "service"), input.name);
    },
    async updateService(name, input) {
      const payload = await request<unknown>(`/api/services/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: input,
      });
      return normalizeService(responseRecord(payload, "service"), name);
    },
    async deleteService(name) {
      await request<unknown>(`/api/services/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
    runServiceAction,
    startService(name) {
      return runServiceAction(name, "start");
    },
    stopService(name) {
      return runServiceAction(name, "stop");
    },
    restartService(name) {
      return runServiceAction(name, "restart");
    },
    async getLogs(name, tail = 500) {
      const query = new URLSearchParams({ tail: String(tail) });
      return extractLogs(await request<unknown>(
        `/api/services/${encodeURIComponent(name)}/logs?${query.toString()}`,
      ));
    },
    async listPorts(port = null) {
      const query = port === null || port === undefined ? "" : `?port=${encodeURIComponent(port)}`;
      return extractPorts(await request<unknown>(`/api/ports${query}`));
    },
    async listProcesses(query = "") {
      const search = query.trim();
      const suffix = search ? `?${new URLSearchParams({ query: search }).toString()}` : "";
      return extractProcesses(await request<unknown>(`/api/processes${suffix}`));
    },
    async getProcess(pid) {
      const payload = await request<unknown>(`/api/processes/${pid}`);
      return normalizeProcessCandidate(responseRecord(payload, "process"));
    },
    async terminateProcess(pid, input) {
      const payload = await request<unknown>(`/api/processes/${pid}/terminate`, {
        method: "POST",
        body: input,
      });
      return responseRecord(payload, "result") as unknown as ProcessTerminateResult;
    },
    async updateTheme(theme) {
      const payload = await request<unknown>("/api/ui-preferences", {
        method: "PUT",
        body: { theme },
        keepalive: true,
      });
      return isRecord(payload) && ["system", "light", "dark"].includes(String(payload.theme))
        ? payload.theme as ThemePreference
        : theme;
    },
    async getAppUpdateStatus() {
      const payload = await request<unknown>("/api/app-update");
      return responseRecord(payload, "update") as unknown as AppUpdateStatus;
    },
    async checkAppUpdate() {
      const payload = await request<unknown>("/api/app-update/check", { method: "POST" });
      return responseRecord(payload, "update") as unknown as AppUpdateStatus;
    },
    async downloadAppUpdate() {
      const payload = await request<unknown>("/api/app-update/download", { method: "POST" });
      return responseRecord(payload, "update") as unknown as AppUpdateStatus;
    },
    async installAppUpdate() {
      const payload = await request<unknown>("/api/app-update/install", { method: "POST" });
      return responseRecord(payload, "update") as unknown as AppUpdateStatus;
    },
    async getMcpIntegrationStatus() {
      const payload = await request<unknown>("/api/mcp-integration");
      return responseRecord(payload, "mcp") as unknown as McpIntegrationStatus;
    },
    async installMcpIntegration() {
      const payload = await request<unknown>("/api/mcp-integration/install", { method: "POST" });
      return responseRecord(payload, "mcp") as unknown as McpIntegrationStatus;
    },
    async testMcpIntegration() {
      const payload = await request<unknown>("/api/mcp-integration/test", { method: "POST" });
      return responseRecord(payload, "mcp") as unknown as McpIntegrationStatus;
    },
    async removeMcpIntegration() {
      const payload = await request<unknown>("/api/mcp-integration", { method: "DELETE" });
      return responseRecord(payload, "mcp") as unknown as McpIntegrationStatus;
    },
    async listJenkinsInstances() {
      return extractJenkinsInstances(await request<unknown>("/api/jenkins/instances"));
    },
    async createJenkinsInstance(input) {
      const payload = await request<unknown>("/api/jenkins/instances", { method: "POST", body: input });
      return normalizeJenkinsInstance(responseRecord(payload, "instance"));
    },
    async updateJenkinsInstance(id, input) {
      const payload = await request<unknown>(jenkinsPath(id), { method: "PUT", body: input });
      return normalizeJenkinsInstance(responseRecord(payload, "instance"));
    },
    async deleteJenkinsInstance(id) {
      await request<unknown>(jenkinsPath(id), { method: "DELETE" });
    },
    async testJenkinsInstance(id) {
      return normalizeJenkinsConnection(await request<unknown>(jenkinsPath(id, "/test"), { method: "POST" }));
    },
    async listJenkinsJobs(id, folder = "", query = "") {
      return extractJenkinsJobs(await request<unknown>(withQuery(jenkinsPath(id, "/jobs"), { folder, query })));
    },
    async getJenkinsJob(id, job, includeParameterOptions = false) {
      const payload = await request<unknown>(withQuery(jenkinsPath(id, "/job"), {
        job,
        include_parameter_options: includeParameterOptions || undefined,
      }));
      return normalizeJenkinsJob(responseRecord(payload, "job"));
    },
    async listJenkinsBuilds(id, job, limit = 30) {
      return extractJenkinsBuilds(await request<unknown>(withQuery(jenkinsPath(id, "/builds"), { job, limit })));
    },
    async getJenkinsBuild(id, job, number) {
      return normalizeJenkinsBuild(await request<unknown>(withQuery(
        jenkinsPath(id, `/builds/${number}`),
        { job },
      )));
    },
    async triggerJenkinsBuild(id, job, parameters) {
      return normalizeJenkinsTrigger(await request<unknown>(withQuery(jenkinsPath(id, "/builds"), { job }), {
        method: "POST",
        body: { parameters },
      }));
    },
    async stopJenkinsBuild(id, job, number) {
      await request<unknown>(withQuery(jenkinsPath(id, `/builds/${number}/stop`), { job }), { method: "POST" });
    },
    async listJenkinsQueue(id) {
      return extractJenkinsQueue(await request<unknown>(jenkinsPath(id, "/queue")));
    },
    async cancelJenkinsQueueItem(id, queueId) {
      await request<unknown>(jenkinsPath(id, `/queue/${queueId}/cancel`), { method: "POST" });
    },
    async getJenkinsBuildLog(id, job, number, start = 0) {
      return normalizeJenkinsLog(await request<unknown>(withQuery(
        jenkinsPath(id, `/builds/${number}/log`),
        { job, start },
      )));
    },
  };
}
