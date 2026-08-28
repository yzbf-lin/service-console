"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { ServiceListPanel } from "@/components/service-list-panel";
import { SettingsView } from "@/components/settings-view";
import { SidebarNav } from "@/components/sidebar-nav";
import { ToastProvider, useToast } from "@/components/toast-provider";
import { Topbar } from "@/components/topbar";
import { useAppUpdate } from "@/hooks/use-app-update";
import { useHashView } from "@/hooks/use-hash-view";
import { useServices } from "@/hooks/use-services";
import { useTheme } from "@/hooks/use-theme";
import type {
  NormalizedService,
  NormalizedProcessCandidate,
  ServiceAction,
  ServiceCreateInput,
  ServiceUpdateInput,
  ViewId,
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
  const [formProcessSource, setFormProcessSource] = useState<NormalizedProcessCandidate | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NormalizedService | null>(null);
  const processImportRequestId = useRef(0);
  const notifiedUpdateVersionsRef = useRef(new Set<string>());

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
  const appUpdate = useAppUpdate({ api: serviceState.api, onError: showError });
  const latestVersion = appUpdate.status?.latest_version ?? null;
  const updateAvailable = Boolean(
    latestVersion
      && latestVersion !== appUpdate.status?.current_version
      && !["idle", "checking", "up_to_date"].includes(appUpdate.status?.state ?? "idle"),
  );

  useEffect(() => {
    const status = appUpdate.status;
    if (
      !latestVersion
      || !updateAvailable
      || !["available", "unsupported", "downloaded"].includes(status?.state ?? "idle")
      || notifiedUpdateVersionsRef.current.has(latestVersion)
    ) return;

    notifiedUpdateVersionsRef.current.add(latestVersion);
    notify(
      `发现新版本 v${latestVersion}`,
      status?.can_install ? "前往设置下载并安装更新。" : "前往设置查看适合当前平台的 Release 安装包。",
      "info",
    );
  }, [appUpdate.status, latestVersion, notify, updateAvailable]);

  const cancelProcessImport = useCallback(() => {
    processImportRequestId.current += 1;
  }, []);

  useEffect(() => () => cancelProcessImport(), [cancelProcessImport]);

  useEffect(() => {
    cancelProcessImport();
  }, [activeView, cancelProcessImport]);

  const openForm = useCallback((mode: ServiceFormMode, service: NormalizedService | null = null) => {
    cancelProcessImport();
    setFormMode(mode);
    setFormSource(service);
    setFormProcessSource(null);
    setFormOpen(true);
  }, [cancelProcessImport]);

  const openProcessForm = useCallback(async (pid: number) => {
    const requestId = ++processImportRequestId.current;
    try {
      const process = await serviceState.api.getProcess(pid);
      if (requestId !== processImportRequestId.current) return;
      if (process.managedService) {
        throw new Error(`该进程已由服务 ${process.managedService} 管理`);
      }
      if (!process.restorable) {
        throw new Error(process.warnings[0] || "该进程缺少可恢复的启动命令或工作目录");
      }
      setFormMode("create");
      setFormSource(null);
      setFormProcessSource(process);
      setFormOpen(true);
    } catch (error) {
      if (requestId !== processImportRequestId.current) return;
      throw error;
    }
  }, [serviceState.api]);

  const changeView = useCallback((view: ViewId) => {
    cancelProcessImport();
    setActiveView(view);
  }, [cancelProcessImport, setActiveView]);

  const changeFormOpen = useCallback((nextOpen: boolean) => {
    if (!nextOpen) cancelProcessImport();
    setFormOpen(nextOpen);
  }, [cancelProcessImport]);

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
      notify(`${label}操作已提交`, `${name} 的最终状态会通过实时连接更新`, "info");
    } catch (error) {
      showError("服务操作失败", error instanceof Error ? error.message : String(error));
    }
  }, [notify, openForm, serviceState, showError]);

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
  const runningCount = useMemo(
    () => serviceState.services.filter((service) => service.status === "RUNNING").length,
    [serviceState.services],
  );

  let content;
  if (activeView === "ports") {
    content = (
      <PortsView
        api={serviceState.api}
        active
        refreshSignal={portRefreshSignal}
        onError={showError}
        onSuccess={showSuccess}
        onImportProcess={openProcessForm}
      />
    );
  } else if (activeView === "settings") {
    content = (
      <SettingsView
        preference={preference}
        resolvedTheme={resolvedTheme}
        updateStatus={appUpdate.status}
        updateOperation={appUpdate.operation}
        onPreferenceChange={(nextPreference) => void setPreference(nextPreference)}
        onCheckForUpdates={() => void appUpdate.checkForUpdates()}
        onDownloadUpdate={() => void appUpdate.downloadUpdate()}
        onInstallUpdate={() => void appUpdate.installUpdate()}
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
    <div className="service-console-shell" data-view={activeView}>
      <Topbar
        activeView={activeView}
        apiStatus={serviceState.apiStatus}
        socketStatus={serviceState.socketStatus}
        resolvedTheme={resolvedTheme}
        refreshing={refreshing}
        runningCount={runningCount}
        serviceCount={serviceState.services.length}
        selectedServiceName={serviceState.selectedService?.name ?? null}
        onRefresh={() => void refresh()}
        onAddService={() => openForm("create")}
        onToggleTheme={toggleTheme}
      />

      <div className="service-console-body" data-view={activeView}>
        <SidebarNav
          activeView={activeView}
          updateAvailable={updateAvailable}
          onViewChange={changeView}
        >
          {activeView === "services" ? (
            <ServiceListPanel
              services={serviceState.services}
              selectedName={serviceState.selectedName}
              busyServices={serviceState.busyServices}
              onSelect={serviceState.selectService}
              onAction={(name, action) => void handleServiceAction(name, action)}
            />
          ) : null}
        </SidebarNav>
        <div className="service-console-stage">{content}</div>
      </div>

      {formOpen ? (
        <ServiceFormDialog
          open
          mode={formMode}
          sourceService={formSource}
          sourceProcess={formProcessSource}
          existingNames={existingNames}
          submitting={formSubmitting}
          api={serviceState.api}
          onOpenChange={changeFormOpen}
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
