import {
  extractLogs,
  extractPorts,
  extractProcesses,
  extractServices,
  normalizeProcessCandidate,
  normalizeService,
} from "./service-logic";
import type {
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
  };
}
