"use client";

import { Moon, Plus, RefreshCw, Sun, TerminalSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { ConnectionState, ViewId } from "@/lib/types";

interface TopbarProps {
  activeView: ViewId;
  apiStatus: ConnectionState;
  socketStatus: ConnectionState;
  resolvedTheme: "light" | "dark";
  refreshing: boolean;
  onRefresh: () => void;
  onAddService: () => void;
  onToggleTheme: () => void;
}

const connectionCopy: Record<ConnectionState, { api: string; socket: string }> = {
  pending: { api: "API 检查中", socket: "实时连接中" },
  ok: { api: "API 正常", socket: "实时已连接" },
  error: { api: "API 不可用", socket: "实时已断开" },
};

function StatusChip({ kind, state }: { kind: "api" | "socket"; state: ConnectionState }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded-full border bg-secondary px-2 text-[11px] font-semibold text-secondary-foreground",
        state === "ok" && "border-success/50 bg-success/10 text-success",
        state === "error" && "border-destructive/50 bg-destructive/10 text-destructive",
      )}
      data-state={state}
    >
      <span
        className={cn(
          "size-2 rounded-full bg-warning",
          state === "ok" && "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_16%,transparent)]",
          state === "error" && "bg-destructive",
        )}
        aria-hidden="true"
      />
      {connectionCopy[state][kind]}
    </span>
  );
}

export function Topbar({
  activeView,
  apiStatus,
  socketStatus,
  resolvedTheme,
  refreshing,
  onRefresh,
  onAddService,
  onToggleTheme,
}: TopbarProps) {
  return (
    <header className="z-40 grid h-14 min-h-14 grid-cols-[minmax(180px,1fr)_auto_minmax(180px,1fr)] items-center gap-3 border-b bg-card/90 px-3 backdrop-blur-xl max-[767px]:grid-cols-[1fr_auto] max-[767px]:px-2.5">
      <div className="flex min-w-0 items-center gap-2" aria-label="Service Console">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-md shadow-primary/20">
          <TerminalSquare className="size-5" strokeWidth={1.8} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-bold tracking-tight">Service Console</h1>
          <p className="truncate text-[10px] text-muted-foreground max-[767px]:hidden">本地进程控制台</p>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 max-[767px]:hidden" aria-label="连接状态" aria-live="polite">
        <StatusChip kind="api" state={apiStatus} />
        <StatusChip kind="socket" state={socketStatus} />
      </div>

      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          type="button"
          aria-label={resolvedTheme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          title={resolvedTheme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          onClick={onToggleTheme}
        >
          {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>

        {activeView !== "settings" ? (
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={refreshing}
            aria-label={activeView === "ports" ? "刷新端口列表" : "刷新服务列表"}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            <span className="max-[520px]:sr-only">刷新</span>
          </Button>
        ) : null}

        {activeView === "services" ? (
          <Button size="sm" type="button" onClick={onAddService}>
            <Plus className="size-4" />
            <span className="max-[520px]:sr-only">添加服务</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
