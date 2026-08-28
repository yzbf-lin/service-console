"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { McpIntegrationStatus } from "@/lib/types";

export type McpIntegrationOperation = "installing" | "testing" | "removing";

interface UseMcpIntegrationOptions {
  api: ServiceConsoleApiClient;
  onError: (title: string, message: string) => void;
  onSuccess: (title: string, message: string) => void;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useMcpIntegration({ api, onError, onSuccess }: UseMcpIntegrationOptions) {
  const mountedRef = useRef(false);
  const operationRef = useRef<McpIntegrationOperation | null>(null);
  const epochRef = useRef(0);
  const requestIdRef = useRef(0);
  const latestRequestRef = useRef({ epoch: 0, requestId: 0 });
  const onErrorRef = useRef(onError);
  const onSuccessRef = useRef(onSuccess);
  const [status, setStatus] = useState<McpIntegrationStatus | null>(null);
  const [operation, setOperation] = useState<McpIntegrationOperation | null>(null);

  const commitStatus = useCallback((
    nextStatus: McpIntegrationStatus,
    epoch: number,
    requestId: number | null = null,
  ) => {
    if (!mountedRef.current || epoch !== epochRef.current) return;
    if (requestId !== null) {
      const latestRequest = latestRequestRef.current;
      if (latestRequest.epoch !== epoch || latestRequest.requestId !== requestId) return;
    }
    setStatus(nextStatus);
  }, []);

  const refreshStatus = useCallback(async ({
    silent = false,
    expectedEpoch = epochRef.current,
  }: { silent?: boolean; expectedEpoch?: number } = {}) => {
    if (expectedEpoch !== epochRef.current) return null;
    const requestId = ++requestIdRef.current;
    latestRequestRef.current = { epoch: expectedEpoch, requestId };
    try {
      const nextStatus = await api.getMcpIntegrationStatus();
      commitStatus(nextStatus, expectedEpoch, requestId);
      return nextStatus;
    } catch (error) {
      if (!silent && mountedRef.current && expectedEpoch === epochRef.current) {
        onErrorRef.current("读取 MCP 集成状态失败", messageFromError(error));
      }
      return null;
    }
  }, [api, commitStatus]);

  const runOperation = useCallback(async (
    nextOperation: McpIntegrationOperation,
    failureTitle: string,
    action: () => Promise<McpIntegrationStatus>,
    reportResult: (nextStatus: McpIntegrationStatus) => void,
  ) => {
    if (operationRef.current !== null) return null;
    operationRef.current = nextOperation;
    const operationEpoch = ++epochRef.current;
    if (mountedRef.current) setOperation(nextOperation);

    try {
      const nextStatus = await action();
      commitStatus(nextStatus, operationEpoch);
      if (mountedRef.current && operationEpoch === epochRef.current) reportResult(nextStatus);
      return nextStatus;
    } catch (error) {
      const operationIsCurrent = operationEpoch === epochRef.current;
      if (operationIsCurrent) epochRef.current += 1;
      if (operationIsCurrent && mountedRef.current) {
        onErrorRef.current(failureTitle, messageFromError(error));
        await refreshStatus({ silent: true, expectedEpoch: epochRef.current });
      }
      return null;
    } finally {
      operationRef.current = null;
      if (mountedRef.current) setOperation(null);
    }
  }, [commitStatus, refreshStatus]);

  const install = useCallback(() => runOperation(
    "installing",
    "安装 Codex MCP 集成失败",
    () => api.installMcpIntegration(),
    (nextStatus) => {
      if (
        nextStatus.state === "installed"
        && nextStatus.codex_registered
        && !nextStatus.error
      ) {
        onSuccessRef.current(
          "已安装到 Codex",
          "请重启 Codex 一次以载入新工具；此后 AI 调用时会自动连接 Service Console。",
        );
      } else {
        onErrorRef.current("Codex MCP 集成尚未生效", nextStatus.error || "Codex 未返回有效的注册状态。");
      }
    },
  ), [api, runOperation]);

  const testConnection = useCallback(() => runOperation(
    "testing",
    "测试 MCP 连接失败",
    () => api.testMcpIntegration(),
    (nextStatus) => {
      if (
        nextStatus.state === "installed"
        && nextStatus.codex_registered
        && nextStatus.last_test?.ok
        && !nextStatus.error
      ) {
        const toolCount = nextStatus.tools.length;
        onSuccessRef.current("MCP 连接正常", `已完成握手，发现 ${toolCount} 个可用工具。`);
      } else {
        onErrorRef.current(
          "MCP 连接测试未通过",
          nextStatus.last_test?.error || nextStatus.error || "MCP Bridge 未返回成功结果。",
        );
      }
    },
  ), [api, runOperation]);

  const remove = useCallback(() => runOperation(
    "removing",
    "移除 Codex MCP 集成失败",
    () => api.removeMcpIntegration(),
    (nextStatus) => {
      const normallyRemoved = (
        nextStatus.state === "not_installed"
        && !nextStatus.codex_registered
        && !nextStatus.error
      );
      const staleRegistrationRemovedWithoutBridge = (
        nextStatus.state === "unavailable"
        && nextStatus.controller_ready
        && !nextStatus.bridge_available
        && nextStatus.codex_cli_available
        && !nextStatus.codex_registered
        && !nextStatus.error
      );
      if (normallyRemoved || staleRegistrationRemovedWithoutBridge) {
        onSuccessRef.current("已移除 Codex 集成", "Service Console 本机服务配置不会受到影响。");
      } else {
        onErrorRef.current("Codex MCP 集成仍然存在", nextStatus.error || "请刷新状态后重试。");
      }
    },
  ), [api, runOperation]);

  useEffect(() => {
    onErrorRef.current = onError;
    onSuccessRef.current = onSuccess;
  }, [onError, onSuccess]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatus({ silent: true });
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, [refreshStatus]);

  return {
    status,
    operation,
    busy: operation !== null,
    refreshStatus,
    install,
    testConnection,
    remove,
  };
}
