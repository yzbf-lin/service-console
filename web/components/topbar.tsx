"use client";

import Image from "next/image";
import { Moon, Plus, RefreshCw, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { ConnectionState, ViewId } from "@/lib/types";
import productLogo from "@/public/service-console-logo.png";

interface TopbarProps {
  activeView: ViewId;
  apiStatus: ConnectionState;
  socketStatus: ConnectionState;
  resolvedTheme: "light" | "dark";
  refreshing: boolean;
  runningCount: number;
  serviceCount: number;
  selectedServiceName: string | null;
  onRefresh: () => void;
  onAddService: () => void;
  onToggleTheme: () => void;
}

const connectionCopy: Record<ConnectionState, { api: string; socket: string }> = {
  pending: { api: "API 检查中", socket: "实时连接中" },
  ok: { api: "API 正常", socket: "实时已连接" },
  error: { api: "API 不可用", socket: "实时已断开" },
};

const viewCopy: Record<ViewId, { title: string; description: string }> = {
  services: { title: "服务控制", description: "进程与实时日志" },
  ports: { title: "端口进程", description: "监听端口与占用进程" },
  jenkins: { title: "Jenkins", description: "多实例任务与构建管理" },
  settings: { title: "设置", description: "外观、更新与连接偏好" },
};

function ConnectionItem({ kind, state }: { kind: "api" | "socket"; state: ConnectionState }) {
  const label = kind === "api" ? "API" : "实时";
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"
      data-state={state}
      title={connectionCopy[state][kind]}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-warning",
          state === "ok" && "bg-success",
          state === "error" && "bg-destructive",
        )}
        aria-hidden="true"
      />
      {label}
      <span className="sr-only">：{connectionCopy[state][kind]}</span>
    </span>
  );
}

export function Topbar({
  activeView,
  apiStatus,
  socketStatus,
  resolvedTheme,
  refreshing,
  runningCount,
  serviceCount,
  selectedServiceName,
  onRefresh,
  onAddService,
  onToggleTheme,
}: TopbarProps) {
  const context = viewCopy[activeView];
  const detail = activeView === "services"
    ? selectedServiceName ?? `${runningCount}/${serviceCount} 运行中`
    : context.description;

  return (
    <header className="service-topbar z-40 grid h-12 min-h-12 items-center border-b bg-[var(--toolbar)]">
      <div className="flex h-full min-w-0 items-center gap-2 border-r px-3" aria-label="Service Console">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-black/10 bg-[#f7f8fa] shadow-sm">
          <Image className="size-5 object-contain" src={productLogo} alt="" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[13px] font-semibold tracking-tight">Service Console</h1>
          <p className="truncate text-[9px] text-muted-foreground max-[767px]:hidden">本地进程工作台</p>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 px-3 max-[767px]:hidden">
        <h2 className="shrink-0 text-[12px] font-semibold">{context.title}</h2>
        <span className="text-border" aria-hidden="true">/</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{detail}</span>
        <div className="flex shrink-0 items-center gap-3 border-l pl-3" aria-label="连接状态" aria-live="polite">
          <ConnectionItem kind="api" state={apiStatus} />
          <ConnectionItem kind="socket" state={socketStatus} />
        </div>
      </div>

      <div className="flex items-center justify-end gap-1 px-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-8 rounded-lg shadow-none"
          type="button"
          aria-label={resolvedTheme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          title={resolvedTheme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          onClick={onToggleTheme}
        >
          {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>

        {activeView !== "settings" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-8 rounded-lg shadow-none"
            type="button"
            disabled={refreshing}
            aria-label={activeView === "ports" ? "刷新端口列表" : activeView === "jenkins" ? "刷新 Jenkins" : "刷新服务列表"}
            title={activeView === "ports" ? "刷新端口列表" : activeView === "jenkins" ? "刷新 Jenkins" : "刷新服务列表"}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
        ) : null}

        {activeView === "services" ? (
          <Button className="h-8 rounded-lg px-2.5 text-[11px] shadow-none" size="sm" type="button" onClick={onAddService}>
            <Plus className="size-3.5" />
            <span className="max-[520px]:sr-only">添加服务</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
