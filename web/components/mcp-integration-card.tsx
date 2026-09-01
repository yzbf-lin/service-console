"use client";

import {
  Bot,
  CheckCircle2,
  Copy,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { McpIntegrationOperation } from "@/hooks/use-mcp-integration";
import type { McpIntegrationState, McpIntegrationStatus } from "@/lib/types";
import { cn } from "@/lib/cn";

interface McpIntegrationCardProps {
  status: McpIntegrationStatus | null;
  operation: McpIntegrationOperation | null;
  onInstall: () => void;
  onRefresh: () => void;
  onTest: () => void;
  onCopyConfig: (config: string) => void;
  onRemove: () => void;
}

const stateLabels: Record<McpIntegrationState, string> = {
  unavailable: "当前不可用",
  not_installed: "未安装",
  installed: "已安装",
  conflict: "配置冲突",
  error: "检查失败",
};

function statusBadge(status: McpIntegrationStatus | null) {
  if (!status) return { label: "检查中", variant: "secondary" as const };
  if (status.state === "installed" && status.last_test?.ok) {
    return { label: "连接正常", variant: "success" as const };
  }
  if (status.state === "conflict") {
    return { label: stateLabels[status.state], variant: "warning" as const };
  }
  if (status.state === "error") {
    return { label: stateLabels[status.state], variant: "destructive" as const };
  }
  return {
    label: stateLabels[status.state],
    variant: status.state === "installed" ? "success" as const : "secondary" as const,
  };
}

function operationLabel(operation: McpIntegrationOperation | null): string | null {
  if (operation === "installing") return "安装中";
  if (operation === "testing") return "测试中";
  if (operation === "removing") return "移除中";
  return null;
}

function CapabilityState({ available, children }: { available: boolean; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className={cn("size-1.5 rounded-full", available ? "bg-success" : "bg-muted-foreground/45")}
        aria-hidden="true"
      />
      {children}：{available ? "就绪" : "不可用"}
    </span>
  );
}

export function McpIntegrationCard({
  status,
  operation,
  onInstall,
  onRefresh,
  onTest,
  onCopyConfig,
  onRemove,
}: McpIntegrationCardProps) {
  const badge = statusBadge(status);
  const busyLabel = operationLabel(operation);
  const busy = operation !== null;
  const registered = Boolean(status?.codex_registered);
  const conflict = status?.state === "conflict";
  const canInstall = Boolean(
    status
      && ["not_installed", "conflict"].includes(status.state)
      && status.bridge_available
      && status.codex_cli_available
      && !busy,
  );
  const canTest = Boolean(
    status?.state === "installed"
      && status.controller_ready
      && status.bridge_available
      && !busy,
  );
  const canCopy = Boolean(status?.config_snippet && !busy);
  const canRemove = Boolean((registered || conflict) && !busy);
  const showRefresh = status?.state === "error" || status?.state === "unavailable";
  const error = status?.error || (status?.last_test && !status.last_test.ok ? status.last_test.error : null);
  const commandPreview = status?.bridge_command
    ? [status.bridge_command, ...status.bridge_args].join(" ")
    : null;

  return (
    <section aria-labelledby="mcpIntegrationHeading">
      <div className="mb-2">
        <h3 id="mcpIntegrationHeading" className="text-[12px] font-semibold">AI / MCP 集成</h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          首次安装后重启 Codex 一次；此后应用会自动发布本机控制器，无需固定端口。
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card" aria-busy={busy}>
        <div className="flex items-start gap-3 px-3 py-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
            <Bot className="size-4" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong className="text-[12px] font-medium">Service Console for Codex</strong>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{status?.server_name || "service-console"} · stdio</p>
              </div>
              <Badge
                className="rounded-md px-1.5 py-0.5 text-[9px]"
                variant={badge.variant}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {busyLabel || badge.label}
              </Badge>
            </div>

            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 rounded-md bg-secondary/55 px-2.5 py-2 text-[10px] text-muted-foreground">
              <CapabilityState available={Boolean(status?.controller_ready)}>应用控制器</CapabilityState>
              <CapabilityState available={Boolean(status?.bridge_available)}>MCP Bridge</CapabilityState>
              <CapabilityState available={Boolean(status?.codex_cli_available)}>Codex CLI</CapabilityState>
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span className={cn("size-1.5 rounded-full", registered ? "bg-success" : "bg-muted-foreground/45")} aria-hidden="true" />
                Codex 配置：{registered ? "已注册" : "未注册"}
              </span>
            </div>

            {commandPreview ? (
              <div className="mt-3 min-w-0 rounded-md border bg-background/70 px-2.5 py-2">
                <span className="block text-[9px] font-medium text-muted-foreground">MCP Bridge 命令</span>
                <code className="mt-1 block truncate text-[10px]" title={commandPreview}>{commandPreview}</code>
              </div>
            ) : null}

            {status?.tools.length ? (
              <div className="mt-3 flex min-w-0 items-start gap-2 text-[10px]">
                <Wrench className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <span className="font-medium">可用工具 {status.tools.length} 个</span>
                  <p className="mt-1 line-clamp-2 break-all font-mono text-[9px] leading-relaxed text-muted-foreground">
                    {status.tools.join(" · ")}
                  </p>
                </div>
              </div>
            ) : null}

            {status?.last_test?.ok ? (
              <p className="mt-3 inline-flex items-center gap-1.5 text-[10px] text-success">
                <CheckCircle2 className="size-3.5" aria-hidden="true" />
                最近一次 MCP 核心工具调用验证成功
              </p>
            ) : null}

            {error ? (
              <p className="mt-3 rounded-md bg-destructive/10 px-2.5 py-2 text-[10px] leading-relaxed text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            {!status?.codex_cli_available && status ? (
              <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
                安装 Codex CLI 并确保命令位于 PATH 后，即可启用一键配置。
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!registered || conflict ? (
                <Button size="sm" disabled={!canInstall} onClick={onInstall}>
                  {operation === "installing" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <PlugZap className="size-3.5" aria-hidden="true" />}
                  {conflict ? "修复 Codex 配置" : operation === "installing" ? "安装中" : "安装到 Codex"}
                </Button>
              ) : (
                <Button size="sm" disabled={!canTest} onClick={onTest}>
                  {operation === "testing" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <PlugZap className="size-3.5" aria-hidden="true" />}
                  {operation === "testing" ? "测试中" : "测试连接"}
                </Button>
              )}

              <Button
                size="sm"
                variant="secondary"
                disabled={!canCopy}
                onClick={() => status?.config_snippet && onCopyConfig(status.config_snippet)}
              >
                <Copy className="size-3.5" aria-hidden="true" />
                复制配置
              </Button>

              {showRefresh ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={onRefresh}>
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  重新检测
                </Button>
              ) : null}

              {registered || conflict ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" disabled={!canRemove}>
                      {operation === "removing" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="size-3.5" aria-hidden="true" />}
                      {operation === "removing" ? "移除中" : "移除集成"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>从 Codex 中移除 Service Console？</AlertDialogTitle>
                      <AlertDialogDescription>
                        这只会删除 Codex 的 MCP 注册，不会删除 Service Console 中的服务定义、日志或项目配置。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={onRemove}
                      >
                        确认移除
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
