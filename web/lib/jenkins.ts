import type {
  JenkinsBuild,
  JenkinsBuildTriggerResult,
  JenkinsConnectionResult,
  JenkinsInstance,
  JenkinsJob,
  JenkinsJobParameter,
  JenkinsLastBuild,
  JenkinsLogChunk,
  JenkinsQueueItem,
} from "./types";
import { isRecord } from "./utils";

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value);
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = number(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : value === undefined || value === null ? fallback : Boolean(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function envelope(payload: unknown, key: string): unknown {
  return isRecord(payload) && key in payload ? payload[key] : payload;
}

export function normalizeJenkinsInstance(value: unknown): JenkinsInstance {
  const source = record(value);
  return {
    id: text(source.id),
    name: text(source.name, "未命名 Jenkins"),
    baseUrl: text(source.base_url ?? source.baseUrl),
    username: text(source.username),
    caBundle: text(source.ca_bundle ?? source.caBundle),
    enabled: bool(source.enabled, true),
    requestTimeout: number(source.request_timeout ?? source.requestTimeout, 15),
    tokenPresent: bool(source.token_present ?? source.tokenPresent),
    credentialError: source.credential_error === null || source.credential_error === undefined
      ? null
      : text(source.credential_error),
  };
}

export function extractJenkinsInstances(payload: unknown): JenkinsInstance[] {
  return records(envelope(payload, "instances"))
    .map(normalizeJenkinsInstance)
    .filter((instance) => instance.id);
}

export function normalizeJenkinsConnection(payload: unknown): JenkinsConnectionResult {
  const source = record(envelope(payload, "connection"));
  return {
    ok: bool(source.ok),
    version: source.version === null || source.version === undefined ? null : text(source.version),
    url: text(source.url),
  };
}

function normalizeBuild(value: unknown): JenkinsBuild {
  const source = record(value);
  return {
    number: number(source.number),
    url: text(source.url),
    displayName: text(source.display_name ?? source.displayName, `#${number(source.number)}`),
    fullDisplayName: text(source.full_display_name ?? source.fullDisplayName),
    building: bool(source.building),
    result: source.result === null || source.result === undefined ? null : text(source.result),
    status: text(source.status, bool(source.building) ? "RUNNING" : text(source.result, "UNKNOWN")),
    timestamp: nullableNumber(source.timestamp),
    duration: number(source.duration),
    estimatedDuration: number(source.estimated_duration ?? source.estimatedDuration),
    queueId: nullableNumber(source.queue_id ?? source.queueId),
    description: text(source.description),
  };
}

function normalizeLastBuild(value: unknown): JenkinsLastBuild | null {
  if (!isRecord(value)) return null;
  const build = normalizeBuild(value);
  if (build.number <= 0) return null;
  return {
    number: build.number,
    url: build.url,
    building: build.building,
    result: build.result,
    status: build.status,
  };
}

function normalizeParameter(value: unknown): JenkinsJobParameter {
  const source = record(value);
  const defaultValue = source.default ?? source.default_value ?? source.defaultValue;
  const rawType = text(source.type, "string").toLowerCase();
  const type = rawType.includes("boolean")
    ? "boolean"
    : rawType.includes("choice")
      ? "choice"
      : rawType.includes("password")
        ? "password"
        : ["int", "integer", "number", "float", "double"].some((candidate) => rawType.includes(candidate))
          ? "number"
          : ["file", "credentials", "run", "text", "string"].find((candidate) => rawType === candidate || rawType.includes(`${candidate}parameter`)) ?? "string";
  return {
    name: text(source.name),
    type,
    rawType: text(source.raw_type ?? source.rawType ?? source.type),
    description: text(source.description),
    defaultValue: ["string", "number", "boolean"].includes(typeof defaultValue)
      ? defaultValue as string | number | boolean
      : null,
    choices: Array.isArray(source.choices) ? source.choices.map((choice) => text(choice)) : [],
  };
}

export function normalizeJenkinsJob(value: unknown): JenkinsJob {
  const source = record(value);
  return {
    name: text(source.name),
    fullName: text(source.full_name ?? source.fullName ?? source.name),
    url: text(source.url),
    kind: text(source.kind, "job"),
    color: text(source.color),
    status: text(source.status, "UNKNOWN"),
    buildable: bool(source.buildable, true),
    inQueue: bool(source.in_queue ?? source.inQueue),
    description: text(source.description),
    parameters: records(source.parameters).map(normalizeParameter).filter((parameter) => parameter.name),
    lastBuild: normalizeLastBuild(source.last_build ?? source.lastBuild),
  };
}

export function extractJenkinsJobs(payload: unknown): JenkinsJob[] {
  return records(envelope(payload, "jobs")).map(normalizeJenkinsJob).filter((job) => job.fullName);
}

export function extractJenkinsBuilds(payload: unknown): JenkinsBuild[] {
  return records(envelope(payload, "builds")).map(normalizeBuild).filter((build) => build.number > 0);
}

export function normalizeJenkinsBuild(payload: unknown): JenkinsBuild {
  return normalizeBuild(envelope(payload, "build"));
}

export function extractJenkinsQueue(payload: unknown): JenkinsQueueItem[] {
  return records(envelope(payload, "queue")).map((value) => {
    const task = record(value.task);
    const executable = record(value.executable);
    return {
      id: number(value.id),
      url: text(value.url),
      blocked: bool(value.blocked),
      buildable: bool(value.buildable),
      stuck: bool(value.stuck),
      why: text(value.why),
      taskName: text(task.name),
      taskFullName: text(task.full_name ?? task.fullName ?? task.name),
      taskUrl: text(task.url),
      executableNumber: nullableNumber(executable.number),
      executableUrl: text(executable.url),
    };
  }).filter((item) => item.id > 0);
}

export function normalizeJenkinsTrigger(payload: unknown): JenkinsBuildTriggerResult {
  const source = record(envelope(payload, "queue"));
  return {
    id: nullableNumber(source.id),
    url: text(source.url),
    location: text(source.location),
  };
}

export function normalizeJenkinsLog(payload: unknown): JenkinsLogChunk {
  const source = record(envelope(payload, "log"));
  const offset = number(source.offset);
  return {
    job: text(source.job),
    number: number(source.number),
    offset,
    nextOffset: number(source.next_offset ?? source.nextOffset, offset),
    text: text(source.text),
    more: bool(source.more ?? source.more_data ?? source.moreData),
    complete: bool(source.complete),
  };
}
