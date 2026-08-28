"use client";

import { Copy, Pencil, Play, RotateCw, Square, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  currentUptime,
  formatBytes,
  formatDuration,
  formatPercent,
  getServiceActionDisabled,
  statusLabel,
} from "@/lib/service-logic";
import type { NormalizedService, ServiceAction } from "@/lib/types";
import { cn } from "@/lib/cn";

interface ServiceCardProps {
  service: NormalizedService;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onAction: (action: ServiceAction) => void;
}

const statusClasses: Record<NormalizedService["status"], string> = {
  RUNNING: "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_14%,transparent)]",
  STARTING: "bg-warning animate-pulse",
  STOPPING: "bg-warning animate-pulse",
  FAILED: "bg-destructive",
  EXITED: "bg-violet-500",
  STOPPED: "bg-muted-foreground",
  UNKNOWN: "bg-muted-foreground",
};

function statusTone(status: NormalizedService["status"]) {
  if (status === "RUNNING") return "success" as const;
  if (status === "FAILED") return "destructive" as const;
  if (status === "STARTING" || status === "STOPPING") return "warning" as const;
  return "secondary" as const;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <span className="text-[8px] font-bold tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="truncate font-mono text-[10px] font-semibold">{value}</span>
    </span>
  );
}

export function ServiceCard({ service, selected, busy, onSelect, onAction }: ServiceCardProps) {
  const disabled = getServiceActionDisabled(service.status, busy);
  const memory = service.memoryBytes !== null
    ? formatBytes(service.memoryBytes)
    : formatPercent(service.memoryPercent);

  const action = (name: ServiceAction) => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!disabled[name]) onAction(name);
  };

  const compactButton = "h-7 min-w-0 flex-1 gap-1 px-1.5 text-[9px] disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-60";
  const iconButton = "size-7 shrink-0 disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-60";

  return (
    <article
      className={cn(
        "group relative cursor-pointer rounded-lg border bg-card p-2 outline-none transition-colors",
        "hover:border-input hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring/40",
        selected && "border-primary bg-accent/55 shadow-[inset_3px_0_0_var(--primary),0_0_0_1px_color-mix(in_srgb,var(--primary)_8%,transparent)]",
      )}
      data-service={service.name}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      aria-label={`${service.name}，${statusLabel(service.status)}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (["Enter", " "].includes(event.key) && !target?.closest("button")) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("size-2.5 shrink-0 rounded-full", statusClasses[service.status])} aria-hidden="true" />
          <strong className="truncate text-xs font-bold" title={service.name}>{service.name}</strong>
        </div>
        <Badge variant={statusTone(service.status)} className="shrink-0 px-1.5 py-0.5 text-[8px] uppercase">
          {busy ? "处理中" : statusLabel(service.status)}
        </Badge>
      </div>

      <p className="mt-1.5 truncate font-mono text-[10px] text-secondary-foreground" title={service.command}>{service.command}</p>
      <p className="mt-0.5 truncate text-[9px] text-muted-foreground" title={service.cwd}>{service.cwd}</p>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t pt-1.5">
        <Metric label="PID" value={service.pid === null ? "—" : String(service.pid)} />
        <Metric label="运行" value={formatDuration(currentUptime(service))} />
        <Metric label="CPU" value={formatPercent(service.cpuPercent)} />
        <Metric label="内存" value={memory} />
      </div>

      <div className="mt-1.5 flex items-center gap-1 border-t pt-1.5">
        <div className="flex min-w-0 flex-1 gap-1">
          <Button
            className={cn(compactButton, !disabled.start && "border-success/55 text-success hover:bg-success/10 hover:text-success")}
            variant="outline"
            size="sm"
            disabled={disabled.start}
            aria-disabled={disabled.start}
            data-action="start"
            onClick={action("start")}
          >
            <Play className="size-3" />
            启动
          </Button>
          <Button
            className={cn(compactButton, !disabled.stop && "border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive")}
            variant="outline"
            size="sm"
            disabled={disabled.stop}
            aria-disabled={disabled.stop}
            data-action="stop"
            onClick={action("stop")}
          >
            <Square className="size-3" />
            停止
          </Button>
          <Button
            className={cn(compactButton, !disabled.restart && "border-primary/50 text-primary hover:bg-primary/10 hover:text-primary")}
            variant="outline"
            size="sm"
            disabled={disabled.restart}
            aria-disabled={disabled.restart}
            data-action="restart"
            onClick={action("restart")}
          >
            <RotateCw className="size-3" />
            重启
          </Button>
        </div>

        <Button className={iconButton} variant="outline" size="icon-sm" disabled={disabled.edit} aria-disabled={disabled.edit} data-action="edit" aria-label="编辑服务" title="编辑服务" onClick={action("edit")}><Pencil className="size-3" /></Button>
        <Button className={iconButton} variant="outline" size="icon-sm" disabled={disabled.copy} aria-disabled={disabled.copy} data-action="copy" aria-label="复制服务" title="复制服务" onClick={action("copy")}><Copy className="size-3" /></Button>
        <Button className={cn(iconButton, !disabled.delete && "text-destructive")} variant="outline" size="icon-sm" disabled={disabled.delete} aria-disabled={disabled.delete} data-action="delete" aria-label="删除服务" title="删除服务" onClick={action("delete")}><Trash2 className="size-3" /></Button>
      </div>
    </article>
  );
}
