"use client";

import { create } from "zustand";

import type { ServiceConsoleApiClient } from "@/lib/api-client";
import {
  MAX_LOG_ENTRIES,
  mergeLogEntries,
  normalizeLogEntry,
  normalizeService,
} from "@/lib/service-logic";
import type {
  ConnectionState,
  NormalizedLogEntry,
  NormalizedService,
  ServiceCreateInput,
  ServiceGroupAction,
  ServiceLifecycleAction,
  ServiceUpdateInput,
  WsEvent,
} from "@/lib/types";
import { isRecord } from "@/lib/utils";

type ErrorReporter = (title: string, message: string) => void;

interface ServiceStoreState {
  api: ServiceConsoleApiClient | null;
  reportError: ErrorReporter;

  services: NormalizedService[];
  groups: string[];
  selectedName: string | null;
  selectedLogs: NormalizedLogEntry[];
  logRevision: number;
  busyServices: Set<string>;
  busyGroups: Set<string>;
  apiStatus: ConnectionState;
  socketStatus: ConnectionState;
  loading: boolean;

  /** Non-reactive working set, kept beside the rendered projection. */
  servicesByName: Map<string, NormalizedService>;
  logsByName: Map<string, NormalizedLogEntry[]>;
  logVersions: Map<string, number>;
  loadedLogs: Set<string>;

  configure: (api: ServiceConsoleApiClient, reportError: ErrorReporter) => void;
  setSocketStatus: (status: ConnectionState) => void;
  handleSocketMessage: (event: WsEvent) => void;

  commitServices: (next: Map<string, NormalizedService>) => void;
  mergeService: (service: NormalizedService) => void;
  appendLogs: (name: string, incoming: NormalizedLogEntry[], replace?: boolean) => void;
  selectService: (name: string) => void;
  loadServices: (options?: { silent?: boolean }) => Promise<void>;
  checkHealth: () => Promise<void>;
  loadLogs: (name: string, options?: { force?: boolean }) => Promise<void>;
  runAction: (name: string, action: ServiceLifecycleAction) => Promise<NormalizedService>;
  createGroup: (name: string) => Promise<string>;
  deleteGroup: (name: string) => Promise<NormalizedService[]>;
  assignGroup: (name: string, group: string | null, position?: number) => Promise<NormalizedService | undefined>;
  runGroupAction: (group: string, action: ServiceGroupAction) => Promise<{ services: NormalizedService[]; errors: { service: string; error: string }[] }>;
  createService: (input: ServiceCreateInput) => Promise<NormalizedService>;
  updateService: (name: string, input: ServiceUpdateInput) => Promise<NormalizedService>;
  deleteService: (name: string) => Promise<void>;
  clearVisibleLogs: () => void;
}

function sortedServices(next: Map<string, NormalizedService>): NormalizedService[] {
  return [...next.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function requireApi(state: ServiceStoreState): ServiceConsoleApiClient {
  if (!state.api) throw new Error("Service store is not configured yet");
  return state.api;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Single source of truth for services, groups, logs and connection state.
 *
 * The websocket/polling effects still live in `useServices` (they own browser
 * lifecycles), but every piece of data they touch lands here so any component
 * can subscribe to just the slice it renders.
 */
export const useServiceStore = create<ServiceStoreState>()((set, get) => ({
  api: null,
  reportError: () => undefined,

  services: [],
  groups: [],
  selectedName: null,
  selectedLogs: [],
  logRevision: 0,
  busyServices: new Set<string>(),
  busyGroups: new Set<string>(),
  apiStatus: "pending",
  socketStatus: "pending",
  loading: true,

  servicesByName: new Map<string, NormalizedService>(),
  logsByName: new Map<string, NormalizedLogEntry[]>(),
  logVersions: new Map<string, number>(),
  loadedLogs: new Set<string>(),

  configure: (api, reportError) => set({ api, reportError }),
  setSocketStatus: (socketStatus) => set({ socketStatus }),

  commitServices: (next) => {
    const sorted = sortedServices(next);
    const current = get().selectedName;
    let selectedName = current;
    let selectedLogs = get().selectedLogs;

    if (current && !next.has(current)) {
      selectedName = sorted[0]?.name ?? null;
      selectedLogs = selectedName ? get().logsByName.get(selectedName) ?? [] : [];
    } else if (!current && sorted.length) {
      selectedName = sorted[0].name;
      selectedLogs = get().logsByName.get(sorted[0].name) ?? [];
    }

    set({ servicesByName: next, services: sorted, selectedName, selectedLogs });
  },

  mergeService: (service) => {
    const next = new Map(get().servicesByName);
    next.set(service.name, service);
    get().commitServices(next);
  },

  appendLogs: (name, incoming, replace = false) => {
    const { logsByName, logVersions, selectedName } = get();
    const existing = logsByName.get(name) ?? [];
    const next = replace ? incoming.slice(-MAX_LOG_ENTRIES) : mergeLogEntries(existing, incoming);

    const nextLogs = new Map(logsByName);
    nextLogs.set(name, next);
    const nextVersions = new Map(logVersions);
    nextVersions.set(name, (logVersions.get(name) ?? 0) + 1);

    if (selectedName === name) {
      set({
        logsByName: nextLogs,
        logVersions: nextVersions,
        selectedLogs: next,
        logRevision: get().logRevision + 1,
      });
      return;
    }
    set({ logsByName: nextLogs, logVersions: nextVersions });
  },

  selectService: (name) => {
    if (!get().servicesByName.has(name)) return;
    set({ selectedName: name, selectedLogs: get().logsByName.get(name) ?? [] });
    void get().loadLogs(name);
  },

  loadLogs: async (name, { force = false } = {}) => {
    const state = get();
    if (!force && state.loadedLogs.has(name)) return;
    const versionAtRequest = state.logVersions.get(name) ?? 0;
    try {
      const fetched = await requireApi(state).getLogs(name, 500);
      const latest = get();
      const changedWhileLoading = (latest.logVersions.get(name) ?? 0) !== versionAtRequest;
      const next = changedWhileLoading
        ? mergeLogEntries(fetched, latest.logsByName.get(name) ?? [])
        : fetched;

      const nextLogs = new Map(latest.logsByName);
      nextLogs.set(name, next.slice(-MAX_LOG_ENTRIES));
      const nextVersions = new Map(latest.logVersions);
      nextVersions.set(name, (latest.logVersions.get(name) ?? 0) + 1);
      const nextLoaded = new Set(latest.loadedLogs);
      nextLoaded.add(name);

      set({
        logsByName: nextLogs,
        logVersions: nextVersions,
        loadedLogs: nextLoaded,
        ...(latest.selectedName === name
          ? { selectedLogs: nextLogs.get(name) ?? [], logRevision: latest.logRevision + 1 }
          : {}),
      });
    } catch (error) {
      if (!force) get().reportError("读取日志失败", messageOf(error));
    }
  },

  loadServices: async ({ silent = false } = {}) => {
    const state = get();
    try {
      const [nextServices, nextGroups] = await Promise.all([
        requireApi(state).listServices(),
        requireApi(state).listServiceGroups(),
      ]);
      get().commitServices(new Map(nextServices.map((service) => [service.name, service])));
      set({
        groups: nextGroups.sort((left, right) => left.localeCompare(right)),
        apiStatus: "ok",
        loading: false,
      });
    } catch (error) {
      set({ apiStatus: "error", loading: false });
      if (!silent) get().reportError("读取服务失败", messageOf(error));
    }
  },

  checkHealth: async () => {
    try {
      const healthy = await requireApi(get()).checkHealth();
      set({ apiStatus: healthy ? "ok" : "error" });
    } catch {
      set({ apiStatus: "error" });
    }
  },

  handleSocketMessage: (payload) => {
    const state = get();
    if (payload.type === "status" && typeof payload.service === "string" && isRecord(payload.data)) {
      const previous = state.servicesByName.get(payload.service);
      const raw = { ...(previous?.raw ?? {}), ...payload.data, name: payload.service };
      state.mergeService(normalizeService(raw, payload.service));
      return;
    }
    if (payload.type === "log" && typeof payload.service === "string") {
      state.appendLogs(payload.service, [normalizeLogEntry(payload.data)]);
    }
  },

  runAction: async (name, action) => {
    const service = await withBusyService(set, get, name, () => requireApi(get()).runServiceAction(name, action));
    get().mergeService(service);
    return service;
  },

  createGroup: async (name) => {
    const group = await requireApi(get()).createServiceGroup(name);
    const current = get().groups;
    if (!current.includes(group)) {
      set({ groups: [...current, group].sort((left, right) => left.localeCompare(right)) });
    }
    return group;
  },

  deleteGroup: async (name) => {
    const changed = await requireApi(get()).deleteServiceGroup(name);
    set({ groups: get().groups.filter((group) => group !== name) });
    changed.forEach((service) => get().mergeService(service));
    return changed;
  },

  assignGroup: async (name, group, position) => {
    const changed = await withBusyService(
      set,
      get,
      name,
      () => requireApi(get()).assignServiceGroup(name, group, position),
    );
    changed.forEach((service) => get().mergeService(service));
    return changed.find((service) => service.name === name);
  },

  runGroupAction: async (group, action) => {
    const names = [...get().servicesByName.values()]
      .filter((service) => service.group === group)
      .map((service) => service.name);

    set({
      busyGroups: new Set(get().busyGroups).add(group),
      busyServices: new Set([...get().busyServices, ...names]),
    });

    try {
      const result = await requireApi(get()).runServiceGroupAction(group, action);
      result.services.forEach((service) => get().mergeService(service));
      return result;
    } finally {
      const nextGroups = new Set(get().busyGroups);
      nextGroups.delete(group);
      const nextServices = new Set(get().busyServices);
      names.forEach((name) => nextServices.delete(name));
      set({ busyGroups: nextGroups, busyServices: nextServices });
    }
  },

  createService: async (input) => {
    const service = await withBusyService(
      set,
      get,
      input.name,
      () => requireApi(get()).createService(input),
    );
    get().mergeService(service);
    get().selectService(service.name);
    return service;
  },

  updateService: async (name, input) => {
    const service = await withBusyService(
      set,
      get,
      name,
      () => requireApi(get()).updateService(name, input),
    );
    get().mergeService(service);
    return service;
  },

  deleteService: async (name) => {
    await withBusyService(set, get, name, () => requireApi(get()).deleteService(name));
    const next = new Map(get().servicesByName);
    next.delete(name);

    const logsByName = new Map(get().logsByName);
    logsByName.delete(name);
    const logVersions = new Map(get().logVersions);
    logVersions.delete(name);
    const loadedLogs = new Set(get().loadedLogs);
    loadedLogs.delete(name);

    if (get().selectedName === name) {
      set({ selectedName: null, selectedLogs: [] });
    }
    set({ logsByName, logVersions, loadedLogs, logRevision: get().logRevision + 1 });
    get().commitServices(next);
  },

  clearVisibleLogs: () => {
    const selected = get().selectedName;
    if (!selected) return;
    const logsByName = new Map(get().logsByName);
    logsByName.set(selected, []);
    const logVersions = new Map(get().logVersions);
    logVersions.set(selected, (logVersions.get(selected) ?? 0) + 1);
    set({
      logsByName,
      logVersions,
      selectedLogs: [],
      logRevision: get().logRevision + 1,
    });
  },
}));

async function withBusyService<T>(
  set: (partial: Partial<ServiceStoreState>) => void,
  get: () => ServiceStoreState,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  set({ busyServices: new Set(get().busyServices).add(name) });
  try {
    return await operation();
  } finally {
    const next = new Set(get().busyServices);
    next.delete(name);
    set({ busyServices: next });
  }
}

/** Test-only escape hatch: restores the initial store shape. */
export function resetServiceStore(): void {
  useServiceStore.setState({
    api: null,
    reportError: () => undefined,
    services: [],
    groups: [],
    selectedName: null,
    selectedLogs: [],
    logRevision: 0,
    busyServices: new Set<string>(),
    busyGroups: new Set<string>(),
    apiStatus: "pending",
    socketStatus: "pending",
    loading: true,
    servicesByName: new Map(),
    logsByName: new Map(),
    logVersions: new Map(),
    loadedLogs: new Set(),
  });
}
