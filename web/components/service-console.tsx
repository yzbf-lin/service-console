"use client";

import { useCallback, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PortsView } from "@/components/ports-view";
import { ServiceControlView } from "@/components/service-control-view";
import { ServiceFormDialog, type ServiceFormMode } from "@/components/service-form-dialog";
import { SettingsView } from "@/components/settings-view";
import { SidebarNav } from "@/components/sidebar-nav";
import { ToastProvider, useToast } from "@/components/toast-provider";
import { Topbar } from "@/components/topbar";
import { useHashView } from "@/hooks/use-hash-view";
import { useServices } from "@/hooks/use-services";
import { useTheme } from "@/hooks/use-theme";
import type {
  NormalizedService,
  ServiceAction,
  ServiceCreateInput,
  ServiceUpdateInput,
} from "@/lib/types";

function ServiceConsoleContent() {
  const { notify } = useToast();
  const { activeView, setActiveView } = useHashView();
  const [token] = useState(() => (
    typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") || ""
  ));
  const [refreshing, setRefreshing] = useState(false);
  const [portRefreshSignal, setPortRefreshSignal] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<ServiceFormMode>("create");
  const [formSource, setFormSource] = useState<NormalizedService | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NormalizedService | null>(null);

  const showError = useCallback((title: string, message: string) => {
    notify(title, message, "error");
  }, [notify]);

  const showSuccess = useCallback((title: string, message: string) => {
    notify(title, message, "success");
  }, [notify]);

  const { preference, resolvedTheme, setPreference, toggleTheme } = useTheme(
    token,
    useCallback((message: string) => showError("主题偏好未保存", message), [showError]),
  );

  const serviceState = useServices({ token, enabled: true, onError: showError });

  const openForm = useCallback((mode: ServiceFormMode, service: NormalizedService | null = null) => {
    setFormMode(mode);
    setFormSource(service);
    setFormOpen(true);
  }, []);

  const handleServiceAction = useCallback(async (name: string, action: ServiceAction) => {
    const service = serviceState.services.find((candidate) => candidate.name === name);
    if (!service) return;
    if (action === "edit" || action === "copy") {
      openForm(action, service);
      return;
    }
    if (action === "delete") {
      setDeleteTarget(service);
      return;
    }
    try {
      await serviceState.runAction(name, action);
      const label = action === "start" ? "启动" : action === "stop" ? "停止" : "重启";
      showSuccess(`${label}指令已执行`, name);
    } catch (error) {
      showError("服务操作失败", error instanceof Error ? error.message : String(error));
    }
  }, [openForm, serviceState, showError, showSuccess]);

  const submitServiceForm = useCallback(async (input: ServiceCreateInput | ServiceUpdateInput) => {
    setFormSubmitting(true);
    try {
      if (formMode === "edit" && formSource) {
        await serviceState.updateService(formSource.name, input as ServiceUpdateInput);
        showSuccess("服务配置已保存", formSource.name);
      } else {
        const created = await serviceState.createService(input as ServiceCreateInput);
        showSuccess(formMode === "copy" ? "服务副本已创建" : "服务已添加", created.name);
      }
      setFormOpen(false);
    } finally {
      setFormSubmitting(false);
    }
  }, [formMode, formSource, serviceState, showSuccess]);

  const confirmDelete = useCallback(async () => {
    const service = deleteTarget;
    setDeleteTarget(null);
    if (!service) return;
    try {
      await serviceState.deleteService(service.name);
      showSuccess("服务已删除", service.name);
    } catch (error) {
      showError("删除服务失败", error instanceof Error ? error.message : String(error));
    }
  }, [deleteTarget, serviceState, showError, showSuccess]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (activeView === "ports") {
        setPortRefreshSignal((value) => value + 1);
        await serviceState.checkHealth();
      } else {
        await Promise.all([serviceState.loadServices(), serviceState.checkHealth()]);
      }
    } finally {
      setRefreshing(false);
    }
  }, [activeView, serviceState]);

  const existingNames = useMemo(() => serviceState.services.map((service) => service.name), [serviceState.services]);

  let content;
  if (activeView === "ports") {
    content = (
      <PortsView
        api={serviceState.api}
        active
        refreshSignal={portRefreshSignal}
        onError={showError}
        onSuccess={showSuccess}
      />
    );
  } else if (activeView === "settings") {
    content = (
      <SettingsView
        preference={preference}
        resolvedTheme={resolvedTheme}
        onPreferenceChange={(nextPreference) => void setPreference(nextPreference)}
      />
    );
  } else {
    content = (
      <ServiceControlView
        services={serviceState.services}
        selectedName={serviceState.selectedName}
        selectedService={serviceState.selectedService}
        logs={serviceState.selectedLogs}
        logRevision={serviceState.logRevision}
        busyServices={serviceState.busyServices}
        theme={resolvedTheme}
        active
        onSelect={serviceState.selectService}
        onAction={(name, action) => void handleServiceAction(name, action)}
        onClearLogs={() => {
          serviceState.clearVisibleLogs();
          notify("当前视图已清空", "服务端日志文件不会被删除", "info");
        }}
      />
    );
  }

  return (
    <div className="service-console-shell">
      <Topbar
        activeView={activeView}
        apiStatus={serviceState.apiStatus}
        socketStatus={serviceState.socketStatus}
        resolvedTheme={resolvedTheme}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        onAddService={() => openForm("create")}
        onToggleTheme={toggleTheme}
      />

      <div className="service-console-body">
        <SidebarNav activeView={activeView} onViewChange={setActiveView} />
        <div className="service-console-stage">{content}</div>
      </div>

      {formOpen ? (
        <ServiceFormDialog
          open
          mode={formMode}
          sourceService={formSource}
          existingNames={existingNames}
          submitting={formSubmitting}
          onOpenChange={setFormOpen}
          onSubmit={submitServiceForm}
        />
      ) : null}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除服务“{deleteTarget?.name}”</AlertDialogTitle>
            <AlertDialogDescription>
              服务定义和当前控制台日志缓存会被移除；如果服务仍在运行，后端会先停止进程。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void confirmDelete()}>删除服务</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ServiceConsole() {
  return (
    <ToastProvider>
      <ServiceConsoleContent />
    </ToastProvider>
  );
}
