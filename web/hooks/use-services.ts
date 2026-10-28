"use client";

import { useEffect, useMemo, useRef } from "react";

import { createApiClient } from "@/lib/api-client";
import type {
  NormalizedService,
  ServiceCreateInput,
  ServiceGroupAction,
  ServiceLifecycleAction,
  ServiceUpdateInput,
  WsEvent,
} from "@/lib/types";
import { useServiceStore } from "@/stores/service-store";

const SERVICE_POLL_INTERVAL = 5_000;
const HEALTH_POLL_INTERVAL = 15_000;

interface ServiceActions {
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

/**
 * Browser-side wiring for the service store: polling, websocket reconnect and
 * the log prefetch that follows selection. All data lives in
 * `useServiceStore`, so components can subscribe to individual slices instead
 * of re-rendering on every console update.
 */
export function useServices({ token, enabled, onError }: UseServicesOptions) {
  const api = useMemo(() => createApiClient({ token }), [token]);
  const reconnectAttemptRef = useRef(0);

  const services = useServiceStore((state) => state.services);
  const groups = useServiceStore((state) => state.groups);
  const selectedName = useServiceStore((state) => state.selectedName);
  const selectedLogs = useServiceStore((state) => state.selectedLogs);
  const logRevision = useServiceStore((state) => state.logRevision);
  const busyServices = useServiceStore((state) => state.busyServices);
  const busyGroups = useServiceStore((state) => state.busyGroups);
  const apiStatus = useServiceStore((state) => state.apiStatus);
  const socketStatus = useServiceStore((state) => state.socketStatus);
  const loading = useServiceStore((state) => state.loading);

  useEffect(() => {
    useServiceStore.getState().configure(api, onError);
  }, [api, onError]);

  useEffect(() => {
    if (!enabled) return;
    const store = () => useServiceStore.getState();
    const initialLoad = window.setTimeout(
      () => void Promise.all([store().loadServices(), store().checkHealth()]),
      0,
    );
    const serviceTimer = window.setInterval(
      () => void store().loadServices({ silent: true }),
      SERVICE_POLL_INTERVAL,
    );
    const healthTimer = window.setInterval(() => void store().checkHealth(), HEALTH_POLL_INTERVAL);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(serviceTimer);
      window.clearInterval(healthTimer);
    };
  }, [enabled]);

  useEffect(() => {
    if (!selectedName) return;
    const timer = window.setTimeout(
      () => void useServiceStore.getState().loadLogs(selectedName),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [selectedName]);

  useEffect(() => {
    if (!enabled) return;
    const store = () => useServiceStore.getState();
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;
      store().setSocketStatus("pending");
      socket = new WebSocket(websocketUrl(token));

      socket.addEventListener("open", () => {
        if (disposed) return;
        reconnectAttemptRef.current = 0;
        const current = store();
        current.setSocketStatus("ok");
        void current.loadServices({ silent: true });
        if (current.selectedName) void current.loadLogs(current.selectedName, { force: true });
      });

      socket.addEventListener("message", (event) => {
        let payload: WsEvent;
        try {
          payload = JSON.parse(String(event.data)) as WsEvent;
        } catch {
          return;
        }
        store().handleSocketMessage(payload);
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        store().setSocketStatus("error");
        const attempt = reconnectAttemptRef.current++;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)) + Math.random() * 400;
        reconnectTimer = window.setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        if (!disposed) store().setSocketStatus("error");
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled, token]);

  /**
   * Store actions are stable across renders, so this bundle is created once and
   * keeps the hook's return value referentially cheap for consumers.
   */
  const actions = useMemo<ServiceActions>(() => {
    const store = () => useServiceStore.getState();
    return {
      selectService: (name) => store().selectService(name),
      loadServices: (options) => store().loadServices(options),
      checkHealth: () => store().checkHealth(),
      loadLogs: (name, options) => store().loadLogs(name, options),
      runAction: (name, action) => store().runAction(name, action),
      createGroup: (name) => store().createGroup(name),
      deleteGroup: (name) => store().deleteGroup(name),
      assignGroup: (name, group, position) => store().assignGroup(name, group, position),
      runGroupAction: (group, action) => store().runGroupAction(group, action),
      createService: (input) => store().createService(input),
      updateService: (name, input) => store().updateService(name, input),
      deleteService: (name) => store().deleteService(name),
      clearVisibleLogs: () => store().clearVisibleLogs(),
    };
  }, []);

  const selectedService = useMemo(
    () => (selectedName ? services.find((service) => service.name === selectedName) ?? null : null),
    [selectedName, services],
  );

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
    ...actions,
  };
}
