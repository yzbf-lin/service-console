"use client";

import { ListFilter, Plus, Search, ServerOff } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ServiceCard } from "@/components/service-card";
import type { NormalizedService, ServiceAction } from "@/lib/types";
import { cn } from "@/lib/cn";

type ServiceStatusGroup = "active" | "stopped" | "failed";
type ServiceStatusFilter = "all" | ServiceStatusGroup;

interface ServiceListPanelProps {
  services: NormalizedService[];
  selectedName: string | null;
  busyServices: Set<string>;
  className?: string;
  variant?: "content" | "drawer";
  onAddService?: () => void;
  onSelect: (name: string) => void;
  onAction: (name: string, action: ServiceAction) => void;
}

const statusFilters: Array<{ value: ServiceStatusFilter; label: string }> = [
  { value: "all", label: "全部服务" },
  { value: "active", label: "活动中" },
  { value: "stopped", label: "已停止" },
  { value: "failed", label: "异常" },
];

function statusGroup(service: NormalizedService): ServiceStatusGroup {
  if (["RUNNING", "STARTING", "STOPPING"].includes(service.status)) return "active";
  if (["STOPPED", "EXITED"].includes(service.status)) return "stopped";
  return "failed";
}

function matchesStatus(service: NormalizedService, filter: ServiceStatusFilter) {
  return filter === "all" || statusGroup(service) === filter;
}

export function ServiceListPanel({
  services,
  selectedName,
  busyServices,
  className,
  variant = "content",
  onAddService,
  onSelect,
  onAction,
}: ServiceListPanelProps) {
  const headingId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<ServiceStatusFilter>("all");

  const visibleServices = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return services.filter((service) => {
      if (!matchesStatus(service, statusFilter)) return false;
      if (!query) return true;
      return `${service.name} ${service.command} ${service.cwd}`.toLocaleLowerCase().includes(query);
    });
  }, [filter, services, statusFilter]);

  const statusCounts = useMemo(() => services.reduce<Record<ServiceStatusGroup, number>>(
    (counts, service) => ({ ...counts, [statusGroup(service)]: counts[statusGroup(service)] + 1 }),
    { active: 0, stopped: 0, failed: 0 },
  ), [services]);
  const activeFilterLabel = statusFilters.find((item) => item.value === statusFilter)?.label ?? "全部服务";

  useEffect(() => {
    const focusFilter = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener("keydown", focusFilter);
    return () => document.removeEventListener("keydown", focusFilter);
  }, []);

  const moveSelection = (direction: -1 | 1) => {
    if (!visibleServices.length) return;
    const currentIndex = visibleServices.findIndex((service) => service.name === selectedName);
    const nextIndex = currentIndex < 0
      ? (direction > 0 ? 0 : visibleServices.length - 1)
      : (currentIndex + direction + visibleServices.length) % visibleServices.length;
    const next = visibleServices[nextIndex];
    if (!next) return;
    onSelect(next.name);
    window.requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-service-select]");
      buttons?.[nextIndex]?.focus();
    });
  };

  return (
    <section
      className={cn(
        "flex min-h-0 flex-col overflow-hidden",
        variant === "content" && "bg-[var(--sidebar)]",
        variant === "drawer" && "h-full bg-card",
        className,
      )}
      aria-labelledby={headingId}
      data-service-list-variant={variant}
    >
      <header className="flex min-h-[50px] shrink-0 items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 id={headingId} className="text-[12px] font-semibold">服务</h2>
            <span className="text-[10px] tabular-nums text-muted-foreground">{services.length}</span>
          </div>
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <span>活动中 {statusCounts.active}</span>
            <span aria-hidden="true">·</span>
            <span>已停止 {statusCounts.stopped}</span>
            <span aria-hidden="true">·</span>
            <span className={cn(statusCounts.failed > 0 && "text-destructive")}>异常 {statusCounts.failed}</span>
          </p>
        </div>
        {onAddService ? (
          <Button
            className="h-7 shrink-0 rounded-md px-2 text-[10px] shadow-none"
            size="sm"
            type="button"
            aria-label="添加服务"
            onClick={onAddService}
          >
            <Plus className="size-3" />
            添加
          </Button>
        ) : null}
      </header>

      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            ref={searchRef}
            className="h-8 rounded-lg border-border/80 bg-background/70 pl-8 text-[11px] shadow-none"
            type="search"
            value={filter}
            placeholder="搜索服务"
            aria-label="筛选服务"
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className={cn(
                "relative size-8 rounded-lg text-muted-foreground shadow-none",
                statusFilter !== "all" && "bg-accent text-accent-foreground",
              )}
              variant="outline"
              size="icon-sm"
              aria-label={`筛选服务状态：${activeFilterLabel}`}
              title={`状态筛选：${activeFilterLabel}`}
            >
              <ListFilter className="size-3.5" />
              {statusFilter !== "all" ? <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" aria-hidden="true" /> : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>服务状态</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={statusFilter} onValueChange={(value) => setStatusFilter(value as ServiceStatusFilter)}>
              {statusFilters.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value}>{item.label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div
        ref={listRef}
        className="no-visible-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto border-t outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/80"
        tabIndex={0}
        role="region"
        aria-label="服务列表，可滚动"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveSelection(event.key === "ArrowDown" ? 1 : -1);
          }
        }}
      >
        {visibleServices.length ? visibleServices.map((service) => (
          <ServiceCard
            key={service.name}
            service={service}
            selected={selectedName === service.name}
            busy={busyServices.has(service.name)}
            onSelect={() => onSelect(service.name)}
            onAction={(action) => onAction(service.name, action)}
          />
        )) : (
          <div className="flex min-h-48 flex-col items-center justify-center gap-1 px-4 text-center text-muted-foreground">
            <ServerOff className="mb-1 size-6" strokeWidth={1.5} aria-hidden="true" />
            <strong className="text-[12px] text-secondary-foreground">{services.length ? "没有匹配的服务" : "还没有服务"}</strong>
            <span className="text-[11px]">{services.length ? "调整关键词或状态筛选" : "点击右上角的“添加”"}</span>
          </div>
        )}
      </div>
    </section>
  );
}
