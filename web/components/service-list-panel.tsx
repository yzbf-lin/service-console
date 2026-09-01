"use client";

import {
  ChevronDown,
  Folder,
  FolderPlus,
  ListFilter,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  ServerOff,
  Square,
  Trash2,
} from "lucide-react";
import { motion } from "motion/react";
import { type DragEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ServiceCard } from "@/components/service-card";
import { cn } from "@/lib/cn";
import type {
  NormalizedService,
  ServiceAction,
  ServiceGroupAction,
} from "@/lib/types";

type ServiceStatusGroup = "active" | "stopped" | "failed";
type ServiceStatusFilter = "all" | ServiceStatusGroup;

interface ServiceListPanelProps {
  services: NormalizedService[];
  groups: string[];
  selectedName: string | null;
  busyServices: Set<string>;
  busyGroups: Set<string>;
  className?: string;
  variant?: "content" | "drawer";
  onAddService?: () => void;
  onCreateGroup?: () => void;
  onDeleteGroup: (group: string) => void;
  onMoveService: (service: string, group: string | null) => void;
  onGroupAction: (group: string, action: ServiceGroupAction) => void;
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

function sectionKey(group: string | null) {
  return group === null ? "__ungrouped__" : `group:${group}`;
}

export function ServiceListPanel({
  services,
  groups,
  selectedName,
  busyServices,
  busyGroups,
  className,
  variant = "content",
  onAddService,
  onCreateGroup,
  onDeleteGroup,
  onMoveService,
  onGroupAction,
  onSelect,
  onAction,
}: ServiceListPanelProps) {
  const headingId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<ServiceStatusFilter>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [draggedService, setDraggedService] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const groupNames = useMemo(() => [...new Set([
    ...groups,
    ...services.map((service) => service.group).filter((group): group is string => Boolean(group)),
  ])].sort((left, right) => left.localeCompare(right)), [groups, services]);

  const visibleServices = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return services.filter((service) => {
      if (!matchesStatus(service, statusFilter)) return false;
      if (!query) return true;
      return `${service.name} ${service.group ?? ""} ${service.command} ${service.cwd}`
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [filter, services, statusFilter]);

  const sections = useMemo(() => [
    ...groupNames.map((group) => ({
      group,
      all: services.filter((service) => service.group === group),
      visible: visibleServices.filter((service) => service.group === group),
    })),
    {
      group: null,
      all: services.filter((service) => !service.group),
      visible: visibleServices.filter((service) => !service.group),
    },
  ], [groupNames, services, visibleServices]);

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
      const button = [...(buttons ?? [])].find((candidate) => candidate.dataset.serviceSelect === next.name);
      button?.focus();
    });
  };

  const startDragging = (event: DragEvent<HTMLElement>, service: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", service);
    setDraggedService(service);
  };

  const dropInto = (event: DragEvent<HTMLElement>, group: string | null) => {
    event.preventDefault();
    const serviceName = draggedService || event.dataTransfer.getData("text/plain");
    const service = services.find((candidate) => candidate.name === serviceName);
    setDraggedService(null);
    setDropTarget(null);
    if (!service || service.group === group) return;
    onMoveService(service.name, group);
  };

  return (
    <section
      className={cn(
        "flex min-h-0 flex-col overflow-hidden",
        variant === "content" && "service-list-glass bg-[var(--sidebar)]",
        variant === "drawer" && "service-list-glass h-full bg-card",
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
            <span>活动中 {statusCounts.active}</span><span aria-hidden="true">·</span>
            <span>已停止 {statusCounts.stopped}</span><span aria-hidden="true">·</span>
            <span className={cn(statusCounts.failed > 0 && "text-destructive")}>异常 {statusCounts.failed}</span>
          </p>
        </div>
        <div className="flex items-center gap-1">
          {onCreateGroup ? (
            <Button variant="outline" size="icon-sm" className="size-7" type="button" aria-label="新建分组" title="新建分组" onClick={onCreateGroup}>
              <FolderPlus className="size-3.5" />
            </Button>
          ) : null}
          {onAddService ? (
            <Button className="h-7 shrink-0 rounded-md px-2 text-[10px] shadow-none" size="sm" type="button" aria-label="添加服务" onClick={onAddService}>
              <Plus className="size-3" />添加
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input ref={searchRef} className="h-8 rounded-lg border-border/80 bg-background/70 pl-8 text-[11px] shadow-none" type="search" value={filter} placeholder="搜索服务或分组" aria-label="筛选服务" onChange={(event) => setFilter(event.target.value)} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className={cn("relative size-8 rounded-lg text-muted-foreground shadow-none", statusFilter !== "all" && "bg-accent text-accent-foreground")} variant="outline" size="icon-sm" aria-label={`筛选服务状态：${activeFilterLabel}`} title={`状态筛选：${activeFilterLabel}`}>
              <ListFilter className="size-3.5" />
              {statusFilter !== "all" ? <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" aria-hidden="true" /> : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>服务状态</DropdownMenuLabel><DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={statusFilter} onValueChange={(value) => setStatusFilter(value as ServiceStatusFilter)}>
              {statusFilters.map((item) => <DropdownMenuRadioItem key={item.value} value={item.value}>{item.label}</DropdownMenuRadioItem>)}
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
        {!services.length && !groups.length ? (
          <motion.div className="flex min-h-48 flex-col items-center justify-center gap-1 px-4 text-center text-muted-foreground" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.16 }}>
            <ServerOff className="mb-1 size-6" strokeWidth={1.5} aria-hidden="true" />
            <strong className="text-[12px] text-secondary-foreground">还没有服务</strong>
            <span className="text-[11px]">添加服务后可拖拽到分组</span>
          </motion.div>
        ) : sections.map(({ group, all, visible }) => {
          const key = sectionKey(group);
          const collapsed = collapsedGroups.has(key);
          const groupBusy = group !== null && (busyGroups.has(group) || all.some((service) => busyServices.has(service.name)));
          const canStart = all.some((service) => ["STOPPED", "EXITED", "FAILED"].includes(service.status));
          const canStop = all.some((service) => ["RUNNING", "STARTING"].includes(service.status));
          const running = all.filter((service) => ["RUNNING", "STARTING"].includes(service.status)).length;
          const activeDrop = dropTarget === key;
          return (
            <section
              key={key}
              className={cn("border-b border-border/70 transition-colors", activeDrop && "bg-primary/8 ring-2 ring-inset ring-primary/55")}
              aria-label={group ?? "未分组"}
              onDragEnter={(event) => {
                event.preventDefault();
                setDropTarget(key);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
              }}
              onDrop={(event) => dropInto(event, group)}
            >
              <div className={cn("flex min-h-9 items-center gap-1 px-2", draggedService && "border-b border-dashed border-primary/25")}>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left outline-none hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-ring/80"
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key); else next.add(key);
                    return next;
                  })}
                >
                  <ChevronDown className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")} />
                  <Folder className={cn("size-3.5 shrink-0", group ? "text-primary" : "text-muted-foreground")} />
                  <strong className="truncate text-[10px] font-semibold">{group ?? "未分组"}</strong>
                  <span className="shrink-0 text-[9px] tabular-nums text-muted-foreground">{running}/{all.length} 运行</span>
                </button>
                {group ? (
                  <>
                    <Button variant="ghost" size="icon-sm" className="size-6" disabled={groupBusy || !canStart} aria-label={`启动分组 ${group}`} title="启动分组" onClick={() => onGroupAction(group, "start")}><Play className="size-3" /></Button>
                    <Button variant="ghost" size="icon-sm" className="size-6" disabled={groupBusy || !canStop} aria-label={`停止分组 ${group}`} title="停止分组" onClick={() => onGroupAction(group, "stop")}><Square className="size-3" /></Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="size-6" disabled={groupBusy} aria-label={`管理分组 ${group}`}><MoreHorizontal className="size-3.5" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onDeleteGroup(group)}><Trash2 className="size-3.5" />删除分组</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : null}
              </div>

              {!collapsed ? (
                visible.length ? visible.map((service) => {
                  const serviceBusy = busyServices.has(service.name);
                  return (
                    <div
                      key={service.name}
                      draggable={!serviceBusy}
                      className={cn(!serviceBusy && "cursor-grab active:cursor-grabbing")}
                      title={serviceBusy ? undefined : "拖拽到目标分组"}
                      onDragStart={(event) => startDragging(event, service.name)}
                      onDragEnd={() => {
                        setDraggedService(null);
                        setDropTarget(null);
                      }}
                    >
                      <ServiceCard
                        service={service}
                        selected={selectedName === service.name}
                        busy={serviceBusy}
                        onSelect={() => onSelect(service.name)}
                        onAction={(action) => onAction(service.name, action)}
                      />
                    </div>
                  );
                }) : (
                  <div className={cn("px-4 py-3 text-center text-[9px] text-muted-foreground", activeDrop && "font-medium text-primary")}>
                    {activeDrop ? `松开以移入${group ? `“${group}”` : "未分组"}` : all.length ? "没有匹配当前筛选的服务" : "拖拽服务到此分组"}
                  </div>
                )
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}
