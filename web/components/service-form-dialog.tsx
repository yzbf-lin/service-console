"use client";

import { Copy, Pencil, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { nextCopyName, parseEnvironment, serializeEnvironment } from "@/lib/service-logic";
import type { NormalizedService, ServiceCreateInput, ServiceUpdateInput } from "@/lib/types";

export type ServiceFormMode = "create" | "edit" | "copy";

interface ServiceFormDialogProps {
  open: boolean;
  mode: ServiceFormMode;
  sourceService: NormalizedService | null;
  existingNames: string[];
  submitting: boolean;
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
    description: "命令会在指定工作目录中直接启动，不经过容器。",
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

function initialForm(
  mode: ServiceFormMode,
  sourceService: NormalizedService | null,
  existingNames: string[],
): FormState {
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

export function ServiceFormDialog({
  open,
  mode,
  sourceService,
  existingNames,
  submitting,
  onOpenChange,
  onSubmit,
}: ServiceFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => initialForm(mode, sourceService, existingNames));
  const [error, setError] = useState("");
  const copy = modeCopy[mode];
  const Icon = copy.icon;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
      if (mode === "edit") await onSubmit(definition);
      else await onSubmit({ name: form.name.trim(), ...definition });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !submitting && onOpenChange(nextOpen)}>
      <DialogContent className="w-[min(650px,calc(100vw-28px))] max-w-[650px] gap-0 overflow-hidden p-0">
        <form onSubmit={submit}>
          <DialogHeader className="border-b px-5 py-4 pr-14 text-left">
            <span className="text-[9px] font-bold tracking-[0.12em] text-primary uppercase">{copy.eyebrow}</span>
            <DialogTitle className="flex items-center gap-2 text-base"><Icon className="size-4" />{copy.title}</DialogTitle>
            <DialogDescription className="text-xs">{copy.description}</DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[min(66vh,560px)] grid-cols-2 gap-4 overflow-y-auto p-5 max-[600px]:grid-cols-1">
            <label className="space-y-1.5 text-xs font-semibold">
              <span>服务名称 <em className="not-italic text-destructive">*</em></span>
              <Input
                id="serviceNameInput"
                value={form.name}
                required
                disabled={mode === "edit"}
                pattern="[A-Za-z0-9._-]+"
                maxLength={80}
                placeholder="backend"
                aria-describedby="serviceNameHelp"
                onChange={(event) => update("name", event.target.value)}
              />
              <small id="serviceNameHelp" className="block text-[10px] font-normal text-muted-foreground">仅使用字母、数字、点、下划线和连字符</small>
            </label>

            <label className="space-y-1.5 text-xs font-semibold">
              <span>停止超时（秒）</span>
              <Input
                type="number"
                min="0"
                max="300"
                step="0.1"
                value={form.stopTimeout}
                required
                onChange={(event) => update("stopTimeout", event.target.value)}
              />
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
              <span>
                <strong className="block text-xs">随控制台自动启动</strong>
                <small className="mt-0.5 block text-[10px] text-muted-foreground">下次打开 Service Console 时自动运行此服务</small>
              </span>
              <Switch checked={form.autoStart} onCheckedChange={(checked) => update("autoStart", checked)} aria-label="随控制台自动启动" />
            </label>

            {error ? <p className="col-span-2 m-0 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive max-[600px]:col-span-1" role="alert">{error}</p> : null}
          </div>

          <DialogFooter className="border-t bg-secondary/25 px-5 py-3">
            <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={submitting}>{submitting ? "保存中…" : copy.submit}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
