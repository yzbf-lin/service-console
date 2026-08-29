"use client";

import {
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  Copy,
  Ellipsis,
  ExternalLink,
  FileText,
  FlaskConical,
  Folder,
  History,
  ListTree,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Square,
  Trash2,
  Workflow,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { JenkinsInstanceDialog, type JenkinsInstanceDialogMode } from "@/components/jenkins-instance-dialog";
import { XtermLogViewer } from "@/components/xterm-log-viewer";
import { cn } from "@/lib/cn";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import { resolveJenkinsBuildUrl } from "@/lib/jenkins";
import type {
  JenkinsBuild,
  JenkinsBuildParameterValue,
  JenkinsInstance,
  JenkinsInstanceInput,
  JenkinsJob,
  JenkinsJobParameter,
  JenkinsQueueItem,
  ResolvedTheme,
} from "@/lib/types";

const ACTIVE_INSTANCE_KEY = "service-console.jenkins.active-instance";
const LOG_POLL_INTERVAL = 1_200;
const LOG_RETRY_MAX_INTERVAL = 15_000;
const LOG_MAX_CHARS = 2_000_000;
const LOG_TRUNCATION_NOTICE = "\r\n[Service Console 已省略较早的 Jenkins 日志]\r\n";

type ConnectionStatus = "unknown" | "checking" | "ok" | "error";
type ActivityTab = "builds" | "queue";
type MobilePane = "jobs" | "activity" | "logs";

interface JenkinsViewProps {
  active: boolean;
  api: ServiceConsoleApiClient;
  refreshSignal: number;
  theme: ResolvedTheme;
  onError: (title: string, message: string) => void;
  onSuccess: (title: string, message: string) => void;
}

interface ConnectionViewState {
  status: ConnectionStatus;
  detail: string;
}

interface DialogState {
  mode: JenkinsInstanceDialogMode;
  source: JenkinsInstance | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl || "地址未配置";
  }
}

function isFolder(job: JenkinsJob): boolean {
  return /folder/i.test(job.kind);
}

function resultVariant(status: string): "success" | "warning" | "destructive" | "muted" {
  const value = status.toUpperCase();
  if (["SUCCESS", "STABLE"].includes(value)) return "success";
  if (["RUNNING", "BUILDING", "QUEUED", "UNSTABLE"].includes(value)) return "warning";
  if (["FAILURE", "FAILED", "ABORTED", "ERROR"].includes(value)) return "destructive";
  return "muted";
}

function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) return "时间未知";
  const value = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatDuration(milliseconds: number): string {
  if (!milliseconds) return "—";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function useNarrowJenkinsLayout(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 980px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

function connectionCopy(state: ConnectionViewState | undefined): string {
  if (!state || state.status === "unknown") return "未检测";
  if (state.status === "checking") return "检测中";
  if (state.status === "ok") return state.detail || "已连接";
  return state.detail || "连接异常";
}

function parameterOptionsState(parameter: JenkinsJobParameter): JenkinsJobParameter["optionsState"] {
  return parameter.optionsState ?? (parameter.choices.length ? "ready" : "not_loaded");
}

function isEditableParameter(parameter: JenkinsJobParameter): boolean {
  return parameter.type !== "hidden" && parameter.type !== "separator";
}

function isReactiveParameter(parameter: JenkinsJobParameter): boolean {
  const rawType = (parameter.rawType ?? "").toLowerCase();
  return rawType.includes("cascadechoiceparameter") || rawType.includes("dynamicreferenceparameter");
}

function unsupportedParameterMessage(parameters: JenkinsJobParameter[]): string {
  const files = parameters.filter((parameter) => parameter.type === "file").map((parameter) => parameter.name);
  const unsupported = parameters.filter((parameter) => parameter.type === "unsupported");
  const reactive = unsupported.filter(isReactiveParameter).map((parameter) => parameter.name);
  const other = unsupported.filter((parameter) => !isReactiveParameter(parameter)).map((parameter) => parameter.name);
  return [
    files.length ? `文件上传参数 ${files.join("、")} 暂不支持` : "",
    reactive.length ? `级联或响应式参数 ${reactive.join("、")} 暂不支持` : "",
    other.length ? `参数 ${other.join("、")} 的类型暂不支持` : "",
  ].filter(Boolean).join("；");
}

function ParameterMultiSelect({
  choices,
  name,
  onValueChange,
  value,
}: {
  choices: string[];
  name: string;
  onValueChange: (value: string[]) => void;
  value: string[];
}) {
  const selected = new Set(value);
  const summary = value.length === 0
    ? "请选择"
    : value.length === 1
      ? value[0] || "（空值）"
      : `已选择 ${value.length} 项`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="h-8 w-full justify-between px-2 text-xs font-normal"
          variant="outline"
          size="sm"
          aria-label={`参数 ${name}，${summary}`}
        >
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>{summary}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
      >
        {choices.map((choice, index) => (
          <DropdownMenuCheckboxItem
            key={`${choice}-${index}`}
            checked={selected.has(choice)}
            onCheckedChange={(checked) => onValueChange(
              checked ? [...value, choice] : value.filter((item) => item !== choice),
            )}
            onSelect={(event) => event.preventDefault()}
          >
            {choice || "（空值）"}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function choiceUnavailableMessage(parameter: JenkinsJobParameter): string {
  if (parameterOptionsState(parameter) === "not_loaded") return "候选项尚未加载，请关闭后重试。";
  if (parameterOptionsState(parameter) === "unavailable") return "未能读取候选项，请在 Jenkins 页面运行。";
  return "没有可用候选项，请在 Jenkins 页面运行。";
}

function ParameterChoiceSelect({
  choices,
  name,
  onValueChange,
  value,
}: {
  choices: string[];
  name: string;
  onValueChange: (value: string) => void;
  value: string;
}) {
  const selectedIndex = choices.indexOf(value);
  return (
    <Select
      value={selectedIndex >= 0 ? String(selectedIndex) : undefined}
      onValueChange={(token) => {
        const selected = choices[Number(token)];
        if (selected !== undefined) onValueChange(selected);
      }}
    >
      <SelectTrigger className="h-8 text-xs" aria-label={`参数 ${name}`}>
        <SelectValue placeholder="请选择" />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice, index) => (
          <SelectItem key={`${choice}-${index}`} value={String(index)}>{choice || "（空值）"}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function JenkinsView({ active, api, refreshSignal, theme, onError, onSuccess }: JenkinsViewProps) {
  const [instances, setInstances] = useState<JenkinsInstance[]>([]);
  const [instancesLoaded, setInstancesLoaded] = useState(false);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [activeInstanceId, setActiveInstanceId] = useState(() => (
    typeof window === "undefined" ? "" : window.localStorage.getItem(ACTIVE_INSTANCE_KEY) ?? ""
  ));
  const [connections, setConnections] = useState<Record<string, ConnectionViewState>>({});
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogSubmitting, setDialogSubmitting] = useState(false);
  const [testingInstanceId, setTestingInstanceId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JenkinsInstance | null>(null);

  const [folder, setFolder] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [jobs, setJobs] = useState<JenkinsJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [selectedJobName, setSelectedJobName] = useState("");
  const [jobDetail, setJobDetail] = useState<JenkinsJob | null>(null);
  const [triggerJob, setTriggerJob] = useState<JenkinsJob | null>(null);
  const [builds, setBuilds] = useState<JenkinsBuild[]>([]);
  const [buildsLoading, setBuildsLoading] = useState(false);
  const [selectedBuildNumber, setSelectedBuildNumber] = useState<number | null>(null);
  const [selectedBuild, setSelectedBuild] = useState<JenkinsBuild | null>(null);
  const [queue, setQueue] = useState<JenkinsQueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [activityTab, setActivityTab] = useState<ActivityTab>("builds");
  const [operationRevision, setOperationRevision] = useState(0);
  const [busyAction, setBusyAction] = useState("");
  const [preparingBuild, setPreparingBuild] = useState(false);

  const [triggerOpen, setTriggerOpen] = useState(false);
  const [parameterValues, setParameterValues] = useState<Record<string, string | boolean | string[]>>({});
  const [stopTarget, setStopTarget] = useState<JenkinsBuild | null>(null);
  const [cancelTarget, setCancelTarget] = useState<JenkinsQueueItem | null>(null);

  const [logText, setLogText] = useState("");
  const [logAppend, setLogAppend] = useState({ revision: 0, text: "" });
  const [logLoading, setLogLoading] = useState(false);
  const [logComplete, setLogComplete] = useState(false);
  const [logError, setLogError] = useState("");
  const [logTruncated, setLogTruncated] = useState(false);

  const narrow = useNarrowJenkinsLayout();
  const [mobilePane, setMobilePane] = useState<MobilePane>("jobs");
  const activeInstanceIdRef = useRef(activeInstanceId);
  const selectedJobNameRef = useRef(selectedJobName);
  const instancesRequestRef = useRef(0);
  const jobsRequestRef = useRef(0);
  const jobRequestRef = useRef(0);
  const buildRequestRef = useRef(0);
  const queueRequestRef = useRef(0);
  const prepareRequestRef = useRef(0);
  const pollingErrorsRef = useRef(new Set<string>());

  const activeInstance = useMemo(
    () => instances.find((instance) => instance.id === activeInstanceId) ?? null,
    [activeInstanceId, instances],
  );
  const editableJobParameters = useMemo(
    () => jobDetail?.parameters.filter(isEditableParameter) ?? [],
    [jobDetail],
  );
  const unsupportedJobMessage = useMemo(
    () => unsupportedParameterMessage(jobDetail?.parameters ?? []),
    [jobDetail],
  );
  const editableTriggerParameters = useMemo(
    () => triggerJob?.parameters.filter(isEditableParameter) ?? [],
    [triggerJob],
  );
  const triggerUnsupportedMessage = useMemo(
    () => unsupportedParameterMessage(triggerJob?.parameters ?? []),
    [triggerJob],
  );
  const triggerInvalidChoiceParameters = useMemo(
    () => triggerJob?.parameters.filter((parameter) => (
      parameter.type === "choice"
      && (parameterOptionsState(parameter) !== "ready" || parameter.choices.length === 0)
    )) ?? [],
    [triggerJob],
  );
  const triggerMissingPasswordParameters = useMemo(
    () => triggerJob?.requiresExplicitPassword
      ? triggerJob.parameters.filter((parameter) => (
        parameter.type === "password" && String(parameterValues[parameter.name] ?? "") === ""
      ))
      : [],
    [parameterValues, triggerJob],
  );
  const selectedBuildUrl = useMemo(
    () => activeInstance && selectedBuild
      ? resolveJenkinsBuildUrl(activeInstance.baseUrl, selectedBuild.url)
      : null,
    [activeInstance, selectedBuild],
  );

  const reportPollingError = useCallback((key: string, title: string, error: unknown) => {
    if (pollingErrorsRef.current.has(key)) return;
    pollingErrorsRef.current.add(key);
    onError(title, errorText(error));
  }, [onError]);

  const recoverPollingError = useCallback((key: string) => {
    pollingErrorsRef.current.delete(key);
  }, []);

  const invalidateWorkspace = useCallback(() => {
    jobsRequestRef.current += 1;
    jobRequestRef.current += 1;
    buildRequestRef.current += 1;
    queueRequestRef.current += 1;
  }, []);

  const clearWorkspace = useCallback(() => {
    invalidateWorkspace();
    selectedJobNameRef.current = "";
    setFolder("");
    setQueryInput("");
    setQuery("");
    setJobs([]);
    setSelectedJobName("");
    setJobDetail(null);
    prepareRequestRef.current += 1;
    setPreparingBuild(false);
    setTriggerJob(null);
    setTriggerOpen(false);
    setBuilds([]);
    setSelectedBuildNumber(null);
    setSelectedBuild(null);
    setQueue([]);
    setLogText("");
    setLogError("");
    setMobilePane("jobs");
    pollingErrorsRef.current.clear();
  }, [invalidateWorkspace]);

  const chooseInstance = useCallback((id: string) => {
    if (id === activeInstanceIdRef.current) return;
    clearWorkspace();
    activeInstanceIdRef.current = id;
    setActiveInstanceId(id);
    if (id) window.localStorage.setItem(ACTIVE_INSTANCE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_INSTANCE_KEY);
  }, [clearWorkspace]);

  const loadInstances = useCallback(async (preferredId?: string) => {
    const requestId = ++instancesRequestRef.current;
    setInstancesLoading(true);
    try {
      const next = await api.listJenkinsInstances();
      if (requestId !== instancesRequestRef.current) return;
      setInstances(next);
      setInstancesLoaded(true);
      const requested = preferredId || activeInstanceIdRef.current;
      const selected = next.find((instance) => instance.id === requested)
        ?? next.find((instance) => instance.enabled)
        ?? next[0]
        ?? null;
      if ((selected?.id ?? "") !== activeInstanceIdRef.current) chooseInstance(selected?.id ?? "");
      else if (selected && !selected.enabled) clearWorkspace();
    } catch (error) {
      if (requestId === instancesRequestRef.current) {
        setInstancesLoaded(true);
        onError("读取 Jenkins 实例失败", errorText(error));
      }
    } finally {
      if (requestId === instancesRequestRef.current) setInstancesLoading(false);
    }
  }, [api, chooseInstance, clearWorkspace, onError]);

  useEffect(() => {
    if (active) void loadInstances();
  }, [active, loadInstances, refreshSignal]);

  useEffect(() => () => {
    instancesRequestRef.current += 1;
    invalidateWorkspace();
  }, [invalidateWorkspace]);

  useEffect(() => {
    if (active) return;
    instancesRequestRef.current += 1;
    invalidateWorkspace();
    prepareRequestRef.current += 1;
    setPreparingBuild(false);
    setTriggerJob(null);
    setTriggerOpen(false);
  }, [active, invalidateWorkspace]);

  useEffect(() => {
    activeInstanceIdRef.current = activeInstanceId;
    if (activeInstanceId) window.localStorage.setItem(ACTIVE_INSTANCE_KEY, activeInstanceId);
  }, [activeInstanceId]);

  useEffect(() => {
    selectedJobNameRef.current = selectedJobName;
  }, [selectedJobName]);

  useEffect(() => {
    const instance = activeInstance;
    if (!active || !instance?.enabled) return;
    const instanceId = instance.id;
    const errorKey = `jobs:${instanceId}:${folder}:${query}`;
    const requestId = ++jobsRequestRef.current;
    setJobsLoading(true);
    void api.listJenkinsJobs(instanceId, folder, query).then((nextJobs) => {
      if (requestId !== jobsRequestRef.current || activeInstanceIdRef.current !== instanceId) return;
      setJobs(nextJobs);
      recoverPollingError(errorKey);
      setConnections((current) => ({ ...current, [instanceId]: { status: "ok", detail: "已连接" } }));
      const selectable = nextJobs.filter((job) => !isFolder(job));
      const currentStillVisible = selectable.some((job) => job.fullName === selectedJobNameRef.current);
      if (!currentStillVisible) {
        const nextName = selectable[0]?.fullName ?? "";
        setJobDetail(null);
        setBuilds([]);
        setSelectedBuildNumber(null);
        setSelectedBuild(null);
        selectedJobNameRef.current = nextName;
        setSelectedJobName(nextName);
      }
    }).catch((error: unknown) => {
      if (requestId !== jobsRequestRef.current || activeInstanceIdRef.current !== instanceId) return;
      setConnections((current) => ({ ...current, [instanceId]: { status: "error", detail: errorText(error) } }));
      reportPollingError(errorKey, "读取 Jenkins 任务失败", error);
    }).finally(() => {
      if (requestId === jobsRequestRef.current) setJobsLoading(false);
    });
  }, [active, activeInstance, api, folder, operationRevision, query, recoverPollingError, refreshSignal, reportPollingError]);

  useEffect(() => {
    const instanceId = activeInstance?.id;
    if (!active || !instanceId || !activeInstance.enabled) return;
    const errorKey = `queue:${instanceId}`;
    const requestId = ++queueRequestRef.current;
    setQueueLoading(true);
    void api.listJenkinsQueue(instanceId).then((items) => {
      if (requestId === queueRequestRef.current && activeInstanceIdRef.current === instanceId) {
        setQueue(items);
        recoverPollingError(errorKey);
      }
    }).catch((error: unknown) => {
      if (requestId === queueRequestRef.current && activeInstanceIdRef.current === instanceId) {
        reportPollingError(errorKey, "读取 Jenkins 队列失败", error);
      }
    }).finally(() => {
      if (requestId === queueRequestRef.current) setQueueLoading(false);
    });
  }, [active, activeInstance, api, operationRevision, recoverPollingError, refreshSignal, reportPollingError]);

  useEffect(() => {
    const instanceId = activeInstance?.id;
    const jobName = selectedJobName;
    if (!active || !instanceId || !jobName) {
      setJobDetail(null);
      setTriggerJob(null);
      setTriggerOpen(false);
      setBuilds([]);
      setSelectedBuildNumber(null);
      return;
    }
    const requestId = ++jobRequestRef.current;
    const errorKey = `job:${instanceId}:${jobName}`;
    setBuildsLoading(true);
    void Promise.all([
      api.getJenkinsJob(instanceId, jobName),
      api.listJenkinsBuilds(instanceId, jobName, 30),
    ]).then(([detail, nextBuilds]) => {
      if (
        requestId !== jobRequestRef.current
        || activeInstanceIdRef.current !== instanceId
        || selectedJobNameRef.current !== jobName
      ) return;
      setJobDetail(detail);
      setBuilds(nextBuilds);
      recoverPollingError(errorKey);
      setSelectedBuildNumber((current) => (
        current !== null && nextBuilds.some((build) => build.number === current)
          ? current
          : nextBuilds[0]?.number ?? null
      ));
    }).catch((error: unknown) => {
      if (
        requestId === jobRequestRef.current
        && activeInstanceIdRef.current === instanceId
        && selectedJobNameRef.current === jobName
      ) {
        reportPollingError(errorKey, "读取 Jenkins 构建失败", error);
      }
    }).finally(() => {
      if (requestId === jobRequestRef.current) setBuildsLoading(false);
    });
  }, [active, activeInstance?.id, api, operationRevision, recoverPollingError, refreshSignal, reportPollingError, selectedJobName]);

  useEffect(() => {
    const instanceId = activeInstance?.id;
    const jobName = selectedJobName;
    const buildNumber = selectedBuildNumber;
    if (!active || !instanceId || !jobName || buildNumber === null) {
      setSelectedBuild(null);
      return;
    }
    const requestId = ++buildRequestRef.current;
    const errorKey = `build:${instanceId}:${jobName}:${buildNumber}`;
    void api.getJenkinsBuild(instanceId, jobName, buildNumber).then((build) => {
      if (
        requestId === buildRequestRef.current
        && activeInstanceIdRef.current === instanceId
        && selectedJobNameRef.current === jobName
      ) {
        setSelectedBuild(build);
        recoverPollingError(errorKey);
      }
    }).catch((error: unknown) => {
      if (requestId === buildRequestRef.current) reportPollingError(errorKey, "读取构建详情失败", error);
    });
  }, [active, activeInstance?.id, api, operationRevision, recoverPollingError, refreshSignal, reportPollingError, selectedBuildNumber, selectedJobName]);

  useEffect(() => {
    if (!active || (!builds.some((build) => build.building) && !queue.length)) return;
    const timer = window.setInterval(() => setOperationRevision((value) => value + 1), 4_000);
    return () => window.clearInterval(timer);
  }, [active, builds, queue.length]);

  useEffect(() => {
    const instanceId = activeInstance?.id;
    const jobName = selectedJobName;
    const buildNumber = selectedBuildNumber;
    setLogText("");
    setLogError("");
    setLogComplete(false);
    setLogTruncated(false);
    if (!active || !instanceId || !jobName || buildNumber === null) {
      setLogLoading(false);
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    let offset = 0;
    let accumulated = "";
    let failureCount = 0;
    const poll = async () => {
      setLogLoading(true);
      try {
        const chunk = await api.getJenkinsBuildLog(instanceId, jobName, buildNumber, offset);
        if (cancelled) return;
        failureCount = 0;
        accumulated = offset === 0 ? chunk.text : accumulated + chunk.text;
        if (accumulated.length > LOG_MAX_CHARS) {
          setLogTruncated(true);
          accumulated = LOG_TRUNCATION_NOTICE + accumulated.slice(-LOG_MAX_CHARS);
        }
        setLogText(accumulated);
        setLogAppend((current) => ({ revision: current.revision + 1, text: chunk.text }));
        offset = chunk.nextOffset;
        setLogComplete(chunk.complete);
        setLogError("");
        if (!chunk.complete || chunk.more) timer = window.setTimeout(() => void poll(), LOG_POLL_INTERVAL);
        else setOperationRevision((value) => value + 1);
      } catch (error) {
        if (!cancelled) {
          failureCount += 1;
          setLogError(errorText(error));
          const retryDelay = Math.min(
            LOG_POLL_INTERVAL * (2 ** Math.min(failureCount - 1, 4)),
            LOG_RETRY_MAX_INTERVAL,
          );
          timer = window.setTimeout(() => void poll(), retryDelay);
        }
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, activeInstance?.id, api, refreshSignal, selectedBuildNumber, selectedJobName]);

  const testInstance = useCallback(async (instance: JenkinsInstance) => {
    setTestingInstanceId(instance.id);
    setConnections((current) => ({ ...current, [instance.id]: { status: "checking", detail: "正在检测" } }));
    try {
      const connection = await api.testJenkinsInstance(instance.id);
      const detail = connection.version ? `Jenkins ${connection.version}` : "连接正常";
      setConnections((current) => ({ ...current, [instance.id]: { status: "ok", detail } }));
      onSuccess("Jenkins 连接正常", `${instance.name} · ${detail}`);
    } catch (error) {
      setConnections((current) => ({ ...current, [instance.id]: { status: "error", detail: errorText(error) } }));
      onError("Jenkins 连接失败", errorText(error));
    } finally {
      setTestingInstanceId(null);
    }
  }, [api, onError, onSuccess]);

  const submitInstance = useCallback(async (input: JenkinsInstanceInput) => {
    if (!dialog) return;
    setDialogSubmitting(true);
    try {
      const saved = dialog.mode === "edit" && dialog.source
        ? await api.updateJenkinsInstance(dialog.source.id, input)
        : await api.createJenkinsInstance(input);
      if (dialog.mode === "edit" && dialog.source?.id === activeInstanceIdRef.current) clearWorkspace();
      setDialog(null);
      onSuccess(dialog.mode === "edit" ? "Jenkins 配置已保存" : dialog.mode === "copy" ? "Jenkins 副本已创建" : "Jenkins 已添加", saved.name);
      await loadInstances(saved.id);
    } catch (error) {
      onError(dialog.mode === "edit" ? "保存 Jenkins 失败" : "添加 Jenkins 失败", errorText(error));
    } finally {
      setDialogSubmitting(false);
    }
  }, [api, clearWorkspace, dialog, loadInstances, onError, onSuccess]);

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    setBusyAction(`delete:${target.id}`);
    try {
      await api.deleteJenkinsInstance(target.id);
      onSuccess("Jenkins 实例已删除", target.name);
      await loadInstances();
    } catch (error) {
      onError("删除 Jenkins 失败", errorText(error));
    } finally {
      setBusyAction("");
    }
  }, [api, deleteTarget, loadInstances, onError, onSuccess]);

  const selectJob = useCallback((job: JenkinsJob) => {
    if (isFolder(job)) {
      jobsRequestRef.current += 1;
      prepareRequestRef.current += 1;
      setPreparingBuild(false);
      setTriggerJob(null);
      setTriggerOpen(false);
      setFolder(job.fullName);
      setSelectedJobName("");
      selectedJobNameRef.current = "";
      return;
    }
    if (job.fullName !== selectedJobNameRef.current) {
      jobRequestRef.current += 1;
      buildRequestRef.current += 1;
      prepareRequestRef.current += 1;
      setPreparingBuild(false);
      setTriggerJob(null);
      setTriggerOpen(false);
      setJobDetail(null);
      setBuilds([]);
      setSelectedBuildNumber(null);
      setSelectedBuild(null);
      setLogText("");
      setLogError("");
    }
    selectedJobNameRef.current = job.fullName;
    setSelectedJobName(job.fullName);
    setMobilePane("activity");
  }, []);

  const prepareBuild = useCallback(async () => {
    const instanceId = activeInstance?.id;
    const job = jobDetail;
    if (!instanceId || !job?.buildable || unsupportedParameterMessage(job.parameters)) return;
    const requestId = ++prepareRequestRef.current;
    setPreparingBuild(true);
    try {
      const prepared = await api.getJenkinsJob(instanceId, job.fullName, true);
      if (
        requestId !== prepareRequestRef.current
        || activeInstanceIdRef.current !== instanceId
        || selectedJobNameRef.current !== job.fullName
      ) return;
      const fileParameter = prepared.parameters.find((parameter) => parameter.type === "file");
      if (fileParameter) {
        onError("暂不支持文件参数", `任务包含文件参数 ${fileParameter.name}，请在 Jenkins 页面运行`);
        return;
      }
      const initial: Record<string, string | boolean | string[]> = {};
      prepared.parameters.forEach((parameter) => {
        if (!isEditableParameter(parameter) || parameter.type === "file") return;
        if (
          parameter.type === "choice"
          && (parameterOptionsState(parameter) !== "ready" || parameter.choices.length === 0)
        ) return;
        if (typeof parameter.defaultValue === "boolean") {
          initial[parameter.name] = parameter.defaultValue;
          return;
        }
        if (parameter.multiple) {
          const defaults = Array.isArray(parameter.defaultValue)
            ? parameter.defaultValue
            : typeof parameter.defaultValue === "string"
              ? [parameter.defaultValue]
              : [];
          initial[parameter.name] = defaults.filter((value) => parameter.choices.includes(value));
          return;
        }
        const defaultValue = parameter.defaultValue === null ? "" : String(parameter.defaultValue);
        initial[parameter.name] = parameter.choices.length
          ? (parameter.choices.includes(defaultValue) ? defaultValue : parameter.choices[0] ?? "")
          : defaultValue;
      });
      setTriggerJob(prepared);
      setParameterValues(initial);
      setTriggerOpen(true);
    } catch (error) {
      if (
        requestId === prepareRequestRef.current
        && activeInstanceIdRef.current === instanceId
        && selectedJobNameRef.current === job.fullName
      ) onError("读取 Jenkins 构建参数失败", errorText(error));
    } finally {
      if (requestId === prepareRequestRef.current) setPreparingBuild(false);
    }
  }, [activeInstance?.id, api, jobDetail, onError]);

  const confirmBuild = useCallback(async () => {
    const instanceId = activeInstance?.id;
    const job = triggerJob;
    if (!instanceId || !job) return;
    const parameters: Record<string, JenkinsBuildParameterValue> = {};
    let invalidNumericParameter = "";
    let invalidChoiceParameter = "";
    let missingPasswordParameter = "";
    let unsupportedFileParameter = "";
    let unsupportedParameter = "";
    job.parameters.forEach((parameter) => {
      const value = parameterValues[parameter.name] ?? "";
      if (!isEditableParameter(parameter)) {
        return;
      } else if (parameter.type === "file") {
        unsupportedFileParameter = parameter.name;
      } else if (parameter.type === "unsupported") {
        unsupportedParameter = parameter.name;
      } else if (parameter.type === "choice") {
        const selected = parameter.multiple
          ? (Array.isArray(value) ? value : [])
          : String(value);
        if (
          parameterOptionsState(parameter) !== "ready"
          || !parameter.choices.length
          || (Array.isArray(selected)
            ? selected.some((item) => !parameter.choices.includes(item))
            : !parameter.choices.includes(selected))
        ) invalidChoiceParameter = parameter.name;
        else parameters[parameter.name] = selected;
      } else if (parameter.type === "password" && String(value) === "") {
        if (job.requiresExplicitPassword) missingPasswordParameter = parameter.name;
        // 普通参数任务不发送空密码，让 Jenkins 使用任务中保存的默认秘密。
      } else if (parameter.type === "number") {
        const raw = String(value).trim();
        const parsed = Number(raw);
        if (!raw || !Number.isFinite(parsed)) invalidNumericParameter = parameter.name;
        else parameters[parameter.name] = parsed;
      } else {
        parameters[parameter.name] = value;
      }
    });
    if (unsupportedFileParameter) {
      onError("暂不支持文件参数", `任务包含文件参数 ${unsupportedFileParameter}，请在 Jenkins 页面运行`);
      return;
    }
    if (unsupportedParameter) {
      onError("暂不支持该参数类型", `任务包含当前不支持的参数 ${unsupportedParameter}，请在 Jenkins 页面运行`);
      return;
    }
    if (invalidChoiceParameter) {
      onError("构建参数不可用", `参数 ${invalidChoiceParameter} 没有可提交的候选项`);
      return;
    }
    if (missingPasswordParameter) {
      onError("构建参数不完整", `动态参数任务需要填写密码参数 ${missingPasswordParameter}`);
      return;
    }
    if (invalidNumericParameter) {
      onError("构建参数不完整", `参数 ${invalidNumericParameter} 需要填写有效数字`);
      return;
    }
    setBusyAction("trigger");
    try {
      const queued = await api.triggerJenkinsBuild(instanceId, job.fullName, parameters);
      setTriggerOpen(false);
      setTriggerJob(null);
      setActivityTab("queue");
      setMobilePane("activity");
      onSuccess("Jenkins 构建已提交", queued.id === null ? job.fullName : `${job.fullName} · 队列 #${queued.id}`);
      setOperationRevision((value) => value + 1);
    } catch (error) {
      onError("触发 Jenkins 构建失败", errorText(error));
    } finally {
      setBusyAction("");
    }
  }, [activeInstance?.id, api, onError, onSuccess, parameterValues, triggerJob]);

  const confirmStop = useCallback(async () => {
    const instanceId = activeInstance?.id;
    const jobName = selectedJobName;
    const build = stopTarget;
    setStopTarget(null);
    if (!instanceId || !jobName || !build) return;
    setBusyAction(`stop:${build.number}`);
    try {
      await api.stopJenkinsBuild(instanceId, jobName, build.number);
      onSuccess("停止请求已提交", `${jobName} #${build.number}`);
      setOperationRevision((value) => value + 1);
    } catch (error) {
      onError("停止 Jenkins 构建失败", errorText(error));
    } finally {
      setBusyAction("");
    }
  }, [activeInstance?.id, api, onError, onSuccess, selectedJobName, stopTarget]);

  const confirmCancelQueue = useCallback(async () => {
    const instanceId = activeInstance?.id;
    const item = cancelTarget;
    setCancelTarget(null);
    if (!instanceId || !item) return;
    setBusyAction(`cancel:${item.id}`);
    try {
      await api.cancelJenkinsQueueItem(instanceId, item.id);
      onSuccess("排队任务已取消", `${item.taskFullName || item.taskName} · #${item.id}`);
      setOperationRevision((value) => value + 1);
    } catch (error) {
      onError("取消 Jenkins 队列失败", errorText(error));
    } finally {
      setBusyAction("");
    }
  }, [activeInstance?.id, api, cancelTarget, onError, onSuccess]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    jobsRequestRef.current += 1;
    setQuery(queryInput.trim());
  };

  const jobsPanel = (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r bg-[var(--sidebar)]" aria-label="Jenkins 实例与任务">
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Server className="size-3.5 shrink-0 text-primary" />
          <h2 className="truncate text-[11px] font-semibold">Jenkins 实例</h2>
          <Badge className="h-4 px-1 text-[9px]" variant="secondary">{instances.length}</Badge>
        </div>
        <div className="flex items-center gap-0.5">
          <Button className="size-6 p-0" variant="ghost" size="icon-sm" aria-label="刷新 Jenkins 实例" disabled={instancesLoading} onClick={() => void loadInstances()}>
            <RefreshCw className={cn("size-3", instancesLoading && "animate-spin")} />
          </Button>
          <Button className="size-6 p-0" variant="ghost" size="icon-sm" aria-label="添加 Jenkins 实例" onClick={() => setDialog({ mode: "create", source: null })}><Plus className="size-3" /></Button>
        </div>
      </header>

      <div className="no-visible-scrollbar max-h-[35%] shrink-0 overflow-auto border-b p-1.5" role="list" aria-label="Jenkins 实例列表">
        {instances.map((instance) => {
          const selected = instance.id === activeInstanceId;
          const connection = connections[instance.id] ?? (instance.credentialError
            ? { status: "error" as const, detail: instance.credentialError }
            : undefined);
          return (
            <div key={instance.id} className={cn("group mb-1 flex items-center rounded-lg border border-transparent", selected && "border-primary/25 bg-primary/8")} role="listitem">
              <button className="min-w-0 flex-1 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/80" type="button" aria-current={selected ? "true" : undefined} onClick={() => chooseInstance(instance.id)}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cn("size-1.5 shrink-0 rounded-full bg-muted-foreground", connection?.status === "ok" && "bg-success", connection?.status === "error" && "bg-destructive", connection?.status === "checking" && "animate-pulse bg-warning")} />
                  <span className="truncate text-[11px] font-semibold">{instance.name}</span>
                  {!instance.enabled ? <Badge className="h-4 px-1 text-[8px]" variant="muted">停用</Badge> : null}
                </span>
                <span className="mt-0.5 block truncate pl-3 font-mono text-[9px] text-muted-foreground">{hostLabel(instance.baseUrl)}</span>
                <span className="mt-0.5 block truncate pl-3 text-[9px] text-muted-foreground" title={connectionCopy(connection)}>{connectionCopy(connection)}</span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className="mr-1 size-6 p-0 opacity-70 group-hover:opacity-100" variant="ghost" size="icon-sm" aria-label={`${instance.name} 操作`}><Ellipsis className="size-3.5" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={testingInstanceId !== null} onSelect={() => void testInstance(instance)}><FlaskConical className="size-3.5" />测试连接</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog({ mode: "edit", source: instance })}><Pencil className="size-3.5" />编辑</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDialog({ mode: "copy", source: instance })}><Copy className="size-3.5" />复制</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteTarget(instance)}><Trash2 className="size-3.5" />删除</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
        {instancesLoaded && !instances.length ? (
          <button className="grid w-full place-items-center rounded-lg border border-dashed px-3 py-5 text-center text-[10px] text-muted-foreground hover:bg-accent/40" type="button" onClick={() => setDialog({ mode: "create", source: null })}>
            <Plus className="mb-1 size-4" /><span>添加第一个 Jenkins 实例</span>
          </button>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-2">
          {folder ? <Button className="size-6 p-0" variant="ghost" size="icon-sm" aria-label="返回上级 Folder" onClick={() => setFolder(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "")}><ChevronLeft className="size-3.5" /></Button> : null}
          <form className="relative min-w-0 flex-1" role="search" onSubmit={submitSearch}>
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-6 pl-6 pr-2 text-[10px]" value={queryInput} aria-label="搜索 Jenkins 任务" placeholder={folder || "搜索 Job / Folder"} onChange={(event) => setQueryInput(event.target.value)} />
          </form>
        </div>
        <div className="no-visible-scrollbar min-h-0 flex-1 overflow-auto p-1.5" role="list" aria-label="Jenkins 任务列表" aria-busy={jobsLoading}>
          {jobs.map((job) => {
            const folderItem = isFolder(job);
            const selected = !folderItem && selectedJobName === job.fullName;
            return (
              <button key={job.fullName} className={cn("mb-0.5 flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/80", selected && "bg-accent text-accent-foreground")} type="button" role="listitem" onClick={() => selectJob(job)}>
                {folderItem ? <Folder className="size-3.5 shrink-0 text-warning" /> : <Workflow className="size-3.5 shrink-0 text-primary" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] font-medium">{job.name}</span>
                  {!folderItem ? <span className="block truncate text-[8px] text-muted-foreground">{job.status}{job.inQueue ? " · 排队中" : ""}</span> : null}
                </span>
                {!folderItem && job.lastBuild ? <span className={cn("size-1.5 shrink-0 rounded-full bg-muted-foreground", resultVariant(job.lastBuild.status) === "success" && "bg-success", resultVariant(job.lastBuild.status) === "warning" && "bg-warning", resultVariant(job.lastBuild.status) === "destructive" && "bg-destructive")} /> : null}
              </button>
            );
          })}
          {jobsLoading ? <p className="flex items-center justify-center gap-2 py-6 text-[10px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />正在读取任务</p> : null}
          {!jobsLoading && activeInstance && !activeInstance.enabled ? <p className="px-3 py-6 text-center text-[10px] text-muted-foreground">该 Jenkins 实例已停用，请编辑配置后启用。</p> : null}
          {!jobsLoading && activeInstance?.enabled && !jobs.length ? <p className="px-3 py-6 text-center text-[10px] text-muted-foreground">当前范围没有任务</p> : null}
        </div>
      </div>
    </section>
  );

  const activityPanel = (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r bg-card" aria-label="Jenkins 构建与队列">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-[12px] font-semibold">{jobDetail?.fullName || selectedJobName || "选择一个任务"}</h2>
          <p className="mt-0.5 truncate text-[9px] text-muted-foreground">{jobDetail ? `${jobDetail.status} · ${editableJobParameters.length ? `${editableJobParameters.length} 个参数` : "无可填写参数"}` : "查看构建历史和队列"}</p>
        </div>
        <Button
          className="h-7 px-2 text-[10px]"
          size="sm"
          disabled={!jobDetail?.buildable || preparingBuild || Boolean(busyAction) || Boolean(unsupportedJobMessage)}
          title={unsupportedJobMessage || undefined}
          onClick={() => void prepareBuild()}
        >{preparingBuild ? <LoaderCircle className="size-3 animate-spin" /> : <Play className="size-3" />}运行</Button>
      </header>
      {unsupportedJobMessage ? (
        <div className="flex min-h-8 shrink-0 items-center gap-1.5 border-b border-warning/20 bg-warning/5 px-3 text-[9px] text-warning" role="note">
          <CircleAlert className="size-3 shrink-0" />
          {unsupportedJobMessage}，请在 Jenkins 页面运行该任务。
        </div>
      ) : null}
      <div className="flex h-9 shrink-0 items-end gap-1 border-b px-2" role="tablist" aria-label="Jenkins 活动">
        <button className={cn("h-8 border-b-2 border-transparent px-2 text-[10px] text-muted-foreground", activityTab === "builds" && "border-primary font-semibold text-foreground")} type="button" role="tab" aria-selected={activityTab === "builds"} onClick={() => setActivityTab("builds")}><History className="mr-1 inline size-3" />构建 {builds.length}</button>
        <button className={cn("h-8 border-b-2 border-transparent px-2 text-[10px] text-muted-foreground", activityTab === "queue" && "border-primary font-semibold text-foreground")} type="button" role="tab" aria-selected={activityTab === "queue"} onClick={() => setActivityTab("queue")}><ListTree className="mr-1 inline size-3" />队列 {queue.length}</button>
      </div>
      {activityTab === "builds" ? (
        <div className="no-visible-scrollbar min-h-0 flex-1 overflow-auto" role="tabpanel" aria-label="构建历史" aria-busy={buildsLoading}>
          {builds.map((build) => (
            <div key={build.number} className={cn("flex min-h-12 w-full items-center border-b hover:bg-accent/40", selectedBuildNumber === build.number && "bg-accent/60")}>
              <button className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/80" type="button" onClick={() => {
                if (build.number !== selectedBuildNumber) {
                  buildRequestRef.current += 1;
                  setSelectedBuild(null);
                }
                setSelectedBuildNumber(build.number);
                setMobilePane("logs");
              }}>
                <span className={cn("size-2 shrink-0 rounded-full bg-muted-foreground", resultVariant(build.status) === "success" && "bg-success", resultVariant(build.status) === "warning" && "animate-pulse bg-warning", resultVariant(build.status) === "destructive" && "bg-destructive")} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2"><strong className="text-[11px]">#{build.number}</strong><Badge className="h-4 px-1 text-[8px]" variant={resultVariant(build.status)}>{build.status}</Badge></span>
                  <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">{formatTimestamp(build.timestamp)} · {formatDuration(build.duration)}</span>
                </span>
              </button>
              {build.building ? <Button className="mr-2 size-6 p-0 text-destructive hover:text-destructive" variant="ghost" size="icon-sm" aria-label={`停止构建 #${build.number}`} disabled={Boolean(busyAction)} onClick={() => setStopTarget(build)}><Square className="size-3 fill-current" /></Button> : null}
            </div>
          ))}
          {buildsLoading ? <p className="flex items-center justify-center gap-2 py-8 text-[10px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />读取构建历史</p> : null}
          {!buildsLoading && selectedJobName && !builds.length ? <p className="px-3 py-8 text-center text-[10px] text-muted-foreground">暂无构建记录</p> : null}
        </div>
      ) : (
        <div className="no-visible-scrollbar min-h-0 flex-1 overflow-auto" role="tabpanel" aria-label="构建队列" aria-busy={queueLoading}>
          {queue.map((item) => (
            <div key={item.id} className="flex min-h-12 items-center gap-2 border-b px-3 py-1.5">
              <span className={cn("size-2 shrink-0 rounded-full bg-warning", item.stuck && "bg-destructive")} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10px] font-semibold">{item.taskFullName || item.taskName || `队列 #${item.id}`}</span>
                <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">#{item.id} · {item.why || (item.blocked ? "等待资源" : "等待执行")}</span>
              </span>
              {!item.executableNumber ? <Button className="h-6 px-1.5 text-[9px] text-destructive hover:text-destructive" variant="ghost" size="sm" disabled={Boolean(busyAction)} onClick={() => setCancelTarget(item)}>取消</Button> : null}
            </div>
          ))}
          {queueLoading ? <p className="flex items-center justify-center gap-2 py-8 text-[10px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />读取队列</p> : null}
          {!queueLoading && !queue.length ? <p className="px-3 py-8 text-center text-[10px] text-muted-foreground">队列为空</p> : null}
        </div>
      )}
    </section>
  );

  const logPanel = (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card" aria-label="Jenkins 构建详情与日志">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-[12px] font-semibold">{selectedBuild ? selectedBuild.fullDisplayName || `${selectedJobName} #${selectedBuild.number}` : "构建日志"}</h2>
          <p className="mt-0.5 truncate text-[9px] text-muted-foreground">{selectedBuild ? `${selectedBuild.status} · ${formatTimestamp(selectedBuild.timestamp)} · ${formatDuration(selectedBuild.duration)}` : "从构建历史选择一条记录"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {logTruncated ? <Badge className="h-4 px-1 text-[8px]" variant="warning">已截断</Badge> : null}
          {logLoading ? <LoaderCircle className="size-3 animate-spin text-muted-foreground" aria-label="读取日志" /> : logComplete ? <Badge className="h-4 px-1 text-[8px]" variant="muted">日志完成</Badge> : null}
          {selectedBuildUrl ? <Button asChild className="size-6 p-0" variant="ghost" size="icon-sm"><a href={selectedBuildUrl} target="_blank" rel="noreferrer" aria-label="在 Jenkins 打开构建"><ExternalLink className="size-3" /></a></Button> : null}
        </div>
      </header>
      {logError ? <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-destructive/20 bg-destructive/5 px-3 text-[9px] text-destructive" role="alert"><CircleAlert className="size-3" />{logError}</div> : null}
      {selectedBuildNumber !== null ? (
        <XtermLogViewer active={active && (!narrow || mobilePane === "logs")} appendRevision={logAppend.revision} appendText={logAppend.text} ariaLabel={`Jenkins 构建 #${selectedBuildNumber} 日志`} onCopyError={(message) => onError("复制 Jenkins 日志失败", message)} onCopySuccess={(message) => onSuccess("Jenkins 日志已复制", message)} resetKey={`${activeInstanceId}:${selectedJobName}:${selectedBuildNumber}`} text={logText} theme={theme} />
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center bg-[#0e1621] text-center text-[11px] text-[#8793a3]"><div><FileText className="mx-auto mb-2 size-5" /><p>选择构建后显示控制台日志</p></div></div>
      )}
    </section>
  );

  return (
    <main id="jenkinsView" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background" aria-label="Jenkins 任务管理">
      {narrow ? (
        <nav className="grid h-9 shrink-0 grid-cols-3 border-b bg-card p-1" aria-label="Jenkins 移动面板">
          {([
            ["jobs", "实例 / Job"],
            ["activity", "构建 / 队列"],
            ["logs", "详情 / 日志"],
          ] as const).map(([id, label]) => <button key={id} type="button" className={cn("rounded-md text-[10px] text-muted-foreground", mobilePane === id && "bg-accent font-semibold text-foreground")} aria-current={mobilePane === id ? "page" : undefined} onClick={() => setMobilePane(id)}>{label}</button>)}
        </nav>
      ) : null}
      <div className={cn("min-h-0 flex-1", narrow ? "flex" : "grid grid-cols-[minmax(220px,260px)_minmax(260px,340px)_minmax(360px,1fr)]")}>
        {narrow ? mobilePane === "jobs" ? jobsPanel : mobilePane === "activity" ? activityPanel : logPanel : <>{jobsPanel}{activityPanel}{logPanel}</>}
      </div>

      {dialog ? (
        <JenkinsInstanceDialog
          open
          mode={dialog.mode}
          source={dialog.source}
          submitting={dialogSubmitting}
          testing={testingInstanceId === dialog.source?.id}
          onOpenChange={(open) => !open && setDialog(null)}
          onSubmit={submitInstance}
          onTest={dialog.mode === "edit" && dialog.source ? () => testInstance(dialog.source as JenkinsInstance) : null}
        />
      ) : null}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>删除 Jenkins“{deleteTarget?.name}”</AlertDialogTitle><AlertDialogDescription>将删除本地实例配置及其安全存储的 Token，不会删除 Jenkins 服务器上的任务或构建记录。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void confirmDelete()}>删除实例</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={triggerOpen} onOpenChange={(open) => {
        if (busyAction) return;
        setTriggerOpen(open);
        if (!open) setTriggerJob(null);
      }}>
        <DialogContent className="max-w-md gap-3 p-5">
          <DialogHeader><DialogTitle className="text-base">运行“{triggerJob?.fullName}”</DialogTitle><DialogDescription className="text-xs">提交后任务会进入当前 Jenkins 实例的构建队列。</DialogDescription></DialogHeader>
          <div className="grid max-h-[50vh] gap-3 overflow-auto">
            {triggerJob?.parameters.map((parameter) => {
              if (parameter.type === "hidden") return null;
              if (parameter.type === "separator") return (
                <div key={parameter.name} className="grid gap-1 pt-1" role="group" aria-label={parameter.header || parameter.description || "参数分隔"}>
                  {parameter.header || parameter.description ? <span className="text-[10px] font-semibold text-muted-foreground">{parameter.header || parameter.description}</span> : null}
                  <Separator />
                </div>
              );
              const passwordRequired = parameter.type === "password" && Boolean(triggerJob?.requiresExplicitPassword);
              return (
                <label key={parameter.name} className="grid gap-1 text-[11px] font-medium">
                  <span>{parameter.name}<span className="ml-1 font-normal text-muted-foreground">{parameter.description}</span></span>
                  {parameter.type === "choice" && parameter.multiple && parameterOptionsState(parameter) === "ready" && parameter.choices.length ? (
                    <ParameterMultiSelect
                      choices={parameter.choices}
                      name={parameter.name}
                      value={Array.isArray(parameterValues[parameter.name]) ? parameterValues[parameter.name] as string[] : []}
                      onValueChange={(value) => setParameterValues((current) => ({
                        ...current,
                        [parameter.name]: value,
                      }))}
                    />
                  ) : parameter.type === "choice" && parameterOptionsState(parameter) === "ready" && parameter.choices.length ? (
                    <ParameterChoiceSelect
                      choices={parameter.choices}
                      name={parameter.name}
                      value={String(parameterValues[parameter.name] ?? "")}
                      onValueChange={(value) => setParameterValues((current) => ({
                        ...current,
                        [parameter.name]: value,
                      }))}
                    />
                  ) : parameter.type === "choice" ? (
                    <span className="rounded-md border border-warning/25 bg-warning/5 px-2 py-2 text-[10px] font-normal text-warning" role="alert">{choiceUnavailableMessage(parameter)}</span>
                  ) : parameter.type === "boolean" ? (
                    <span className="flex h-8 items-center gap-2 rounded-md border px-2"><Switch checked={Boolean(parameterValues[parameter.name])} onCheckedChange={(checked) => setParameterValues((current) => ({ ...current, [parameter.name]: checked }))} aria-label={`参数 ${parameter.name}`} /><span className="text-[10px] text-muted-foreground">{parameterValues[parameter.name] ? "true" : "false"}</span></span>
                  ) : parameter.type === "file" ? (
                    <span className="rounded-md border border-warning/25 bg-warning/5 px-2 py-2 text-[10px] font-normal text-warning">文件上传参数暂不支持，请在 Jenkins 页面运行。</span>
                  ) : parameter.type === "unsupported" ? (
                    <span className="rounded-md border border-warning/25 bg-warning/5 px-2 py-2 text-[10px] font-normal text-warning">{isReactiveParameter(parameter) ? "级联或响应式参数暂不支持，请在 Jenkins 页面运行。" : "当前参数类型暂不支持，请在 Jenkins 页面运行。"}</span>
                  ) : (
                    <>
                      <Input
                        className="h-8 text-xs"
                        type={parameter.type === "number" ? "number" : parameter.type === "password" ? "password" : "text"}
                        value={String(parameterValues[parameter.name] ?? "")}
                        required={passwordRequired}
                        placeholder={parameter.type === "password" ? (passwordRequired ? "此动态参数任务必须填写" : "留空使用 Jenkins 默认值") : undefined}
                        onChange={(event) => setParameterValues((current) => ({ ...current, [parameter.name]: event.target.value }))}
                      />
                      {parameter.type === "password" ? <span className="text-[9px] font-normal text-muted-foreground">{passwordRequired ? "Jenkins 动态构建表单要求显式输入；已有秘密不会被读取或回显。" : "留空使用 Jenkins 默认值，不会读取或回显已有秘密。"}</span> : null}
                    </>
                  )}
                </label>
              );
            })}
            {!editableTriggerParameters.length ? <p className="rounded-lg border bg-muted/25 p-3 text-xs text-muted-foreground">该任务没有需要填写的参数，将使用 Jenkins 中保存的配置运行。</p> : null}
          </div>
          <DialogFooter><Button variant="outline" size="sm" disabled={Boolean(busyAction)} onClick={() => { setTriggerOpen(false); setTriggerJob(null); }}>取消</Button><Button size="sm" disabled={Boolean(busyAction) || Boolean(triggerUnsupportedMessage) || triggerInvalidChoiceParameters.length > 0 || triggerMissingPasswordParameters.length > 0} onClick={() => void confirmBuild()}>{busyAction === "trigger" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}确认运行</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(stopTarget)} onOpenChange={(open) => !open && !busyAction && setStopTarget(null)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>停止构建 #{stopTarget?.number}</AlertDialogTitle><AlertDialogDescription>Jenkins 会向正在运行的构建发送停止请求，当前执行步骤可能需要短暂时间才能退出。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void confirmStop()}>停止构建</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(cancelTarget)} onOpenChange={(open) => !open && !busyAction && setCancelTarget(null)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>取消队列 #{cancelTarget?.id}</AlertDialogTitle><AlertDialogDescription>任务“{cancelTarget?.taskFullName || cancelTarget?.taskName}”将从 Jenkins 构建队列中移除。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void confirmCancelQueue()}>取消排队</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
