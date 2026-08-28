"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, type ServiceConsoleApiClient } from "@/lib/api-client";
import type { NormalizedPortRow } from "@/lib/types";

const PORT_POLL_INTERVAL = 5_000;

interface UsePortsOptions {
  api: ServiceConsoleApiClient;
  active: boolean;
  onError: (title: string, message: string) => void;
}

export function usePorts({ api, active, onError }: UsePortsOptions) {
  const [ports, setPorts] = useState<NormalizedPortRow[]>([]);
  const [filter, setFilter] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busyPids, setBusyPids] = useState<Set<number>>(new Set());
  const requestIdRef = useRef(0);

  const loadPorts = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const nextPorts = await api.listPorts(filter);
      if (requestId !== requestIdRef.current) return;
      setPorts(nextPorts);
      setLoaded(true);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      if (!silent) onError("读取端口失败", error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [api, filter, onError]);

  useEffect(() => {
    if (!active) return;
    const initialLoad = window.setTimeout(() => void loadPorts(), 0);
    const timer = window.setInterval(() => void loadPorts({ silent: true }), PORT_POLL_INTERVAL);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [active, loadPorts]);

  const terminate = useCallback(async (item: NormalizedPortRow, force: boolean) => {
    if (item.pid === null) return { needsForce: false, terminated: false };
    setBusyPids((current) => new Set(current).add(item.pid as number));
    try {
      const result = await api.terminateProcess(item.pid, {
        expected_port: item.port,
        force,
        timeout: 3,
      });
      return { needsForce: !force && result.terminated === false, terminated: result.terminated, result };
    } catch (error) {
      if (!force && error instanceof ApiError && [408, 409, 504].includes(error.status)) {
        return { needsForce: true, terminated: false };
      }
      throw error;
    } finally {
      setBusyPids((current) => {
        const next = new Set(current);
        if (item.pid !== null) next.delete(item.pid);
        return next;
      });
      void loadPorts({ silent: true });
    }
  }, [api, loadPorts]);

  return {
    ports,
    filter,
    loading,
    loaded,
    busyPids,
    setFilter,
    loadPorts,
    terminate,
  };
}
