"use client";

import {
  CircleAlert,
  Copy,
  LoaderCircle,
  Network,
  Pencil,
  Plus,
  Search,
  Workflow,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, type ServiceConsoleApiClient } from "@/lib/api-client";
import {
  nextCopyName,
  parseEnvironment,
  serializeEnvironment,
  serviceInputFromProcess,
} from "@/lib/service-logic";
import type {
  NormalizedProcessCandidate,
  NormalizedService,
  ServiceCreateInput,
  ServiceUpdateInput,
} from "@/lib/types";

export type ServiceFormMode = "create" | "edit" | "copy";
type CreateTab = "manual" | "process";

interface ServiceFormDialogProps {
  open: boolean;
  mode: ServiceFormMode;
  sourceService: NormalizedService | null;
  sourceProcess: NormalizedProcessCandidate | null;
  existingNames: string[];
  submitting: boolean;
  api: ServiceConsoleApiClient;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: ServiceCreateInput | ServiceUpdateInput) => Promise<void>;
}

interface FormState {
  name: string;
  command: string;
  cwd: string;
  env: string;
  stopTimeout: string;
  autoStart: boolean;
}

const emptyForm: FormState = {
  name: "",
  command: "",
  cwd: "",
  env: "",
  stopTimeout: "10",
  autoStart: false,
};

const modeCopy = {
  create: {
    eyebrow: "新建进程定义",
    title: "添加服务",
    description: "手动填写启动信息，或从当前运行的进程中提取配置。",
    submit: "添加服务",
    icon: Plus,
  },
  edit: {
    eyebrow: "修改进程定义",
    title: "编辑服务",
    description: "保存配置不会自动重启正在运行的服务。",
    submit: "保存修改",
    icon: Pencil,
  },
  copy: {
    eyebrow: "复制进程定义",
    title: "复制服务",
    description: "将创建一个默认不自动启动的新服务。",
    submit: "创建副本",
    icon: Copy,
  },
} as const;

function formFromInput(input: ServiceCreateInput): FormState {
  return {
    name: input.name,
    command: input.command,
    cwd: input.cwd,
    env: serializeEnvironment(input.env),
    stopTimeout: String(input.stop_timeout),
    autoStart: input.auto_start,
  };
}

function initialForm(
  mode: ServiceFormMode,
  sourceService: NormalizedService | null,
  sourceProcess: NormalizedProcessCandidate | null,
  existingNames: string[],
): FormState {
  if (mode === "create" && sourceProcess) {
    return formFromInput(serviceInputFromProcess(sourceProcess, existingNames));
  }
  if (!sourceService || mode === "create") return emptyForm;
  return {
    name: mode === "copy" ? nextCopyName(sourceService.name, existingNames) : sourceService.name,
    command: sourceService.command,
    cwd: sourceService.cwd,
    env: serializeEnvironment(sourceService.env),
    stopTimeout: String(sourceService.stopTimeout),
    autoStart: mode === "copy" ? false : sourceService.autoStart,
  };
}

function candidateBlockedReason(candidate: NormalizedProcessCandidate): string | null {
  if (candidate.managedService) return `已由服务 ${candidate.managedService} 管理`;
  return null;
}

function isProcessPermissionError(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status === 403
    || (
      error.status === 409
      && /permission denied|access (?:is )?denied|权限|拒绝访问/i.test(error.message)
    )
  );
}

function withManualCompletionWarning(
  candidate: NormalizedProcessCandidate,
  warning = "未能自动提取完整启动配置，请手动补全并核对后再保存。",
): NormalizedProcessCandidate {
  return {
    ...candidate,
    restorable: false,
    warnings: candidate.warnings.includes(warning)
      ? candidate.warnings
      : [...candidate.warnings, warning],
  };
}

function ProcessWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 [overflow-wrap:anywhere] text-[9px] leading-relaxed text-warning" aria-label="进程配置警告">
      {warnings.map((warning, index) => <li key={`${warning}-${index}`}>• {warning}</li>)}
    </ul>
  );
}

export function ServiceFormDialog({
  open,
  mode,
  sourceService,
  sourceProcess,
  existingNames,
  submitting,
  api,
  onOpenChange,
  onSubmit,
}: ServiceFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => (
    initialForm(mode, sourceService, sourceProcess, existingNames)
  ));
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<CreateTab>("manual");
  const [processQuery, setProcessQuery] = useState("");
  const [processes, setProcesses] = useState<NormalizedProcessCandidate[]>([]);
  const [processesLoaded, setProcessesLoaded] = useState(false);
  const [processesLoading, setProcessesLoading] = useState(false);
  const [processError, setProcessError] = useState("");
  const [processSelectionError, setProcessSelectionError] = useState("");
  const [verifyingPid, setVerifyingPid] = useState<number | null>(null);
  const [importedProcess, setImportedProcess] = useState(sourceProcess);
  const [pendingSubmission, setPendingSubmission] = useState<ServiceCreateInput | ServiceUpdateInput | null>(null);
  const processRequestId = useRef(0);
  const processApplyRequestId = useRef(0);
  const serviceNameRef = useRef<HTMLInputElement>(null);
  const focusNameAfterImport = useRef(false);
  const copy = modeCopy[mode];
  const Icon = copy.icon;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  };

  const loadProcesses = useCallback(async (query = "") => {
    const requestId = ++processRequestId.current;
    setProcessesLoading(true);
    setProcessError("");
    try {
      const nextProcesses = await api.listProcesses(query);
      if (requestId !== processRequestId.current) return;
      setProcesses(nextProcesses);
      setProcessesLoaded(true);
    } catch (loadError) {
      if (requestId !== processRequestId.current) return;
      setProcessError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (requestId === processRequestId.current) setProcessesLoading(false);
    }
  }, [api]);

  useEffect(() => () => {
    processRequestId.current += 1;
    processApplyRequestId.current += 1;
  }, []);

  useEffect(() => {
    if (activeTab !== "manual" || !focusNameAfterImport.current) return;
    focusNameAfterImport.current = false;
    const timer = window.setTimeout(() => serviceNameRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [activeTab, importedProcess]);

  const applyProcess = async (candidate: NormalizedProcessCandidate) => {
    if (candidateBlockedReason(candidate)) return;
    const requestId = ++processApplyRequestId.current;
    setVerifyingPid(candidate.pid);
    setProcessSelectionError("");
    try {
      const current = await api.getProcess(candidate.pid);
      if (requestId !== processApplyRequestId.current) return;
      if (
        current.pid !== candidate.pid
        || (
          candidate.createTime !== null
          && current.createTime !== null
          && current.createTime !== candidate.createTime
        )
      ) {
        throw new Error(`PID ${candidate.pid} 的进程身份已变化，请刷新列表后重试`);
      }
      const blockedReason = candidateBlockedReason(current);
      if (blockedReason) throw new Error(blockedReason);
      const selectedProcess = candidate.createTime === null || current.createTime === null
        ? withManualCompletionWarning(
          current,
          `未能核验 PID ${candidate.pid} 的启动时间，请手动确认仍是目标进程。`,
        )
        : current.restorable
          ? current
          : withManualCompletionWarning(current);

      setForm(formFromInput(serviceInputFromProcess(selectedProcess, existingNames)));
      setImportedProcess(selectedProcess);
      setError("");
      focusNameAfterImport.current = true;
      setActiveTab("manual");
    } catch (applyError) {
      if (requestId !== processApplyRequestId.current) return;
      if (isProcessPermissionError(applyError)) {
        const selectedProcess = withManualCompletionWarning(
          candidate,
          "当前权限不足，无法读取完整进程信息。请手动补全启动命令和工作目录，并确认配置后再保存。",
        );
        setForm(formFromInput(serviceInputFromProcess(selectedProcess, existingNames)));
        setImportedProcess(selectedProcess);
        setError("");
        focusNameAfterImport.current = true;
        setActiveTab("manual");
        return;
      }
      setProcessSelectionError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      if (requestId === processApplyRequestId.current) setVerifyingPid(null);
    }
  };

  const runProcessSearch = () => void loadProcesses(processQuery.trim());

  const changeTab = (value: string) => {
    const nextTab = value as CreateTab;
    if (nextTab !== "process") {
      processApplyRequestId.current += 1;
      setVerifyingPid(null);
      setProcessSelectionError("");
    }
    setActiveTab(nextTab);
    if (nextTab === "process" && !processesLoaded && !processesLoading) void loadProcesses();
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    runProcessSearch();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === "create" && activeTab !== "manual") return;
    setError("");
    try {
      const definition = {
        command: form.command.trim(),
        cwd: form.cwd.trim(),
        env: parseEnvironment(form.env),
        auto_start: form.autoStart,
        stop_timeout: Number(form.stopTimeout),
      } satisfies ServiceUpdateInput;
      if (!definition.command || !definition.cwd) throw new Error("请填写启动命令和工作目录");
      if (!Number.isFinite(definition.stop_timeout) || definition.stop_timeout < 0) {
        throw new Error("停止超时必须是大于或等于 0 的数字");
      }
      const submission = mode === "edit"
        ? definition
        : { name: form.name.trim(), ...definition };
      if (mode === "create" && importedProcess) {
        setPendingSubmission(submission);
        return;
      }
      await onSubmit(submission);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  };

  const confirmImportedSubmission = async () => {
    const submission = pendingSubmission;
    if (!submission) return;
    try {
      await onSubmit(submission);
      setPendingSubmission(null);
    } catch (submitError) {
      setPendingSubmission(null);
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => !submitting && onOpenChange(nextOpen)}>
        <DialogContent className="w-[min(700px,calc(100vw-28px))] max-w-[700px] gap-0 overflow-hidden p-0">
          <form className="min-w-0 w-full" onSubmit={submit}>
          <Tabs
            className="contents"
            value={mode === "create" ? activeTab : "manual"}
            onValueChange={changeTab}
          >
            <DialogHeader className="border-b px-5 py-4 pr-14 text-left">
              <span className="text-[9px] font-bold tracking-[0.12em] text-primary uppercase">{copy.eyebrow}</span>
              <DialogTitle className="flex items-center gap-2 text-base"><Icon className="size-4" />{copy.title}</DialogTitle>
              <DialogDescription className="text-xs">{copy.description}</DialogDescription>
              {mode === "create" ? (
                <TabsList className="mt-2 w-fit" aria-label="添加服务方式">
                  <TabsTrigger value="manual"><Pencil className="size-3" />手动配置</TabsTrigger>
                  <TabsTrigger value="process"><Workflow className="size-3" />运行中进程</TabsTrigger>
                </TabsList>
              ) : null}
            </DialogHeader>

            <TabsContent value="manual" className="m-0">
              <div className="grid max-h-[min(66vh,560px)] grid-cols-2 gap-4 overflow-y-auto p-5 max-[600px]:grid-cols-1">
                {importedProcess ? (
                  <div className={`col-span-2 flex gap-2 rounded-lg border px-3 py-2.5 text-[10px] text-foreground max-[600px]:col-span-1 ${
                    importedProcess.restorable
                      ? "border-primary/25 bg-primary/5"
                      : "border-warning/30 bg-warning/5"
                  }`} role="status">
                    <CircleAlert className={`mt-0.5 size-3.5 shrink-0 ${importedProcess.restorable ? "text-primary" : "text-warning"}`} aria-hidden="true" />
                    <div>
                      {importedProcess.restorable
                        ? `已从 PID ${importedProcess.pid} 自动填入可恢复的启动配置。当前进程不会被接管；保存后请先停止原进程，再由控制台启动，避免重复实例或端口冲突。日志从首次受管启动开始采集。`
                        : `PID ${importedProcess.pid} 的自动提取信息不完整。请根据下方警告核对并手动补全启动命令、工作目录或参数；保存只会创建服务配置，不会接管当前进程。`}
                      <ProcessWarnings warnings={importedProcess.warnings} />
                    </div>
                  </div>
                ) : null}

                <label className="space-y-1.5 text-xs font-semibold">
                  <span>服务名称 <em className="not-italic text-destructive">*</em></span>
                  <Input ref={serviceNameRef} id="serviceNameInput" value={form.name} required disabled={mode === "edit"} pattern="[A-Za-z0-9._-]+" maxLength={80} placeholder="backend" aria-describedby="serviceNameHelp" onChange={(event) => update("name", event.target.value)} />
                  <small id="serviceNameHelp" className="block text-[10px] font-normal text-muted-foreground">仅使用字母、数字、点、下划线和连字符</small>
                </label>

                <label className="space-y-1.5 text-xs font-semibold">
                  <span>停止超时（秒）</span>
                  <Input type="number" min="0" max="300" step="0.1" value={form.stopTimeout} required onChange={(event) => update("stopTimeout", event.target.value)} />
                  <small className="block text-[10px] font-normal text-muted-foreground">超时后将强制结束进程组</small>
                </label>

                <label className="col-span-2 space-y-1.5 text-xs font-semibold max-[600px]:col-span-1">
                  <span>启动命令 <em className="not-italic text-destructive">*</em></span>
                  <Textarea value={form.command} rows={3} required placeholder="uv run backend/run.py" className="resize-y font-mono text-xs" onChange={(event) => update("command", event.target.value)} />
                </label>

                <label className="col-span-2 space-y-1.5 text-xs font-semibold max-[600px]:col-span-1">
                  <span>工作目录 <em className="not-italic text-destructive">*</em></span>
                  <Input value={form.cwd} required placeholder="/absolute/path/to/project" className="font-mono text-xs" onChange={(event) => update("cwd", event.target.value)} />
                </label>

                <label className="col-span-2 space-y-1.5 text-xs font-semibold max-[600px]:col-span-1">
                  <span>环境变量</span>
                  <Textarea value={form.env} rows={4} placeholder={'APP_ENV=development\nPORT=8000'} className="resize-y font-mono text-xs" onChange={(event) => update("env", event.target.value)} />
                  <small className="block text-[10px] font-normal text-muted-foreground">每行一个 KEY=VALUE，也支持 JSON 对象</small>
                </label>

                <label className="col-span-2 flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-secondary/40 p-3 max-[600px]:col-span-1">
                  <span><strong className="block text-xs">随控制台自动启动</strong><small className="mt-0.5 block text-[10px] text-muted-foreground">下次打开 Service Console 时自动运行此服务</small></span>
                  <Switch checked={form.autoStart} onCheckedChange={(checked) => update("autoStart", checked)} aria-label="随控制台自动启动" />
                </label>

                {error ? <p className="col-span-2 m-0 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive max-[600px]:col-span-1" role="alert">{error}</p> : null}
              </div>
            </TabsContent>

            {mode === "create" ? (
              <TabsContent value="process" className="m-0 min-w-0">
                <div className="flex min-w-0 max-h-[min(66vh,560px)] min-h-80 flex-col">
                  <div className="flex shrink-0 items-center gap-2 border-b px-5 py-3">
                    <label className="relative min-w-0 flex-1">
                      <span className="sr-only">搜索运行中进程</span>
                      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                      <Input className="h-8 pl-8 text-[11px]" value={processQuery} placeholder="搜索进程名称、命令或 PID" onChange={(event) => setProcessQuery(event.target.value)} onKeyDown={handleSearchKeyDown} />
                    </label>
                    <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-[10px]" disabled={processesLoading} onClick={runProcessSearch}>
                      {processesLoading ? <LoaderCircle className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}搜索
                    </Button>
                  </div>

                  <div className="no-visible-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3" aria-busy={processesLoading} aria-live="polite">
                    {processSelectionError ? (
                      <p className="mb-2 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-[10px] text-destructive" role="alert">
                        {processSelectionError}
                      </p>
                    ) : null}
                    {processError ? (
                      <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center text-muted-foreground" role="alert">
                        <CircleAlert className="size-7 text-destructive" aria-hidden="true" /><strong className="text-xs text-foreground">读取进程失败</strong><span className="max-w-md text-[10px]">{processError}</span>
                        <Button type="button" variant="outline" size="sm" onClick={runProcessSearch}>重试</Button>
                      </div>
                    ) : processesLoading && !processesLoaded ? (
                      <div className="flex min-h-48 items-center justify-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在扫描运行中进程…</div>
                    ) : processes.length ? (
                      <div className="min-w-0 space-y-1" role="list" aria-label="运行中进程">
                        {processes.map((candidate) => {
                          const blockedReason = candidateBlockedReason(candidate);
                          const needsManualCompletion = !candidate.restorable;
                          return (
                            <article key={`${candidate.pid}-${candidate.createTime ?? "unknown"}`} className="grid w-full min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2 transition-colors hover:bg-accent/35" role="listitem">
                              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground" aria-hidden="true"><Workflow className="size-4" /></span>
                              <div className="min-w-0 overflow-hidden">
                                <div className="flex min-w-0 flex-wrap items-center gap-1.5"><strong className="min-w-0 truncate text-[11px]" title={candidate.processName}>{candidate.processName}</strong><Badge variant="outline" className="h-4 rounded px-1 font-mono text-[8px]">PID {candidate.pid}</Badge>{candidate.ports.length ? <Badge variant="secondary" className="h-4 max-w-full rounded px-1 text-[8px]"><Network className="mr-0.5 size-2.5" /><span className="truncate">{candidate.ports.join(", ")}</span></Badge> : null}</div>
                                <code className="mt-0.5 block truncate text-[9px] text-muted-foreground" title={candidate.command || "命令不可用"}>{candidate.command || "命令不可用"}</code>
                                <span className="mt-0.5 block truncate text-[9px] text-muted-foreground" title={candidate.cwd || blockedReason || undefined}>
                                  {blockedReason ?? (candidate.cwd || (needsManualCompletion ? "需手动补全启动信息" : ""))}
                                </span>
                                <ProcessWarnings warnings={candidate.warnings} />
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 shrink-0 px-2 text-[9px]"
                                disabled={Boolean(blockedReason) || verifyingPid !== null}
                                aria-label={blockedReason
                                  ? `${candidate.processName} 不可导入：${blockedReason}`
                                  : verifyingPid === candidate.pid
                                    ? `正在核验 ${candidate.processName}`
                                    : needsManualCompletion
                                      ? `手动补全 ${candidate.processName} 的配置`
                                      : `填入 ${candidate.processName} 的配置`}
                                onClick={() => void applyProcess(candidate)}
                              >
                                {verifyingPid === candidate.pid ? <LoaderCircle className="size-3 animate-spin" /> : <Plus className="size-3" />}
                                {verifyingPid === candidate.pid ? "核验中" : needsManualCompletion ? "手动补全" : "填入配置"}
                              </Button>
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex min-h-48 flex-col items-center justify-center gap-1 text-muted-foreground"><Workflow className="mb-1 size-8" strokeWidth={1.4} aria-hidden="true" /><strong className="text-xs text-foreground">没有找到匹配的进程</strong><span className="text-[10px]">调整关键词后重新搜索</span></div>
                    )}
                  </div>
                </div>
              </TabsContent>
            ) : null}

            <DialogFooter className="border-t bg-secondary/25 px-5 py-3">
              <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>取消</Button>
              {mode !== "create" || activeTab === "manual" ? <Button type="submit" disabled={submitting}>{submitting ? "保存中…" : copy.submit}</Button> : null}
            </DialogFooter>
            </Tabs>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(pendingSubmission)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !submitting) setPendingSubmission(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{importedProcess?.restorable ? "仅保存服务配置？" : "保存手动补全的服务配置？"}</AlertDialogTitle>
            <AlertDialogDescription>
              {importedProcess?.restorable
                ? `PID ${importedProcess.pid} 的原进程仍在运行。继续只会保存启动配置，不会接管、停止或采集该进程的既有日志。请先停止原进程，再从控制台启动服务，避免重复实例。`
                : `PID ${importedProcess?.pid ?? "—"} 的配置未能完整自动核验。继续会保存你手动确认后的启动配置，不会接管、停止或采集原进程的既有日志。请确认命令和工作目录无误，并在受管启动前停止原进程。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={submitting}
              onClick={(event) => {
                event.preventDefault();
                void confirmImportedSubmission();
              }}
            >
              {submitting ? "保存中…" : "仅保存配置"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
