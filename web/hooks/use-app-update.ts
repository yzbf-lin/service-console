"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { AppUpdateState, AppUpdateStatus } from "@/lib/types";

const AUTO_CHECK_DELAY = 2_500;
const PROGRESS_POLL_INTERVAL = 300;

export type AppUpdateOperation = "checking" | "downloading" | "installing";

interface UseAppUpdateOptions {
  api: ServiceConsoleApiClient;
  onError: (title: string, message: string) => void;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useAppUpdate({ api, onError }: UseAppUpdateOptions) {
  const mountedRef = useRef(false);
  const operationRef = useRef<AppUpdateOperation | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const statusEpochRef = useRef(0);
  const statusRequestIdRef = useRef(0);
  const latestStatusRequestRef = useRef({ epoch: 0, requestId: 0 });
  const onErrorRef = useRef(onError);
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [operation, setOperation] = useState<AppUpdateOperation | null>(null);

  const commitStatus = useCallback((
    nextStatus: AppUpdateStatus,
    epoch: number,
    requestId: number | null = null,
  ) => {
    if (!mountedRef.current || epoch !== statusEpochRef.current) return;
    if (requestId !== null) {
      const latestRequest = latestStatusRequestRef.current;
      if (latestRequest.epoch !== epoch || latestRequest.requestId !== requestId) return;
    }
    setStatus(nextStatus);
  }, []);

  const stopProgressPolling = useCallback(() => {
    if (pollTimerRef.current === null) return;
    window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const refreshStatus = useCallback(async ({
    silent = false,
    expectedEpoch = statusEpochRef.current,
  }: { silent?: boolean; expectedEpoch?: number } = {}) => {
    if (expectedEpoch !== statusEpochRef.current) return null;
    const requestId = ++statusRequestIdRef.current;
    latestStatusRequestRef.current = { epoch: expectedEpoch, requestId };
    try {
      const nextStatus = await api.getAppUpdateStatus();
      commitStatus(nextStatus, expectedEpoch, requestId);
      return nextStatus;
    } catch (error) {
      if (!silent && mountedRef.current && expectedEpoch === statusEpochRef.current) {
        onErrorRef.current("读取更新状态失败", messageFromError(error));
      }
      return null;
    }
  }, [api, commitStatus]);

  const startProgressPolling = useCallback((operationEpoch: number) => {
    stopProgressPolling();
    const poll = async () => {
      if (operationEpoch !== statusEpochRef.current || operationRef.current === null) return;
      await refreshStatus({ silent: true, expectedEpoch: operationEpoch });
      if (operationEpoch !== statusEpochRef.current || operationRef.current === null) return;
      pollTimerRef.current = window.setTimeout(() => void poll(), PROGRESS_POLL_INTERVAL);
    };
    pollTimerRef.current = window.setTimeout(() => void poll(), PROGRESS_POLL_INTERVAL);
  }, [refreshStatus, stopProgressPolling]);

  const runOperation = useCallback(async (
    nextOperation: AppUpdateOperation,
    nextState: AppUpdateState,
    operationTitle: string,
    action: () => Promise<AppUpdateStatus>,
    { silent = false, poll = false }: { silent?: boolean; poll?: boolean } = {},
  ) => {
    if (operationRef.current !== null) return null;
    operationRef.current = nextOperation;
    const operationEpoch = ++statusEpochRef.current;
    if (mountedRef.current) {
      setOperation(nextOperation);
      setStatus((current) => current ? { ...current, state: nextState, error: null } : current);
    }
    if (poll) startProgressPolling(operationEpoch);

    try {
      const nextStatus = await action();
      stopProgressPolling();
      if (operationEpoch === statusEpochRef.current) {
        const finalEpoch = ++statusEpochRef.current;
        commitStatus(nextStatus, finalEpoch);
      }
      return nextStatus;
    } catch (error) {
      stopProgressPolling();
      const operationIsCurrent = operationEpoch === statusEpochRef.current;
      if (operationIsCurrent) statusEpochRef.current += 1;
      if (operationIsCurrent && !silent && mountedRef.current) {
        onErrorRef.current(operationTitle, messageFromError(error));
      }
      if (operationIsCurrent) {
        await refreshStatus({ silent: true, expectedEpoch: statusEpochRef.current });
      }
      return null;
    } finally {
      stopProgressPolling();
      operationRef.current = null;
      if (mountedRef.current) setOperation(null);
    }
  }, [commitStatus, refreshStatus, startProgressPolling, stopProgressPolling]);

  const checkForUpdates = useCallback((silent = false) => runOperation(
    "checking",
    "checking",
    "检查更新失败",
    () => api.checkAppUpdate(),
    { silent },
  ), [api, runOperation]);

  const downloadUpdate = useCallback(() => runOperation(
    "downloading",
    "downloading",
    "下载更新失败",
    () => api.downloadAppUpdate(),
    { poll: true },
  ), [api, runOperation]);

  const installUpdate = useCallback(() => runOperation(
    "installing",
    "installing",
    "安装更新失败",
    () => api.installAppUpdate(),
    { poll: true },
  ), [api, runOperation]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatus({ silent: true });
    const autoCheckTimer = window.setTimeout(() => {
      void checkForUpdates(true);
    }, AUTO_CHECK_DELAY);

    return () => {
      mountedRef.current = false;
      statusEpochRef.current += 1;
      window.clearTimeout(autoCheckTimer);
      stopProgressPolling();
    };
  }, [checkForUpdates, refreshStatus, stopProgressPolling]);

  return {
    status,
    operation,
    busy: operation !== null,
    refreshStatus,
    checkForUpdates: () => checkForUpdates(false),
    downloadUpdate,
    installUpdate,
  };
}
