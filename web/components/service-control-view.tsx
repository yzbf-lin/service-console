"use client";

import { ChevronRight, ListFilter, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ResizableGroup, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { ServiceInspector } from "@/components/service-inspector";
import { ServiceListPanel } from "@/components/service-list-panel";
import { TerminalConsole } from "@/components/terminal-console";
import { useMediaQuery } from "@/hooks/use-media-query";
import type {
  NormalizedLogEntry,
  NormalizedService,
  ResolvedTheme,
  ServiceAction,
  ServiceGroupAction,
} from "@/lib/types";
import { cn } from "@/lib/cn";

interface ServiceControlViewProps {
  services: NormalizedService[];
  groups: string[];
  selectedName: string | null;
  selectedService: NormalizedService | null;
  logs: NormalizedLogEntry[];
  logRevision: number;
  busyServices: Set<string>;
  busyGroups: Set<string>;
  theme: ResolvedTheme;
  active: boolean;
  onSelect: (name: string) => void;
  onAction: (name: string, action: ServiceAction) => void;
  onAddService: () => void;
  onCreateGroup: () => void;
  onDeleteGroup: (group: string) => void;
  onMoveService: (service: string, group: string | null, position: number) => void | Promise<void>;
  onGroupAction: (group: string, action: ServiceGroupAction) => void;
  onClearLogs: () => void;
}

/** Below this width the service list becomes a drawer and the panes stack. */
const COMPACT_LAYOUT = "(max-width: 767px)";
/** Below this width the inspector pane is dropped; the console keeps the room. */
const INSPECTOR_LAYOUT = "(min-width: 1100px)";

export function ServiceControlView({
  services,
  groups,
  selectedName,
  selectedService,
  logs,
  logRevision,
  busyServices,
  busyGroups,
  theme,
  active,
  onSelect,
  onAction,
  onAddService,
  onCreateGroup,
  onDeleteGroup,
  onMoveService,
  onGroupAction,
  onClearLogs,
}: ServiceControlViewProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const compact = useMediaQuery(COMPACT_LAYOUT);
  const showInspector = useMediaQuery(INSPECTOR_LAYOUT);
  const selectedBusy = selectedService ? busyServices.has(selectedService.name) : false;

  const selectFromDrawer = (name: string) => {
    onSelect(name);
    setDrawerOpen(false);
  };

  const handleDrawerOpenChange = (open: boolean) => {
    // A resize that crosses the breakpoint closes the drawer so the list is
    // never rendered twice once the desktop pane is back.
    if (open && !compact) return;
    setDrawerOpen(open);
  };

  return (
    <main
      id="servicesView"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="服务控制"
    >
      {compact ? (
        <div className="flex shrink-0 items-center gap-2 border-b p-2">
          <Button
            variant="outline"
            className="h-11 min-w-0 flex-1 items-center justify-between px-3"
            type="button"
            aria-expanded={drawerOpen}
            aria-controls="mobileServiceDrawer"
            onClick={() => setDrawerOpen(true)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "size-2.5 rounded-full bg-muted-foreground",
                  selectedService?.status === "RUNNING" && "bg-success",
                  selectedService?.status === "FAILED" && "bg-destructive",
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 text-left">
                <small className="block text-[9px] text-muted-foreground">当前服务</small>
                <strong className="block truncate text-xs">{selectedService?.name ?? "选择服务"}</strong>
              </span>
            </span>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <ListFilter className="size-3.5" />
              服务列表
              <ChevronRight className="size-3.5" />
            </span>
          </Button>
          <Button
            className="size-11 shrink-0"
            size="icon"
            type="button"
            aria-label="添加服务"
            title="添加服务"
            onClick={onAddService}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col" aria-label="服务详情与日志">
        <ResizableGroup
          id="service-control-layout"
          orientation="horizontal"
          className="min-h-0 flex-1"
        >
          {compact ? null : (
            <>
              <ResizablePanel
                id="service-list"
                defaultSize="21%"
                minSize="14%"
                maxSize="38%"
              >
                <ServiceListPanel
                  className="h-full"
                  services={services}
                  groups={groups}
                  selectedName={selectedName}
                  busyServices={busyServices}
                  busyGroups={busyGroups}
                  onSelect={onSelect}
                  onAction={onAction}
                  onAddService={onAddService}
                  onCreateGroup={onCreateGroup}
                  onDeleteGroup={onDeleteGroup}
                  onMoveService={onMoveService}
                  onGroupAction={onGroupAction}
                />
              </ResizablePanel>
              <ResizableHandle id="service-list-resize" aria-label="调整服务列表宽度" />
            </>
          )}

          <ResizablePanel id="service-detail" minSize="45%">
            {showInspector ? (
              <ResizableGroup
                id="service-detail-layout"
                orientation="vertical"
                className="min-h-0 flex-1"
              >
                <ResizablePanel id="service-console" minSize="35%">
                  <TerminalConsole
                    service={selectedService}
                    logs={logs}
                    logRevision={logRevision}
                    theme={theme}
                    active={active}
                    onClear={onClearLogs}
                    busy={selectedBusy}
                    onAction={(action) => {
                      if (selectedService) onAction(selectedService.name, action);
                    }}
                  />
                </ResizablePanel>
                <ResizableHandle id="service-inspector-resize" aria-label="调整详情面板高度" />
                <ResizablePanel id="service-inspector" defaultSize="34%" minSize="18%" maxSize="70%">
                  <ServiceInspector
                    className="h-full"
                    service={selectedService}
                    busy={selectedBusy}
                    onAction={(action) => {
                      if (selectedService) onAction(selectedService.name, action);
                    }}
                  />
                </ResizablePanel>
              </ResizableGroup>
            ) : (
              <TerminalConsole
                service={selectedService}
                logs={logs}
                logRevision={logRevision}
                theme={theme}
                active={active}
                onClear={onClearLogs}
                busy={selectedBusy}
                onAction={(action) => {
                  if (selectedService) onAction(selectedService.name, action);
                }}
              />
            )}
          </ResizablePanel>
        </ResizableGroup>
      </section>

      <Dialog open={drawerOpen} onOpenChange={handleDrawerOpenChange}>
        <DialogContent
          id="mobileServiceDrawer"
          className="top-0 left-0 h-dvh max-h-dvh w-[min(88vw,360px)] max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-y-0 border-l-0 p-0"
        >
          <DialogTitle className="sr-only">服务列表</DialogTitle>
          <DialogDescription className="sr-only">选择服务并查看运行状态或执行操作</DialogDescription>
          <ServiceListPanel
            className="h-full"
            variant="drawer"
            services={services}
            groups={groups}
            selectedName={selectedName}
            busyServices={busyServices}
            busyGroups={busyGroups}
            onSelect={selectFromDrawer}
            onAction={onAction}
            onCreateGroup={onCreateGroup}
            onDeleteGroup={onDeleteGroup}
            onMoveService={onMoveService}
            onGroupAction={onGroupAction}
          />
        </DialogContent>
      </Dialog>
    </main>
  );
}
