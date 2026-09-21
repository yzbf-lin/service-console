"use client";

import { motion, useReducedMotion } from "motion/react";

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

export function ServiceCard({
  service,
  selected,
  busy,
  onSelect,
  onAction,
}: ServiceCardProps) {
  const reducedMotion = useReducedMotion();
  const memory = service.memoryBytes !== null
    ? formatBytes(service.memoryBytes)
    : formatPercent(service.memoryPercent);

  return (
    <motion.article
      className="service-card group relative"
      data-service={service.name}
      data-selected={selected}
      initial={reducedMotion ? false : { opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      <button
        className={cn(
          "relative flex min-h-[60px] w-full min-w-0 cursor-pointer flex-col justify-center gap-0.5 rounded-[inherit] px-2.5 py-1.5 pr-9 text-left outline-none transition-colors",
          "focus-visible:z-[1] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/80",
          "before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-r-full before:bg-transparent",
          selected && "before:bg-primary",
        )}
        type="button"
        data-service-select={service.name}
        aria-pressed={selected}
        aria-label={`${service.name}，${statusLabel(service.status)}`}
        onClick={onSelect}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5 leading-4">
          <span className={cn("size-2 shrink-0 rounded-full", statusClasses[service.status])} aria-hidden="true" />
          <strong className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={service.name}>{service.name}</strong>
          <span className={cn("shrink-0 text-[10px] font-medium", statusTextClass(service.status))}>
            {busy ? "处理中" : statusLabel(service.status)}
          </span>
        </span>

        <span className="block w-full truncate pl-3.5 font-mono text-[10px] leading-[14px] text-secondary-foreground/85" title={service.command}>
          {service.command}
        </span>

        <span className="flex w-full min-w-0 items-center gap-1 overflow-hidden pl-3.5 text-[10px] leading-[14px] whitespace-nowrap text-muted-foreground">
          <span className="shrink-0 font-mono tabular-nums">PID {service.pid ?? "—"}</span>
          <span className="shrink-0" aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">CPU {formatPercent(service.cpuPercent)}</span>
          <span className="shrink-0" aria-hidden="true">·</span>
          <span className="min-w-0 truncate" title={memory}>{memory}</span>
        </span>
      </button>

      <div className="absolute top-1 right-1 opacity-65 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <ServiceActionsMenu service={service} busy={busy} onAction={onAction} />
      </div>
    </motion.article>
  );
}
