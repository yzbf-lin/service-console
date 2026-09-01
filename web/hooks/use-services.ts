"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createApiClient } from "@/lib/api-client";
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

const SERVICE_POLL_INTERVAL = 5_000;
const HEALTH_POLL_INTERVAL = 15_000;

interface UseServicesOptions {
  token: string;
  enabled: boolean;
  onError: (title: string, message: string) => void;
}

function websocketUrl(token: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/ws/events`);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export function useServices({ token, enabled, onError }: UseServicesOptions) {
  const api = useMemo(() => createApiClient({ token }), [token]);
  const servicesRef = useRef(new Map<string, NormalizedService>());
  const logsRef = useRef(new Map<string, NormalizedLogEntry[]>());
  const logVersionsRef = useRef(new Map<string, number>());
  const loadedLogsRef = useRef(new Set<string>());
  const selectedNameRef = useRef<string | null>(null);
  const reconnectAttemptRef = useRef(0);

  const [services, setServices] = useState<NormalizedService[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [selectedName, setSelectedNameState] = useState<string | null>(null);
  const [selectedLogs, setSelectedLogs] = useState<NormalizedLogEntry[]>([]);
  const [logRevision, setLogRevision] = useState(0);
  const [busyServices, setBusyServices] = useState<Set<string>>(new Set());
  const [busyGroups, setBusyGroups] = useState<Set<string>>(new Set());
  const [apiStatus, setApiStatus] = useState<ConnectionState>("pending");
  const [socketStatus, setSocketStatus] = useState<ConnectionState>("pending");
  const [loading, setLoading] = useState(true);

  const commitServices = useCallback((next: Map<string, NormalizedService>) => {
    servicesRef.current = next;
    const sorted = [...next.values()].sort((a, b) => a.name.localeCompare(b.name));
    setServices(sorted);

    const selected = selectedNameRef.current;
    if (selected && !next.has(selected)) {
      selectedNameRef.current = sorted[0]?.name ?? null;
      setSelectedNameState(selectedNameRef.current);
      setSelectedLogs(selectedNameRef.current ? logsRef.current.get(selectedNameRef.current) ?? [] : []);
    } else if (!selected && sorted.length) {
      selectedNameRef.current = sorted[0].name;
      setSelectedNameState(sorted[0].name);
      setSelectedLogs(logsRef.current.get(sorted[0].name) ?? []);
    }
  }, []);

  const mergeService = useCallback((service: NormalizedService) => {
    const next = new Map(servicesRef.current);
    next.set(service.name, service);
    commitServices(next);
  }, [commitServices]);

  const setLogBuffer = useCallback((name: string, incoming: NormalizedLogEntry[], replace = false) => {
    const existing = logsRef.current.get(name) ?? [];
    const next = replace ? incoming.slice(-MAX_LOG_ENTRIES) : mergeLogEntries(existing, incoming);
    logsRef.current.set(name, next);
    logVersionsRef.current.set(name, (logVersionsRef.current.get(name) ?? 0) + 1);
    if (selectedNameRef.current === name) {
      setSelectedLogs(next);
      setLogRevision((value) => value + 1);
    }
  }, []);

  const loadLogs = useCallback(async (name: string, { force = false }: { force?: boolean } = {}) => {
    if (!force && loadedLogsRef.current.has(name)) return;
    const versionAtRequest = logVersionsRef.current.get(name) ?? 0;
    try {
      const fetched = await api.getLogs(name, 500);
      const changedWhileLoading = (logVersionsRef.current.get(name) ?? 0) !== versionAtRequest;
      const next = changedWhileLoading ? mergeLogEntries(fetched, logsRef.current.get(name) ?? []) : fetched;
      logsRef.current.set(name, next.slice(-MAX_LOG_ENTRIES));
      logVersionsRef.current.set(name, (logVersionsRef.current.get(name) ?? 0) + 1);
      loadedLogsRef.current.add(name);
      if (selectedNameRef.current === name) {
        setSelectedLogs(logsRef.current.get(name) ?? []);
        setLogRevision((value) => value + 1);
      }
    } catch (error) {
      if (!force) onError("读取日志失败", error instanceof Error ? error.message : String(error));
    }
  }, [api, onError]);

  const selectService = useCallback((name: string) => {
    if (!servicesRef.current.has(name)) return;
    selectedNameRef.current = name;
    setSelectedNameState(name);
    setSelectedLogs(logsRef.current.get(name) ?? []);
    void loadLogs(name);
  }, [loadLogs]);

  const loadServices = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      const [nextServices, nextGroups] = await Promise.all([
        api.listServices(),
        api.listServiceGroups(),
      ]);
      commitServices(new Map(nextServices.map((service) => [service.name, service])));
      setGroups(nextGroups.sort((left, right) => left.localeCompare(right)));
      setApiStatus("ok");
    } catch (error) {
      setApiStatus("error");
      if (!silent) onError("读取服务失败", error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [api, commitServices, onError]);

  const checkHealth = useCallback(async () => {
    try {
      const healthy = await api.checkHealth();
      setApiStatus(healthy ? "ok" : "error");
    } catch {
      setApiStatus("error");
    }
  }, [api]);

  useEffect(() => {
    if (!enabled) return;
    const initialLoad = window.setTimeout(() => void Promise.all([loadServices(), checkHealth()]), 0);
    const serviceTimer = window.setInterval(() => void loadServices({ silent: true }), SERVICE_POLL_INTERVAL);
    const healthTimer = window.setInterval(() => void checkHealth(), HEALTH_POLL_INTERVAL);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(serviceTimer);
      window.clearInterval(healthTimer);
    };
  }, [checkHealth, enabled, loadServices]);

  useEffect(() => {
    const selected = selectedName;
    if (!selected) return;
    const timer = window.setTimeout(() => void loadLogs(selected), 0);
    return () => window.clearTimeout(timer);
  }, [loadLogs, selectedName]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;
      setSocketStatus("pending");
      socket = new WebSocket(websocketUrl(token));

      socket.addEventListener("open", () => {
        if (disposed) return;
        reconnectAttemptRef.current = 0;
        setSocketStatus("ok");
        void loadServices({ silent: true });
        const selected = selectedNameRef.current;
        if (selected) void loadLogs(selected, { force: true });
      });

      socket.addEventListener("message", (event) => {
        let payload: WsEvent;
        try {
          payload = JSON.parse(String(event.data)) as WsEvent;
        } catch {
          return;
        }

        if (payload.type === "status" && typeof payload.service === "string" && isRecord(payload.data)) {
          const previous = servicesRef.current.get(payload.service);
          const raw = { ...(previous?.raw ?? {}), ...payload.data, name: payload.service };
          mergeService(normalizeService(raw, payload.service));
          return;
        }

        if (payload.type === "log" && typeof payload.service === "string") {
          setLogBuffer(payload.service, [normalizeLogEntry(payload.data)]);
        }
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        setSocketStatus("error");
        const attempt = reconnectAttemptRef.current++;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)) + Math.random() * 400;
        reconnectTimer = window.setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        if (!disposed) setSocketStatus("error");
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled, loadLogs, loadServices, mergeService, setLogBuffer, token]);

  const withBusyService = useCallback(async <T,>(name: string, operation: () => Promise<T>) => {
    setBusyServices((current) => new Set(current).add(name));
    try {
      return await operation();
    } finally {
      setBusyServices((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
    }
  }, []);

  const runAction = useCallback(async (name: string, action: ServiceLifecycleAction) => {
    const service = await withBusyService(name, () => api.runServiceAction(name, action));
    mergeService(service);
    return service;
  }, [api, mergeService, withBusyService]);

  const createGroup = useCallback(async (name: string) => {
    const group = await api.createServiceGroup(name);
    setGroups((current) => (
      current.includes(group)
        ? current
        : [...current, group].sort((left, right) => left.localeCompare(right))
    ));
    return group;
  }, [api]);

  const deleteGroup = useCallback(async (name: string) => {
    const changed = await api.deleteServiceGroup(name);
    setGroups((current) => current.filter((group) => group !== name));
    changed.forEach(mergeService);
    return changed;
  }, [api, mergeService]);

  const assignGroup = useCallback(async (name: string, group: string | null) => {
    const service = await withBusyService(name, () => api.assignServiceGroup(name, group));
    mergeService(service);
    return service;
  }, [api, mergeService, withBusyService]);

  const runGroupAction = useCallback(async (group: string, action: ServiceGroupAction) => {
    const names = [...servicesRef.current.values()]
      .filter((service) => service.group === group)
      .map((service) => service.name);
    setBusyGroups((current) => new Set(current).add(group));
    setBusyServices((current) => new Set([...current, ...names]));
    try {
      const result = await api.runServiceGroupAction(group, action);
      result.services.forEach(mergeService);
      return result;
    } finally {
      setBusyGroups((current) => {
        const next = new Set(current);
        next.delete(group);
        return next;
      });
      setBusyServices((current) => {
        const next = new Set(current);
        names.forEach((name) => next.delete(name));
        return next;
      });
    }
  }, [api, mergeService]);

  const createService = useCallback(async (input: ServiceCreateInput) => {
    const service = await withBusyService(input.name, () => api.createService(input));
    mergeService(service);
    selectService(service.name);
    return service;
  }, [api, mergeService, selectService, withBusyService]);

  const updateService = useCallback(async (name: string, input: ServiceUpdateInput) => {
    const service = await withBusyService(name, () => api.updateService(name, input));
    mergeService(service);
    return service;
  }, [api, mergeService, withBusyService]);

  const deleteService = useCallback(async (name: string) => {
    await withBusyService(name, () => api.deleteService(name));
    const next = new Map(servicesRef.current);
    next.delete(name);
    logsRef.current.delete(name);
    logVersionsRef.current.delete(name);
    loadedLogsRef.current.delete(name);
    if (selectedNameRef.current === name) {
      selectedNameRef.current = null;
      setSelectedNameState(null);
      setSelectedLogs([]);
    }
    commitServices(next);
    setLogRevision((value) => value + 1);
  }, [api, commitServices, withBusyService]);

  const clearVisibleLogs = useCallback(() => {
    const selected = selectedNameRef.current;
    if (!selected) return;
    logsRef.current.set(selected, []);
    logVersionsRef.current.set(selected, (logVersionsRef.current.get(selected) ?? 0) + 1);
    setSelectedLogs([]);
    setLogRevision((value) => value + 1);
  }, []);

  const selectedService = selectedName
    ? services.find((service) => service.name === selectedName) ?? null
    : null;

  return {
    api,
    services,
    groups,
    selectedName,
    selectedService,
    selectedLogs,
    logRevision,
    busyServices,
    busyGroups,
    apiStatus,
    socketStatus,
    loading,
    selectService,
    loadServices,
    checkHealth,
    loadLogs,
    runAction,
    createGroup,
    deleteGroup,
    assignGroup,
    runGroupAction,
    createService,
    updateService,
    deleteService,
    clearVisibleLogs,
  };
}
