"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MotionConfig, motion } from "motion/react";

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PortsView, type ProcessImportHint } from "@/components/ports-view";
import { JenkinsView } from "@/components/jenkins-view";
import { ServiceControlView } from "@/components/service-control-view";
import { ServiceFormDialog, type ServiceFormMode } from "@/components/service-form-dialog";
import { SettingsView } from "@/components/settings-view";
import { SidebarNav } from "@/components/sidebar-nav";
import { ToastProvider, useToast } from "@/components/toast-provider";
import { Topbar } from "@/components/topbar";
import { useAppUpdate } from "@/hooks/use-app-update";
import { useHashView } from "@/hooks/use-hash-view";
import { useMcpIntegration } from "@/hooks/use-mcp-integration";
import { useServices } from "@/hooks/use-services";
import { useTheme } from "@/hooks/use-theme";
import { ApiError } from "@/lib/api-client";
import type {
  NormalizedProcessCandidate,
  NormalizedService,
  ServiceAction,
  ServiceCreateInput,
  ServiceUpdateInput,
  ViewId,
} from "@/lib/types";

function isProcessPermissionError(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status === 403
    || (
      error.status === 409
      && /permission denied|access (?:is )?denied|权限|拒绝访问/i.test(error.message)
    )
  );
}

function permissionLimitedProcess(
  process: ProcessImportHint,
): NormalizedProcessCandidate {
  return {
    pid: process.pid,
    parentPid: null,
    createTime: null,
    startedAt: null,
    processName: process.processName || `进程 ${process.pid}`,
    command: "",
    cwd: "",
    username: "—",
    ports: process.ports,
    suggestedName: process.processName || `service-${process.pid}`,
    safeEnv: {},
    restorable: false,
    warnings: [
      "当前权限不足，无法读取完整进程信息。请手动补全启动命令和工作目录，并确认配置后再保存。",
    ],
    managedService: null,
  };
}

function ServiceConsoleContent() {
  const { notify } = useToast();
  const { activeView, setActiveView } = useHashView();
  const [token] = useState(() => (
    typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("token") || ""
  ));
  const [refreshing, setRefreshing] = useState(false);
  const [portRefreshSignal, setPortRefreshSignal] = useState(0);
  const [jenkinsRefreshSignal, setJenkinsRefreshSignal] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<ServiceFormMode>("create");
  const [formSource, setFormSource] = useState<NormalizedService | null>(null);
  const [formProcessSource, setFormProcessSource] = useState<NormalizedProcessCandidate | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NormalizedService | null>(null);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupError, setGroupError] = useState("");
  const [groupSubmitting, setGroupSubmitting] = useState(false);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<string | null>(null);
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
  const mcpIntegration = useMcpIntegration({
    api: serviceState.api,
    onError: showError,
    onSuccess: showSuccess,
  });
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

  const openProcessForm = useCallback(async (processHint: ProcessImportHint) => {
    const requestId = ++processImportRequestId.current;
    try {
      const process = await serviceState.api.getProcess(processHint.pid);
      if (requestId !== processImportRequestId.current) return;
      if (process.managedService) {
        throw new Error(`该进程已由服务 ${process.managedService} 管理`);
      }
      setFormMode("create");
      setFormSource(null);
      setFormProcessSource(process);
      setFormOpen(true);
    } catch (error) {
      if (requestId !== processImportRequestId.current) return;
      if (isProcessPermissionError(error)) {
        setFormMode("create");
        setFormSource(null);
        setFormProcessSource(permissionLimitedProcess(processHint));
        setFormOpen(true);
        return;
      }
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

  const copyMcpConfig = useCallback(async (config: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前系统未提供剪贴板写入能力");
      await navigator.clipboard.writeText(config);
      showSuccess("MCP 配置已复制", "可粘贴到 Codex 配置或终端中使用。");
    } catch (error) {
      showError("复制 MCP 配置失败", error instanceof Error ? error.message : String(error));
    }
  }, [showError, showSuccess]);

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

  const createGroup = useCallback(async () => {
    const name = groupName.trim();
    if (!name) {
      setGroupError("请输入分组名称");
      return;
    }
    if (name === "未分组") {
      setGroupError("“未分组”是系统保留区域，请使用其他名称");
      return;
    }
    setGroupSubmitting(true);
    setGroupError("");
    try {
      await serviceState.createGroup(name);
      setGroupDialogOpen(false);
      setGroupName("");
      showSuccess("分组已创建", name);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    } finally {
      setGroupSubmitting(false);
    }
  }, [groupName, serviceState, showSuccess]);

  const moveServiceToGroup = useCallback(async (service: string, group: string | null) => {
    try {
      await serviceState.assignGroup(service, group);
      showSuccess("服务分组已更新", `${service} → ${group ?? "未分组"}`);
    } catch (error) {
      showError("调整分组失败", error instanceof Error ? error.message : String(error));
    }
  }, [serviceState, showError, showSuccess]);

  const runGroupAction = useCallback(async (group: string, action: "start" | "stop") => {
    try {
      const result = await serviceState.runGroupAction(group, action);
      const label = action === "start" ? "启动" : "停止";
      if (result.errors.length) {
        showError(
          `分组${label}部分失败`,
          result.errors.map((error) => `${error.service}：${error.error}`).join("；"),
        );
      } else {
        showSuccess(`分组${label}完成`, `${group}：${result.services.length} 个服务`);
      }
    } catch (error) {
      showError("分组操作失败", error instanceof Error ? error.message : String(error));
    }
  }, [serviceState, showError, showSuccess]);

  const confirmDeleteGroup = useCallback(async () => {
    const group = deleteGroupTarget;
    setDeleteGroupTarget(null);
    if (!group) return;
    try {
      await serviceState.deleteGroup(group);
      showSuccess("分组已删除", "组内服务已移至“未分组”，运行状态未改变");
    } catch (error) {
      showError("删除分组失败", error instanceof Error ? error.message : String(error));
    }
  }, [deleteGroupTarget, serviceState, showError, showSuccess]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (activeView === "ports") {
        setPortRefreshSignal((value) => value + 1);
        await serviceState.checkHealth();
      } else if (activeView === "jenkins") {
        setJenkinsRefreshSignal((value) => value + 1);
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
  } else if (activeView === "jenkins") {
    content = (
      <JenkinsView
        api={serviceState.api}
        active
        refreshSignal={jenkinsRefreshSignal}
        theme={resolvedTheme}
        onError={showError}
        onSuccess={showSuccess}
      />
    );
  } else if (activeView === "settings") {
    content = (
      <SettingsView
        preference={preference}
        resolvedTheme={resolvedTheme}
        updateStatus={appUpdate.status}
        updateOperation={appUpdate.operation}
        mcpStatus={mcpIntegration.status}
        mcpOperation={mcpIntegration.operation}
        onPreferenceChange={(nextPreference) => void setPreference(nextPreference)}
        onCheckForUpdates={() => void appUpdate.checkForUpdates()}
        onDownloadUpdate={() => void appUpdate.downloadUpdate()}
        onInstallUpdate={() => void appUpdate.installUpdate()}
        onInstallMcp={() => void mcpIntegration.install()}
        onRefreshMcp={() => void mcpIntegration.refreshStatus()}
        onTestMcp={() => void mcpIntegration.testConnection()}
        onCopyMcpConfig={(config) => void copyMcpConfig(config)}
        onRemoveMcp={() => void mcpIntegration.remove()}
      />
    );
  } else {
    content = (
      <ServiceControlView
        services={serviceState.services}
        groups={serviceState.groups}
        selectedName={serviceState.selectedName}
        selectedService={serviceState.selectedService}
        logs={serviceState.selectedLogs}
        logRevision={serviceState.logRevision}
        busyServices={serviceState.busyServices}
        busyGroups={serviceState.busyGroups}
        theme={resolvedTheme}
        active
        onSelect={serviceState.selectService}
        onAction={(name, action) => void handleServiceAction(name, action)}
        onAddService={() => openForm("create")}
        onCreateGroup={() => {
          setGroupName("");
          setGroupError("");
          setGroupDialogOpen(true);
        }}
        onDeleteGroup={setDeleteGroupTarget}
        onMoveService={(service, group) => void moveServiceToGroup(service, group)}
        onGroupAction={(group, action) => void runGroupAction(group, action)}
        onClearLogs={() => {
          serviceState.clearVisibleLogs();
          notify("当前视图已清空", "服务端日志文件不会被删除", "info");
        }}
      />
    );
  }

  return (
    <MotionConfig reducedMotion="user">
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
          onToggleTheme={toggleTheme}
        />

        <div className="service-console-body" data-view={activeView}>
          <SidebarNav
            activeView={activeView}
            updateAvailable={updateAvailable}
            onViewChange={changeView}
          />
          <motion.div
            key={activeView}
            className="service-console-stage"
            initial={{ opacity: 0, y: 5, filter: "blur(3px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            {content}
          </motion.div>
        </div>

        {formOpen ? (
          <ServiceFormDialog
            open
            mode={formMode}
            sourceService={formSource}
            sourceProcess={formProcessSource}
            existingNames={existingNames}
            groups={serviceState.groups}
            submitting={formSubmitting}
            api={serviceState.api}
            onOpenChange={changeFormOpen}
            onSubmit={submitServiceForm}
          />
        ) : null}

        <Dialog open={groupDialogOpen} onOpenChange={(open) => !groupSubmitting && setGroupDialogOpen(open)}>
          <DialogContent className="max-w-sm">
            <form onSubmit={(event) => { event.preventDefault(); void createGroup(); }}>
              <DialogHeader>
                <DialogTitle>新建服务分组</DialogTitle>
                <DialogDescription>创建后，将服务卡片拖拽到分组中即可归类。</DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <Input autoFocus value={groupName} maxLength={80} placeholder="例如：后端服务" aria-label="分组名称" onChange={(event) => { setGroupName(event.target.value); setGroupError(""); }} />
                {groupError ? <p className="mt-2 text-xs text-destructive" role="alert">{groupError}</p> : null}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={groupSubmitting} onClick={() => setGroupDialogOpen(false)}>取消</Button>
                <Button type="submit" disabled={groupSubmitting}>{groupSubmitting ? "创建中…" : "创建分组"}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

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

        <AlertDialog open={Boolean(deleteGroupTarget)} onOpenChange={(open) => !open && setDeleteGroupTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除分组“{deleteGroupTarget}”</AlertDialogTitle>
              <AlertDialogDescription>
                组内服务会移至“未分组”，正在运行的进程不会停止。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void confirmDeleteGroup()}>删除分组</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </MotionConfig>
  );
}

export function ServiceConsole() {
  return (
    <ToastProvider>
      <ServiceConsoleContent />
    </ToastProvider>
  );
}
