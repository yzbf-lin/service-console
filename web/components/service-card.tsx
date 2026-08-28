"use client";

import { ServiceActionsMenu } from "@/components/service-actions";
import {
  formatBytes,
  formatPercent,
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
  RUNNING: "bg-success",
  STARTING: "bg-warning animate-pulse",
  STOPPING: "bg-warning animate-pulse",
  FAILED: "bg-destructive",
  EXITED: "bg-violet-500",
  STOPPED: "bg-muted-foreground/65",
  UNKNOWN: "bg-muted-foreground/65",
};

function statusTextClass(status: NormalizedService["status"]) {
  if (status === "RUNNING") return "text-success";
  if (status === "FAILED") return "text-destructive";
  if (status === "STARTING" || status === "STOPPING") return "text-warning";
  return "text-muted-foreground";
}

export function ServiceCard({ service, selected, busy, onSelect, onAction }: ServiceCardProps) {
  const memory = service.memoryBytes !== null
    ? formatBytes(service.memoryBytes)
    : formatPercent(service.memoryPercent);

  return (
    <article
      className={cn(
        "group relative border-b border-border/70",
        selected && "bg-accent/75",
      )}
      data-service={service.name}
    >
      <button
        className={cn(
          "relative flex min-h-[68px] w-full min-w-0 flex-col justify-center gap-1 px-3 py-2 pr-10 text-left outline-none transition-colors",
          "hover:bg-accent/45 focus-visible:z-[1] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/80",
          "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-r-full before:bg-transparent",
          selected && "before:bg-primary",
        )}
        type="button"
        data-service-select={service.name}
        aria-pressed={selected}
        aria-label={`${service.name}，${statusLabel(service.status)}`}
        onClick={onSelect}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", statusClasses[service.status])} aria-hidden="true" />
          <strong className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={service.name}>{service.name}</strong>
          <span className={cn("shrink-0 text-[10px] font-medium", statusTextClass(service.status))}>
            {busy ? "处理中" : statusLabel(service.status)}
          </span>
        </span>

        <span className="block w-full truncate pl-4 font-mono text-[10px] text-secondary-foreground/85" title={service.command}>
          {service.command}
        </span>

        <span className="flex w-full min-w-0 items-center gap-2 pl-4 text-[10px] text-muted-foreground">
          <span className="font-mono">PID {service.pid ?? "—"}</span>
          <span aria-hidden="true">·</span>
          <span>CPU {formatPercent(service.cpuPercent)}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{memory}</span>
        </span>
      </button>

      <div className="absolute top-1.5 right-1.5 opacity-65 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <ServiceActionsMenu service={service} busy={busy} onAction={onAction} />
      </div>
    </article>
  );
}
