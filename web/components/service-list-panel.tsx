"use client";

import { Search, ServerOff } from "lucide-react";
import { useMemo } from "react";

import { Input } from "@/components/ui/input";
import { ServiceCard } from "@/components/service-card";
import type { NormalizedService, ServiceAction } from "@/lib/types";
import { cn } from "@/lib/cn";

interface ServiceListPanelProps {
  services: NormalizedService[];
  selectedName: string | null;
  busyServices: Set<string>;
  filter: string;
  className?: string;
  onFilterChange: (value: string) => void;
  onSelect: (name: string) => void;
  onAction: (name: string, action: ServiceAction) => void;
}

export function ServiceListPanel({
  services,
  selectedName,
  busyServices,
  filter,
  className,
  onFilterChange,
  onSelect,
  onAction,
}: ServiceListPanelProps) {
  const visibleServices = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return services;
    return services.filter((service) => (
      `${service.name} ${service.command} ${service.cwd}`.toLocaleLowerCase().includes(query)
    ));
  }, [filter, services]);
  const running = services.filter((service) => service.status === "RUNNING").length;

  return (
    <aside className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card shadow-[var(--shadow-panel)]", className)} aria-labelledby="servicesHeading">
      <header className="flex min-h-[58px] shrink-0 items-center justify-between border-b px-3 py-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="servicesHeading" className="text-sm font-bold">服务</h2>
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-bold text-secondary-foreground">{services.length}</span>
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">{running} 个运行中 · {services.length - running} 个未运行</p>
        </div>
      </header>

      <div className="relative shrink-0 p-2">
        <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          className="h-8 bg-secondary/60 pl-8 text-[11px]"
          type="search"
          value={filter}
          placeholder="筛选服务名称或命令"
          aria-label="筛选服务"
          onChange={(event) => onFilterChange(event.target.value)}
        />
      </div>

      <div
        className="no-visible-scrollbar min-h-0 flex-1 space-y-1.5 overflow-x-hidden overflow-y-auto px-1.5 pb-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
        tabIndex={0}
        role="region"
        aria-label="服务列表，可滚动"
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
            <ServerOff className="mb-1 size-7" strokeWidth={1.5} aria-hidden="true" />
            <strong className="text-xs text-secondary-foreground">{services.length ? "没有匹配的服务" : "还没有服务"}</strong>
            <span className="text-[10px]">{services.length ? "尝试更换筛选关键词" : "点击右上角“添加服务”开始"}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
