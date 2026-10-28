"use client";

import {
  ChevronDown,
  ChevronLeft,
  Check,
  CircleAlert,
  Copy,
  Ellipsis,
  ExternalLink,
  FileText,
  FlaskConical,
  Folder,
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
import { motion, useReducedMotion } from "motion/react";
import { createPortal } from "react-dom";
import { type CSSProperties, type FormEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

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
import {
  ResizableGroup,
  ResizableHandle,
  ResizablePanel,
} from "@/components/ui/resizable";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { JenkinsInstanceDialog, type JenkinsInstanceDialogMode } from "@/components/jenkins-instance-dialog";
import { XtermLogViewer } from "@/components/xterm-log-viewer";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/cn";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import { resolveJenkinsBuildUrl } from "@/lib/jenkins";
import type {
  JenkinsBuild,
  JenkinsBuildParameterValue,
  JenkinsBuildStages,
  JenkinsInstance,
  JenkinsInstanceInput,
  JenkinsJob,
  JenkinsJobParameter,
  JenkinsPipelineStage,
  JenkinsQueueItem,
  JenkinsStageNodes,
  ResolvedTheme,
} from "@/lib/types";

const ACTIVE_INSTANCE_KEY = "service-console.jenkins.active-instance";
const LOG_POLL_INTERVAL = 1_200;
const LOG_RETRY_MAX_INTERVAL = 15_000;
const LOG_MAX_CHARS = 2_000_000;
const LOG_TRUNCATION_NOTICE = "\r\n[Service Console 已省略较早的 Jenkins 日志]\r\n";

type ConnectionStatus = "unknown" | "checking" | "ok" | "error";
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

function isPipelineJob(job: JenkinsJob): boolean {
  return /pipeline|workflowjob/i.test(job.kind);
}

function resultVariant(status: string): "success" | "warning" | "destructive" | "muted" {
  const value = status.toUpperCase();
  if (["SUCCESS", "STABLE"].includes(value)) return "success";
  if (["RUNNING", "BUILDING", "IN_PROGRESS", "QUEUED", "UNSTABLE", "PAUSED_PENDING_INPUT"].includes(value)) return "warning";
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
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

function timestampMilliseconds(timestamp: number | null): number | null {
  if (timestamp === null || !Number.isFinite(timestamp)) return null;
  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
}

function liveBuildDuration(build: JenkinsBuild): number {
  const startedAt = timestampMilliseconds(build.timestamp);
  if (!build.building || startedAt === null) return build.duration;
  return Math.max(build.duration, Date.now() - startedAt);
}

function formatElapsed(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1_000) return "0s";
  return formatDuration(milliseconds);
}

function statusIsRunning(status: string): boolean {
  return ["RUNNING", "BUILDING", "IN_PROGRESS", "PAUSED_PENDING_INPUT"].includes(status.toUpperCase());
}

function stageIsRunning(stage: JenkinsPipelineStage): boolean {
  return statusIsRunning(stage.status);
}

function stageStatusLabel(status: string): string {
  switch (status.toUpperCase()) {
    case "SUCCESS": return "已完成";
    case "RUNNING":
    case "BUILDING":
    case "IN_PROGRESS": return "进行中";
    case "PAUSED_PENDING_INPUT": return "等待输入";
    case "FAILED":
    case "FAILURE": return "失败";
    case "ABORTED": return "已中止";
    case "UNSTABLE": return "不稳定";
    case "SKIPPED_FOR_CONDITIONAL":
    case "NOT_EXECUTED": return "已跳过";
    case "QUEUED": return "排队中";
    default: return status || "未知";
  }
}

function stageElapsed(stage: JenkinsPipelineStage): number | null {
  if (!stageIsRunning(stage)) return stage.duration;
  const startedAt = timestampMilliseconds(stage.startTime);
  return startedAt === null ? stage.duration : Math.max(stage.duration, Date.now() - startedAt);
}

function pipelineStatusClasses(status: string): { dot: string; line: string; text: string } {
  switch (resultVariant(status)) {
    case "success": return { dot: "border-success bg-success/15 text-success", line: "bg-success/60", text: "text-success" };
    case "warning": return { dot: "border-warning bg-warning/15 text-warning", line: "bg-warning/60", text: "text-warning" };
    case "destructive": return { dot: "border-destructive bg-destructive/15 text-destructive", line: "bg-destructive/60", text: "text-destructive" };
    default: return { dot: "border-border bg-muted text-muted-foreground", line: "bg-border", text: "text-muted-foreground" };
  }
}

function PipelineStageMarker({ status, endpoint }: { status?: string; endpoint?: boolean }) {
  if (endpoint) {
    return <span className="size-2.5 rounded-full border border-muted-foreground/30 bg-muted-foreground/60" aria-hidden="true" />;
  }
  const value = status ?? "UNKNOWN";
  const variant = resultVariant(value);
  const tone = pipelineStatusClasses(value);
  return (
    <span className={cn("relative z-[1] grid size-4 place-items-center rounded-full border", tone.dot)} aria-label={stageStatusLabel(value)}>
      {variant === "success" ? <Check className="size-2.5" aria-hidden="true" /> : statusIsRunning(value) ? <LoaderCircle className="size-2.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : variant === "destructive" ? <CircleAlert className="size-2.5" aria-hidden="true" /> : <span className="size-1 rounded-full bg-current" aria-hidden="true" />}
    </span>
  );
}

function JenkinsPipelineStageOverview({ stages }: { stages: JenkinsPipelineStage[] }) {
  const points: Array<{ label: string; status?: string; endpoint?: boolean }> = [
    { label: "Start", endpoint: true },
    ...stages.map((stage) => ({ label: stage.name, status: stage.status })),
    { label: "End", endpoint: true },
  ];
  return (
    <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded focus-visible:ring-2 focus-visible:ring-ring [scrollbar-width:thin]" role="list" aria-label="Pipeline Stage 概览" tabIndex={0}>
      <div className="flex w-max min-w-full items-start py-1">
        {points.map((point, index) => {
          const incomingTone = pipelineStatusClasses(points[index - 1]?.status ?? point.status ?? "UNKNOWN").line;
          const outgoingTone = pipelineStatusClasses(point.status ?? points[index + 1]?.status ?? "UNKNOWN").line;
          return (
            <div key={`${point.label}-${index}`} className={cn("shrink-0", point.endpoint ? "w-8" : "w-[76px] flex-1")} role="listitem" aria-label={point.status ? `Stage ${point.label}：${stageStatusLabel(point.status)}` : point.label}>
              <span className="block h-3 truncate px-1 text-center text-[9px] leading-3 text-muted-foreground" title={point.label}>{point.label}</span>
              <div className="relative mt-1 flex h-4 items-center justify-center">
                {index > 0 ? <span className={cn("absolute top-1/2 left-0 h-px", point.endpoint ? "right-[calc(50%+5px)]" : "right-[calc(50%+8px)]", incomingTone)} aria-hidden="true" /> : null}
                {index < points.length - 1 ? <span className={cn("absolute top-1/2 right-0 h-px", point.endpoint ? "left-[calc(50%+5px)]" : "left-[calc(50%+8px)]", outgoingTone)} aria-hidden="true" /> : null}
                <PipelineStageMarker status={point.status} endpoint={point.endpoint} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JenkinsStageNodeList({
  active, api, instanceId, jobName, buildNumber, stageId, stageName, stageStatus, building, expanded, id, panelRef, position, onMouseEnter, onMouseLeave, onResize,
}: {
  active: boolean;
  api: ServiceConsoleApiClient;
  instanceId: string;
  jobName: string;
  buildNumber: number;
  stageId: string;
  stageName: string;
  stageStatus: string;
  building: boolean;
  expanded: boolean;
  id: string;
  panelRef: { current: HTMLDivElement | null };
  position: CSSProperties | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onResize: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const [snapshot, setSnapshot] = useState<JenkinsStageNodes | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    if (!expanded) return;
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(onResize);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [expanded, onResize, panelRef]);

  useEffect(() => {
    if (!active || !expanded) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      setLoading(true);
      try {
        const result = await api.getJenkinsStageNodes(instanceId, jobName, buildNumber, stageId);
        if (cancelled) return;
        setSnapshot(result);
        setError("");
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (building) timer = window.setTimeout(() => void poll(), 4_000);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, api, instanceId, jobName, buildNumber, stageId, stageStatus, building, expanded, retry]);

  return (
    <motion.div
      id={id}
      ref={panelRef}
      role="dialog"
      aria-label={`${stageName} 的 Node 执行步骤`}
      className="fixed z-50 w-[min(320px,calc(100vw-16px))] max-h-[min(380px,calc(100vh-16px))] overflow-y-auto overscroll-contain rounded-md border border-border/80 bg-popover p-2 text-popover-foreground shadow-xl ring-1 ring-black/10 [scrollbar-width:thin]"
      initial={false}
      animate={{ opacity: expanded ? 1 : 0, scale: expanded ? 1 : 0.98, y: expanded ? 0 : -4 }}
      transition={{ duration: reducedMotion ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
      aria-hidden={!expanded}
      inert={!expanded}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ ...(position ?? {}), pointerEvents: expanded ? "auto" : "none", visibility: position ? "visible" : "hidden" }}
    >
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2 border-b pb-1.5 text-[9px] text-muted-foreground">
        <span>执行步骤 · Node{snapshot ? ` (${snapshot.nodes.length})` : ""}</span>
        {loading ? <LoaderCircle className="size-2.5 animate-spin motion-reduce:animate-none" aria-label="正在读取 Node" /> : null}
      </div>
      {error ? (
        <div className="mb-1.5 text-[9px] text-destructive" role="alert">
          <p className="[overflow-wrap:anywhere]">节点读取失败：{error}</p>
          <button type="button" className="mt-0.5 cursor-pointer rounded underline focus-visible:ring-2 focus-visible:ring-ring" disabled={loading} onClick={() => setRetry((value) => value + 1)}>重试节点</button>
        </div>
      ) : null}
      {!snapshot && loading ? <p className="text-[9px] text-muted-foreground">正在读取执行步骤…</p> : null}
      {snapshot?.nodes.length ? (
        <ol className="relative min-w-0" aria-label="Node 执行步骤">
          {snapshot.nodes.map((node, index) => {
            const tone = pipelineStatusClasses(node.status);
            const running = stageIsRunning(node);
            const variant = resultVariant(node.status);
            return (
              <li key={`${node.id}-${index}`} className="relative flex min-w-0 gap-1.5 py-0.5">
                {index < snapshot.nodes.length - 1 ? <span className={cn("absolute left-1.5 top-2.5 bottom-[-10px] z-0 w-px", tone.line)} data-node-connector="true" aria-hidden="true" /> : null}
                <span className={cn("relative z-[1] mt-1 grid size-3 shrink-0 place-items-center rounded-full border", tone.dot)} aria-label={`Node ${node.id}：${stageStatusLabel(node.status)}`}>
                  {variant === "success" ? <Check className="size-2" aria-hidden="true" /> : running ? <LoaderCircle className="size-2 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : variant === "destructive" ? <CircleAlert className="size-2" aria-hidden="true" /> : <span className="size-1 rounded-full bg-current" aria-hidden="true" />}
                </span>
                <div className="min-w-0 flex-1 rounded px-1 py-0.5">
                  <div className="flex min-w-0 items-center gap-1">
                    <p className="min-w-0 flex-1 truncate text-[10px] leading-tight" title={node.name}>{node.name}</p>
                    <span className={cn("shrink-0 text-[8px] font-medium", tone.text)}>{stageStatusLabel(node.status)}</span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[8px] text-muted-foreground">
                    <span className="font-mono tabular-nums">{formatElapsed(stageElapsed(node))}</span>
                    <span className="ml-auto truncate" title={`Node #${node.id}`}>#{node.id}</span>
                  </div>
                  {node.error ? <p className="mt-0.5 text-[9px] leading-relaxed whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">{node.error}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : snapshot && !error ? (
        <p className="text-[9px] text-muted-foreground">{snapshot.available ? "该阶段尚未提供 Node 执行步骤。" : "该阶段的 Node API 未开放；阶段状态与耗时仍可查看。"}</p>
      ) : null}
    </div>
    </motion.div>
  );
}

function JenkinsStageCard({ stage, index, ...context }: {
  stage: JenkinsPipelineStage;
  index: number;
  active: boolean;
  api: ServiceConsoleApiClient;
  instanceId: string;
  jobName: string;
  buildNumber: number;
  building: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [nodesMounted, setNodesMounted] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const nodesId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const variant = resultVariant(stage.status);
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const padding = 8;
    const panelWidth = panelRect.width || Math.min(320, Math.max(0, window.innerWidth - padding * 2));
    const panelHeight = panelRect.height || 260;
    const left = Math.min(Math.max(padding, triggerRect.left), Math.max(padding, window.innerWidth - panelWidth - padding));
    const below = triggerRect.bottom + 6;
    const above = triggerRect.top - panelHeight - 6;
    const top = below + panelHeight <= window.innerHeight - padding || above < padding ? Math.max(padding, below) : above;
    setPosition({ left, top });
  }, []);
  const openNodes = useCallback((pin = false) => {
    clearCloseTimer();
    setNodesMounted(true);
    setExpanded(true);
    if (pin) setPinned(true);
  }, [clearCloseTimer]);
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    if (pinned) return;
    closeTimerRef.current = window.setTimeout(() => {
      setExpanded(false);
      setPinned(false);
      closeTimerRef.current = null;
    }, 140);
  }, [clearCloseTimer, pinned]);
  const toggleNodes = useCallback(() => {
    clearCloseTimer();
    if (expanded && pinned) {
      setExpanded(false);
      setPinned(false);
      return;
    }
    openNodes(true);
  }, [clearCloseTimer, expanded, openNodes, pinned]);
  useLayoutEffect(() => {
    if (!nodesMounted) return;
    updatePosition();
  }, [expanded, nodesMounted, updatePosition]);
  useEffect(() => {
    if (!expanded) return;
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || panelRef.current?.contains(target))) return;
      clearCloseTimer();
      setExpanded(false);
      setPinned(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setExpanded(false);
      setPinned(false);
    };
    const reposition = () => updatePosition();
    document.addEventListener("pointerdown", closeIfOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [clearCloseTimer, expanded, updatePosition]);
  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);
  return (
    <motion.div
      layout="position"
      transition={{ layout: { duration: 0.18, ease: [0.22, 1, 0.36, 1] } }}
      className={cn("min-w-0 rounded border bg-card", stageIsRunning(stage) && "border-warning/50", variant === "destructive" && "border-destructive/40")}
      role="listitem"
    >
      <button
        type="button"
        ref={triggerRef}
        className="block min-h-12 w-full min-w-0 cursor-pointer rounded px-2 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-controls={nodesId}
        aria-haspopup="dialog"
        aria-label={`${expanded ? "收起" : "查看"} ${stage.name} 的 Node`}
        onClick={toggleNodes}
        onFocus={() => openNodes()}
        onMouseEnter={() => openNodes()}
        onMouseLeave={scheduleClose}
      >
        <span className="flex min-w-0 items-start gap-2">
          <span className={cn(
            "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border",
            variant === "success" && "border-success/40 bg-success/15 text-success",
            variant === "warning" && "border-warning/40 bg-warning/15 text-warning",
            variant === "destructive" && "border-destructive/40 bg-destructive/15 text-destructive",
            variant === "muted" && "border-border bg-muted text-muted-foreground",
          )}>
            {variant === "success" ? <Check className="size-2" aria-hidden="true" /> : stageIsRunning(stage) ? <LoaderCircle className="size-2 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <span className="text-[7px]">{index + 1}</span>}
          </span>
          <span className="min-w-0 flex-1 text-[10px] font-medium leading-tight [overflow-wrap:anywhere]">{stage.name}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1 text-[8px] text-muted-foreground">
          <span>{index + 1}.</span>
          <Badge className="px-1 py-0 text-[8px]" variant={variant}>{stageStatusLabel(stage.status)}</Badge>
          <span className="font-mono tabular-nums">{formatElapsed(stageElapsed(stage))}</span>
          <span className="ml-auto inline-flex items-center gap-0.5">Node<ChevronDown className={cn("size-2.5 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden="true" /></span>
        </span>
      </button>
      {nodesMounted && typeof document !== "undefined" ? createPortal(
        <JenkinsStageNodeList
          {...context}
          id={nodesId}
          expanded={expanded}
          stageId={stage.id}
          stageName={stage.name}
          stageStatus={stage.status}
          panelRef={panelRef}
          position={position}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleClose}
          onResize={updatePosition}
        />,
        document.body,
      ) : null}
    </motion.div>
  );
}

/** Below this width the three Jenkins panes become a single tabbed pane. */
const NARROW_JENKINS_LAYOUT = "(max-width: 980px)";

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
  return !["hidden", "reference", "separator"].includes(parameter.type);
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

function choiceUnavailableMessage(
  parameter: JenkinsJobParameter,
  values: Record<string, string | boolean | string[]>,
): string {
  const missingReference = (parameter.references ?? []).find((name) => {
    const value = values[name];
    return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  });
  if (missingReference) return `请先选择 ${missingReference}。`;
  if (parameterOptionsState(parameter) === "not_loaded") return "候选项尚未加载，请关闭后重试。";
  if (parameterOptionsState(parameter) === "unavailable") return "未能读取候选项，请在 Jenkins 页面运行。";
  return "没有可用候选项，请在 Jenkins 页面运行。";
}

function reconcileReactiveValues(
  current: Record<string, string | boolean | string[]>,
  job: JenkinsJob,
): Record<string, string | boolean | string[]> {
  const next = { ...current };
  job.parameters.forEach((parameter) => {
    if (parameter.type !== "choice" || (parameter.references ?? []).length === 0) return;
    if (parameter.multiple) {
      const selected = Array.isArray(current[parameter.name]) ? current[parameter.name] as string[] : [];
      const retained = selected.filter((value) => parameter.choices.includes(value));
      const defaults = Array.isArray(parameter.defaultValue)
        ? parameter.defaultValue.filter((value) => parameter.choices.includes(value))
        : [];
      next[parameter.name] = retained.length ? retained : defaults;
      return;
    }
    const selected = String(current[parameter.name] ?? "");
    if (parameter.choices.includes(selected)) return;
    const defaultValue = parameter.defaultValue === null ? "" : String(parameter.defaultValue);
    next[parameter.name] = parameter.choices.includes(defaultValue)
      ? defaultValue
      : parameter.choices[0] ?? "";
  });
  return next;
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
      <SelectTrigger className="h-8 min-w-0 text-xs" aria-label={`参数 ${name}`}>
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
  const [buildStages, setBuildStages] = useState<JenkinsBuildStages>({ available: false, stages: [] });
  const [buildStagesLoading, setBuildStagesLoading] = useState(false);
  const [buildStagesError, setBuildStagesError] = useState("");
  const [stagesCollapsed, setStagesCollapsed] = useState(true);
  const [queue, setQueue] = useState<JenkinsQueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [operationRevision, setOperationRevision] = useState(0);
  const [busyAction, setBusyAction] = useState("");
  const [preparingBuild, setPreparingBuild] = useState(false);

  const [triggerOpen, setTriggerOpen] = useState(false);
  const [parameterValues, setParameterValues] = useState<Record<string, string | boolean | string[]>>({});
  const [resolvingParameters, setResolvingParameters] = useState(false);
  const [stopTarget, setStopTarget] = useState<JenkinsBuild | null>(null);
  const [cancelTarget, setCancelTarget] = useState<JenkinsQueueItem | null>(null);

  const [logText, setLogText] = useState("");
  const [logAppend, setLogAppend] = useState({ revision: 0, text: "" });
  const [logLoading, setLogLoading] = useState(false);
  const [logComplete, setLogComplete] = useState(false);
  const [logError, setLogError] = useState("");
  const [logTruncated, setLogTruncated] = useState(false);

  const narrow = useMediaQuery(NARROW_JENKINS_LAYOUT);
  const [mobilePane, setMobilePane] = useState<MobilePane>("jobs");
  const activeInstanceIdRef = useRef(activeInstanceId);
  const selectedJobNameRef = useRef(selectedJobName);
  const instancesRequestRef = useRef(0);
  const jobsRequestRef = useRef(0);
  const jobRequestRef = useRef(0);
  const buildRequestRef = useRef(0);
  const queueRequestRef = useRef(0);
  const stageRequestRef = useRef(0);
  const stageSelectionRef = useRef("");
  const pendingBuildRef = useRef<{ instanceId: string; jobName: string; queueId: number } | null>(null);
  const prepareRequestRef = useRef(0);
  const reactiveRequestRef = useRef(0);
  const parameterValuesRef = useRef(parameterValues);
  const pollingErrorsRef = useRef(new Set<string>());
  parameterValuesRef.current = parameterValues;

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
  const reactiveInputKey = useMemo(() => {
    if (!triggerOpen || !triggerJob) return "";
    const referencedNames = new Set(triggerJob.parameters.flatMap((parameter) => parameter.references ?? []));
    return JSON.stringify([...referencedNames].sort().map((name) => [name, parameterValues[name] ?? ""]));
  }, [parameterValues, triggerJob, triggerOpen]);
  const hasReactiveTriggerParameters = useMemo(
    () => triggerJob?.parameters.some((parameter) => (parameter.references ?? []).length > 0) ?? false,
    [triggerJob],
  );
  const selectedBuildUrl = useMemo(
    () => activeInstance && selectedBuild
      ? resolveJenkinsBuildUrl(activeInstance.baseUrl, selectedBuild.url)
      : null,
    [activeInstance, selectedBuild],
  );
  const runningStages = useMemo(
    () => buildStages.stages.filter(stageIsRunning),
    [buildStages.stages],
  );
  const pipelineStageSummary = buildStagesError
    ? "阶段数据读取失败"
    : buildStagesLoading && !buildStages.stages.length
      ? "正在读取阶段数据"
      : !buildStages.available
        ? "阶段数据不可用"
        : runningStages.length
          ? runningStages.length === 1
            ? `当前 ${buildStages.stages.indexOf(runningStages[0]!) + 1}/${buildStages.stages.length}：${runningStages[0]!.name}`
            : `进行中：${runningStages.map((stage) => stage.name).join("、")}`
          : buildStages.stages.length && selectedBuild?.building
            ? "当前：等待下一阶段"
            : buildStages.stages.length
              ? "流程已结束"
              : selectedBuild?.building
                ? "等待首个 Stage"
                : "流程无 Stage";
  const pipelineJob = jobDetail ? isPipelineJob(jobDetail) : false;
  const activityQueue = useMemo(() => {
    const currentJobName = jobDetail?.fullName || selectedJobName;
    const currentShortName = jobDetail?.name || currentJobName.split("/").at(-1) || currentJobName;
    if (!currentJobName) return [];
    return queue.filter((item) => item.taskFullName
      ? item.taskFullName === currentJobName
      : item.taskName === currentShortName);
  }, [jobDetail?.fullName, jobDetail?.name, queue, selectedJobName]);
  const activityQueueItems = useMemo(() => (
    activityQueue.filter((item) => (
      item.executableNumber === null
      || !builds.some((build) => build.number === item.executableNumber)
    ))
  ), [activityQueue, builds]);
  const activityCount = builds.length + activityQueueItems.length;

  const reportPollingError = useCallback((key: string, title: string, error: unknown) => {
    if (pollingErrorsRef.current.has(key)) return;
    pollingErrorsRef.current.add(key);
    onError(title, errorText(error));
  }, [onError]);

  useEffect(() => {
    const instanceId = activeInstance?.id;
    const jobName = triggerJob?.fullName;
    if (!triggerOpen || !instanceId || !jobName || !hasReactiveTriggerParameters || !reactiveInputKey) return;
    const requestId = ++reactiveRequestRef.current;
    const timeoutId = window.setTimeout(() => {
      setResolvingParameters(true);
      void api.resolveJenkinsJobParameters(instanceId, jobName, parameterValuesRef.current)
        .then((resolved) => {
          if (requestId !== reactiveRequestRef.current || !triggerOpen) return;
          setTriggerJob(resolved);
          setParameterValues((current) => reconcileReactiveValues(current, resolved));
        })
        .catch((error) => {
          if (requestId === reactiveRequestRef.current) {
            onError("刷新 Jenkins 级联参数失败", errorText(error));
          }
        })
        .finally(() => {
          if (requestId === reactiveRequestRef.current) setResolvingParameters(false);
        });
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [activeInstance?.id, api, hasReactiveTriggerParameters, onError, reactiveInputKey, triggerJob?.fullName, triggerOpen]);

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
    stageRequestRef.current += 1;
    setBuildStages({ available: false, stages: [] });
    setBuildStagesError("");
    setQueue([]);
    pendingBuildRef.current = null;
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
        stageRequestRef.current += 1;
        setBuildStages({ available: false, stages: [] });
        setBuildStagesError("");
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
      pendingBuildRef.current = null;
      setJobDetail(null);
      setTriggerJob(null);
      setTriggerOpen(false);
      setBuilds([]);
      setSelectedBuildNumber(null);
      stageRequestRef.current += 1;
      setBuildStages({ available: false, stages: [] });
      setBuildStagesError("");
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
      const pendingBuild = pendingBuildRef.current;
      const trackedBuild = pendingBuild
        && pendingBuild.instanceId === instanceId
        && pendingBuild.jobName === jobName
        ? nextBuilds.find((build) => build.queueId === pendingBuild.queueId)
        : undefined;
      if (trackedBuild) pendingBuildRef.current = null;
      setSelectedBuildNumber((current) => (
        trackedBuild
          ? trackedBuild.number
          : current !== null && nextBuilds.some((build) => build.number === current)
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
    const instanceId = activeInstance?.id;
    const jobName = selectedJobName;
    const buildNumber = selectedBuildNumber;
    setBuildStagesError("");
    if (!active || !instanceId || !jobName || buildNumber === null || !pipelineJob) {
      stageRequestRef.current += 1;
      stageSelectionRef.current = "";
      setBuildStagesLoading(false);
      setBuildStages({ available: false, stages: [] });
      return;
    }
    const selectionKey = `${instanceId}:${jobName}:${buildNumber}`;
    if (stageSelectionRef.current !== selectionKey) {
      stageSelectionRef.current = selectionKey;
      setBuildStages({ available: false, stages: [] });
    }
    const requestId = ++stageRequestRef.current;
    const errorKey = `stages:${instanceId}:${jobName}:${buildNumber}`;
    setBuildStagesLoading(true);
    void api.getJenkinsBuildStages(instanceId, jobName, buildNumber).then((nextStages) => {
      if (
        requestId !== stageRequestRef.current
        || activeInstanceIdRef.current !== instanceId
        || selectedJobNameRef.current !== jobName
        || selectedBuildNumber !== buildNumber
      ) return;
      setBuildStages(nextStages);
      setBuildStagesError("");
      recoverPollingError(errorKey);
    }).catch((error: unknown) => {
      if (
        requestId === stageRequestRef.current
        && activeInstanceIdRef.current === instanceId
        && selectedJobNameRef.current === jobName
        && selectedBuildNumber === buildNumber
      ) {
        setBuildStagesError(errorText(error));
        reportPollingError(errorKey, "读取 Jenkins Pipeline 阶段失败", error);
      }
    }).finally(() => {
      if (requestId === stageRequestRef.current) setBuildStagesLoading(false);
    });
  }, [active, activeInstance?.id, api, operationRevision, pipelineJob, recoverPollingError, refreshSignal, reportPollingError, selectedBuildNumber, selectedJobName]);

  useEffect(() => {
    if (!active || (!builds.some((build) => build.building) && !queue.length && pendingBuildRef.current === null)) return;
    const timer = window.setInterval(() => setOperationRevision((value) => value + 1), 4_000);
    return () => window.clearInterval(timer);
  }, [active, builds, operationRevision, queue.length]);

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
      pendingBuildRef.current = null;
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
      pendingBuildRef.current = null;
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
      stageRequestRef.current += 1;
      setBuildStages({ available: false, stages: [] });
      setBuildStagesError("");
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
      if (queued.id !== null) {
        pendingBuildRef.current = { instanceId, jobName: job.fullName, queueId: queued.id };
      }
      setTriggerOpen(false);
      setTriggerJob(null);
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
    if (pendingBuildRef.current?.instanceId === instanceId && pendingBuildRef.current.queueId === item.id) {
      pendingBuildRef.current = null;
    }
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar" aria-label="Jenkins 实例与任务">
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
          <button className="grid w-full place-items-center rounded-lg border border-dashed px-3 py-5 text-center text-[10px] text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70" type="button" onClick={() => setDialog({ mode: "create", source: null })}>
            <Plus className="mb-1 size-4" aria-hidden="true" /><span>添加第一个 Jenkins 实例</span>
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card" aria-label="Jenkins 活动任务">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-[12px] font-semibold">{jobDetail?.fullName || selectedJobName || "选择一个任务"}</h2>
          <p className="mt-0.5 truncate text-[9px] text-muted-foreground">{jobDetail ? `${pipelineJob ? "Pipeline · 选择构建查看 Stage · " : jobDetail.kind === "freestyle" ? "Freestyle · 无结构化 Stage · " : ""}${jobDetail.status} · ${editableJobParameters.length ? `${editableJobParameters.length} 个参数` : "无可填写参数"}` : "查看当前构建状态、排队任务和构建日志"}</p>
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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3" aria-label="Jenkins 活动统计">
        <Workflow className="size-3 text-primary" aria-hidden="true" />
        <span className="text-[10px] font-semibold">活动任务 {activityCount}</span>
        {activityQueueItems.length ? <Badge className="h-4 px-1 text-[8px]" variant="warning">排队 {activityQueueItems.length}</Badge> : null}
      </div>
      <div className="no-visible-scrollbar min-h-0 flex-1 overflow-auto" role="list" aria-label="Jenkins 活动任务列表" aria-busy={buildsLoading || queueLoading}>
        {activityQueueItems.map((item) => (
          <div key={`queue-${item.id}`} className="flex min-h-12 items-center gap-2 border-b px-3 py-1.5">
            <span className={cn("size-2 shrink-0 rounded-full bg-warning", item.stuck && "bg-destructive")} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <strong className="truncate text-[10px]">{item.taskFullName || item.taskName || `队列 #${item.id}`}</strong>
                <Badge className="h-4 shrink-0 px-1 text-[8px]" variant={item.executableNumber === null ? "warning" : "muted"}>{item.executableNumber === null ? "排队中" : "准备执行"}</Badge>
              </span>
              <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">队列 #{item.id} · {item.executableNumber === null ? (item.why || (item.blocked ? "等待资源" : "等待执行")) : `即将构建 #${item.executableNumber}`}</span>
            </span>
            {item.executableNumber === null ? <Button className="h-6 px-1.5 text-[9px] text-destructive hover:text-destructive" variant="ghost" size="sm" disabled={Boolean(busyAction)} onClick={() => setCancelTarget(item)}>取消</Button> : null}
          </div>
        ))}
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
                  <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">{formatTimestamp(build.timestamp)} · {formatElapsed(liveBuildDuration(build))}</span>
                </span>
              </button>
              {build.building ? <Button className="mr-2 size-6 p-0 text-destructive hover:text-destructive" variant="ghost" size="icon-sm" aria-label={`停止构建 #${build.number}`} disabled={Boolean(busyAction)} onClick={() => setStopTarget(build)}><Square className="size-3 fill-current" /></Button> : null}
            </div>
          ))}
        {buildsLoading || queueLoading ? <p className="flex items-center justify-center gap-2 py-8 text-[10px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />正在同步活动任务</p> : null}
        {!buildsLoading && !queueLoading && selectedJobName && !activityQueueItems.length && !builds.length ? <p className="px-3 py-8 text-center text-[10px] text-muted-foreground">暂无构建或排队任务</p> : null}
      </div>
    </section>
  );

  const logPanel = (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card" aria-label="Jenkins 构建详情与日志">
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <div className="min-w-0">
          <h2 className="truncate text-[12px] font-semibold">{selectedBuild ? selectedBuild.fullDisplayName || `${selectedJobName} #${selectedBuild.number}` : "构建日志"}</h2>
          <p className="mt-0.5 truncate text-[9px] text-muted-foreground">{selectedBuild ? `${selectedBuild.status} · ${formatTimestamp(selectedBuild.timestamp)} · ${formatElapsed(liveBuildDuration(selectedBuild))}` : "从构建历史选择一条记录"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {logTruncated ? <Badge className="h-4 px-1 text-[8px]" variant="warning">已截断</Badge> : null}
          {logLoading ? <LoaderCircle className="size-3 animate-spin text-muted-foreground" aria-label="读取日志" /> : logComplete ? <Badge className="h-4 px-1 text-[8px]" variant="muted">日志完成</Badge> : null}
          {selectedBuildUrl ? <Button asChild className="size-6 p-0" variant="ghost" size="icon-sm"><a href={selectedBuildUrl} target="_blank" rel="noreferrer" aria-label="在 Jenkins 打开构建"><ExternalLink className="size-3" /></a></Button> : null}
        </div>
      </header>
      {logError ? <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-destructive/20 bg-destructive/5 px-3 text-[9px] text-destructive" role="alert"><CircleAlert className="size-3" />{logError}</div> : null}
      {selectedBuildNumber !== null && pipelineJob ? (
        <section className="flex max-h-[45%] min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-b bg-muted/10" aria-label="Jenkins Pipeline 阶段" aria-busy={buildStagesLoading}>
          <div className={cn("flex min-w-0 shrink-0 items-center gap-x-2 px-3 text-[10px]", stagesCollapsed ? "flex-nowrap py-1" : "flex-wrap gap-y-1 py-2")}>
            <button type="button" className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded py-1 font-semibold whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring" aria-label={stagesCollapsed ? "展开 Pipeline 阶段" : "收起 Pipeline 阶段"} aria-expanded={!stagesCollapsed} title={stagesCollapsed ? pipelineStageSummary : undefined} onClick={() => setStagesCollapsed((value) => !value)}>
              <Workflow className="size-3 text-primary" aria-hidden="true" />Pipeline 阶段
              <ChevronDown className={cn("size-3 transition-transform motion-reduce:transition-none", stagesCollapsed && "-rotate-90")} aria-hidden="true" />
            </button>
            {stagesCollapsed && buildStages.stages.length > 0 ? <JenkinsPipelineStageOverview stages={buildStages.stages} /> : null}
            {!stagesCollapsed && selectedBuild ? <span className="ml-auto text-muted-foreground">总耗时 {formatElapsed(liveBuildDuration(selectedBuild))}</span> : null}
            {!stagesCollapsed || !buildStages.stages.length ? <p className={cn("text-muted-foreground", stagesCollapsed ? "min-w-0 flex-1 truncate" : "basis-full [overflow-wrap:anywhere]")}>{pipelineStageSummary}</p> : null}
          </div>
          {!stagesCollapsed ? <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pb-2 [scrollbar-width:thin]">
            {buildStagesError ? (
              <p className="flex items-center gap-1.5 text-[9px] text-destructive" role="alert"><CircleAlert className="size-3" />{buildStagesError}</p>
            ) : buildStagesLoading && !buildStages.stages.length ? (
              <p className="flex items-center gap-1.5 text-[9px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />正在读取阶段进度</p>
            ) : buildStages.stages.length ? (
              <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] items-start gap-1.5" role="list" aria-label="Pipeline 阶段列表">
                {buildStages.stages.map((stage, index) => (
                  <JenkinsStageCard
                    key={`${activeInstanceId}:${selectedJobName}:${selectedBuildNumber}:${stage.id}:${index}`}
                    stage={stage}
                    index={index}
                    active={active}
                    api={api}
                    instanceId={activeInstanceId}
                    jobName={selectedJobName}
                    buildNumber={selectedBuildNumber}
                    building={selectedBuild?.building ?? false}
                  />
                ))}
              </div>
            ) : !buildStages.available ? (
              <p className="flex items-center gap-1.5 text-[9px] text-muted-foreground"><CircleAlert className="size-3 shrink-0" />总耗时已由构建接口读取；Jenkins Stage API（/wfapi/describe）未开放，请启用 Pipeline: REST API 插件。</p>
            ) : (
              <p className="text-[9px] text-muted-foreground">该 Pipeline 尚未生成可显示的 Stage。</p>
            )}
          </div> : null}
        </section>
      ) : null}
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
            ["activity", "活动任务"],
            ["logs", "详情 / 日志"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                "rounded-md text-[10px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70",
                mobilePane === id && "bg-accent font-semibold text-accent-foreground",
              )}
              aria-current={mobilePane === id ? "page" : undefined}
              onClick={() => setMobilePane(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      ) : null}
      {narrow ? (
        <div className="flex min-h-0 flex-1">
          {mobilePane === "jobs" ? jobsPanel : mobilePane === "activity" ? activityPanel : logPanel}
        </div>
      ) : (
        <ResizableGroup
          id="jenkins-pane-layout"
          className="min-h-0 flex-1"
          orientation="horizontal"
        >
          <ResizablePanel id="jenkins-jobs" defaultSize={240} minSize={220} maxSize={340}>
            {jobsPanel}
          </ResizablePanel>
          <ResizableHandle id="jenkins-jobs-resize" aria-label="调整 Jenkins 实例栏宽度" />
          <ResizablePanel id="jenkins-activity" defaultSize={300} minSize={260} maxSize={420}>
            {activityPanel}
          </ResizablePanel>
          <ResizableHandle id="jenkins-activity-resize" aria-label="调整 Jenkins 活动栏宽度" />
          <ResizablePanel id="jenkins-logs" minSize={360}>
            {logPanel}
          </ResizablePanel>
        </ResizableGroup>
      )}

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
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>删除实例</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={triggerOpen} onOpenChange={(open) => {
        if (busyAction) return;
        if (!open) {
          reactiveRequestRef.current += 1;
          setResolvingParameters(false);
        }
        setTriggerOpen(open);
        if (!open) setTriggerJob(null);
      }}>
        <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-xl min-w-0 flex-col gap-3 overflow-hidden p-5">
          <DialogHeader className="min-w-0 shrink-0 pr-7"><DialogTitle className="truncate text-base" title={`运行“${triggerJob?.fullName ?? ""}”`}>运行“{triggerJob?.fullName}”</DialogTitle><DialogDescription className="text-xs">提交后任务会进入当前 Jenkins 实例的构建队列。</DialogDescription></DialogHeader>
          <div
            className="no-visible-scrollbar grid min-h-0 min-w-0 max-h-[calc(100dvh-10rem)] gap-3 overflow-x-hidden overflow-y-auto overscroll-contain"
            role="region"
            aria-label="构建参数"
          >
            {triggerJob?.parameters.map((parameter) => {
              if (parameter.type === "hidden") return null;
              if (parameter.type === "separator") return (
                <div key={parameter.name} className="grid min-w-0 gap-1 pt-1" role="group" aria-label={parameter.header || parameter.description || "参数分隔"}>
                  {parameter.header || parameter.description ? <span className="min-w-0 break-words text-[10px] font-semibold text-muted-foreground">{parameter.header || parameter.description}</span> : null}
                  <Separator />
                </div>
              );
              const passwordRequired = parameter.type === "password" && Boolean(triggerJob?.requiresExplicitPassword);
              return (
                <label key={parameter.name} className="grid min-w-0 gap-1 text-[11px] font-medium">
                  <span className="min-w-0 break-words">{parameter.name}<span className="ml-1 font-normal text-muted-foreground">{parameter.description}</span></span>
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
                    <span className="flex items-center gap-1.5 rounded-md border border-warning/25 bg-warning/5 px-2 py-2 text-[10px] font-normal text-warning" role="alert">
                      {resolvingParameters && (parameter.references ?? []).length ? <LoaderCircle className="size-3 animate-spin" /> : null}
                      {choiceUnavailableMessage(parameter, parameterValues)}
                    </span>
                  ) : parameter.type === "reference" ? (
                    <span className="rounded-md border bg-muted/25 px-2 py-2 text-[10px] font-normal text-muted-foreground">
                      {parameter.choices.length ? parameter.choices.join("、") : (resolvingParameters ? "正在刷新…" : "暂无响应式内容")}
                    </span>
                  ) : parameter.type === "boolean" ? (
                    <span className="flex h-8 min-w-0 items-center gap-2 rounded-md border px-2"><Switch checked={Boolean(parameterValues[parameter.name])} onCheckedChange={(checked) => setParameterValues((current) => ({ ...current, [parameter.name]: checked }))} aria-label={`参数 ${parameter.name}`} /><span className="text-[10px] text-muted-foreground">{parameterValues[parameter.name] ? "true" : "false"}</span></span>
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
          <DialogFooter className="shrink-0"><Button variant="outline" size="sm" disabled={Boolean(busyAction)} onClick={() => { reactiveRequestRef.current += 1; setResolvingParameters(false); setTriggerOpen(false); setTriggerJob(null); }}>取消</Button><Button size="sm" disabled={Boolean(busyAction) || resolvingParameters || Boolean(triggerUnsupportedMessage) || triggerInvalidChoiceParameters.length > 0 || triggerMissingPasswordParameters.length > 0} onClick={() => void confirmBuild()}>{busyAction === "trigger" || resolvingParameters ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}确认运行</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(stopTarget)} onOpenChange={(open) => !open && !busyAction && setStopTarget(null)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>停止构建 #{stopTarget?.number}</AlertDialogTitle><AlertDialogDescription>Jenkins 会向正在运行的构建发送停止请求，当前执行步骤可能需要短暂时间才能退出。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void confirmStop()}>停止构建</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(cancelTarget)} onOpenChange={(open) => !open && !busyAction && setCancelTarget(null)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>取消队列 #{cancelTarget?.id}</AlertDialogTitle><AlertDialogDescription>任务“{cancelTarget?.taskFullName || cancelTarget?.taskName}”将从 Jenkins 构建队列中移除。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>返回</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void confirmCancelQueue()}>取消排队</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
