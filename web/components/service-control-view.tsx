"use client";

import { ChevronRight, ListFilter } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ServiceInspector } from "@/components/service-inspector";
import { ServiceListPanel } from "@/components/service-list-panel";
import { TerminalConsole } from "@/components/terminal-console";
import type {
  NormalizedLogEntry,
  NormalizedService,
  ResolvedTheme,
  ServiceAction,
} from "@/lib/types";
import { cn } from "@/lib/cn";

interface ServiceControlViewProps {
  services: NormalizedService[];
  selectedName: string | null;
  selectedService: NormalizedService | null;
  logs: NormalizedLogEntry[];
  logRevision: number;
  busyServices: Set<string>;
  theme: ResolvedTheme;
  active: boolean;
  onSelect: (name: string) => void;
  onAction: (name: string, action: ServiceAction) => void;
  onClearLogs: () => void;
}

export function ServiceControlView({
  services,
  selectedName,
  selectedService,
  logs,
  logRevision,
  busyServices,
  theme,
  active,
  onSelect,
  onAction,
  onClearLogs,
}: ServiceControlViewProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const selectedBusy = selectedService ? busyServices.has(selectedService.name) : false;

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeDrawer = (event: MediaQueryListEvent) => {
      if (event.matches) setDrawerOpen(false);
    };
    desktop.addEventListener("change", closeDrawer);
    return () => desktop.removeEventListener("change", closeDrawer);
  }, []);

  const selectFromDrawer = (name: string) => {
    onSelect(name);
    setDrawerOpen(false);
  };

  return (
    <main id="servicesView" className="service-view-grid" aria-label="服务控制">
      <Button
        variant="outline"
        className="hidden h-11 w-full shrink-0 items-center justify-between px-3 max-[767px]:flex"
        type="button"
        aria-expanded={drawerOpen}
        aria-controls="mobileServiceDrawer"
        onClick={() => setDrawerOpen(true)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("size-2.5 rounded-full bg-muted-foreground", selectedService?.status === "RUNNING" && "bg-success", selectedService?.status === "FAILED" && "bg-destructive")} aria-hidden="true" />
          <span className="min-w-0 text-left">
            <small className="block text-[9px] text-muted-foreground">当前服务</small>
            <strong className="block truncate text-xs">{selectedService?.name ?? "选择服务"}</strong>
          </span>
        </span>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><ListFilter className="size-3.5" />服务列表<ChevronRight className="size-3.5" /></span>
      </Button>

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

      <ServiceInspector
        service={selectedService}
        busy={selectedBusy}
        onAction={(action) => {
          if (selectedService) onAction(selectedService.name, action);
        }}
      />

      <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
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
            selectedName={selectedName}
            busyServices={busyServices}
            onSelect={selectFromDrawer}
            onAction={onAction}
          />
        </DialogContent>
      </Dialog>
    </main>
  );
}
