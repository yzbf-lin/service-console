"use client";

import { FlaskConical, LoaderCircle } from "lucide-react";
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
import type { JenkinsInstance, JenkinsInstanceInput } from "@/lib/types";

export type JenkinsInstanceDialogMode = "create" | "edit" | "copy";

interface JenkinsInstanceDialogProps {
  mode: JenkinsInstanceDialogMode;
  open: boolean;
  source: JenkinsInstance | null;
  submitting: boolean;
  testing: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: JenkinsInstanceInput) => Promise<void>;
  onTest: (() => Promise<void>) | null;
}

interface FormState {
  name: string;
  baseUrl: string;
  username: string;
  token: string;
  caBundle: string;
  enabled: boolean;
  requestTimeout: string;
}

function initialState(mode: JenkinsInstanceDialogMode, source: JenkinsInstance | null): FormState {
  return {
    name: mode === "copy" && source ? `${source.name} 副本` : source?.name ?? "",
    baseUrl: source?.baseUrl ?? "",
    username: source?.username ?? "",
    token: "",
    caBundle: source?.caBundle ?? "",
    enabled: source?.enabled ?? true,
    requestTimeout: String(source?.requestTimeout ?? 15),
  };
}

export function JenkinsInstanceDialog({
  mode,
  open,
  source,
  submitting,
  testing,
  onOpenChange,
  onSubmit,
  onTest,
}: JenkinsInstanceDialogProps) {
  const [form, setForm] = useState<FormState>(() => initialState(mode, source));

  const title = mode === "edit" ? "编辑 Jenkins" : mode === "copy" ? "复制 Jenkins" : "添加 Jenkins";
  const tokenHint = mode === "edit" && source?.tokenPresent
    ? "Token 已安全保存；留空表示继续使用现有 Token。"
    : mode === "copy"
      ? "复制不会带出原实例 Token，请为副本重新填写。"
      : "推荐使用 Jenkins API Token，不要填写账户密码。";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input: JenkinsInstanceInput = {
      name: form.name.trim(),
      base_url: form.baseUrl.trim().replace(/\/+$/, ""),
      username: form.username.trim(),
      ca_bundle: form.caBundle.trim(),
      enabled: form.enabled,
      request_timeout: Number(form.requestTimeout),
    };
    if (form.token) input.token = form.token;
    void onSubmit(input);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !submitting && !testing && onOpenChange(nextOpen)}>
      <DialogContent className="max-w-xl gap-3 p-5">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            每个实例独立保存地址与凭据；Token 仅发送到本地控制器且不会回显。
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={submit}>
          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <label className="grid gap-1 text-[11px] font-medium">
              显示名称
              <Input className="h-8 text-xs" required autoFocus value={form.name} placeholder="测试 Jenkins" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="grid gap-1 text-[11px] font-medium">
              请求超时（秒）
              <Input className="h-8 text-xs" type="number" min="1" max="120" required value={form.requestTimeout} onChange={(event) => setForm((current) => ({ ...current, requestTimeout: event.target.value }))} />
            </label>
          </div>

          <label className="grid gap-1 text-[11px] font-medium">
            Jenkins 地址
            <Input className="h-8 font-mono text-xs" type="url" required value={form.baseUrl} placeholder="https://jenkins.example.com" onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} />
          </label>
          <p className="-mt-1 text-[10px] text-muted-foreground">
            优先使用 HTTPS；HTTP 会以明文 Basic Auth 传输 API Token，仅适合受信任网络。
          </p>

          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <label className="grid gap-1 text-[11px] font-medium">
              用户名
              <Input className="h-8 text-xs" required autoComplete="username" value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} />
            </label>
            <label className="grid gap-1 text-[11px] font-medium">
              API Token
              <Input
                className="h-8 font-mono text-xs"
                type="password"
                autoComplete="new-password"
                value={form.token}
                placeholder={source?.tokenPresent && mode === "edit" ? "留空保持不变" : "输入 API Token"}
                required={mode !== "edit" || !source?.tokenPresent}
                onChange={(event) => setForm((current) => ({ ...current, token: event.target.value }))}
              />
            </label>
          </div>
          <p className="-mt-1 text-[10px] text-muted-foreground">{tokenHint}</p>

          <label className="grid gap-1 text-[11px] font-medium">
            CA 证书文件路径（可选）
            <Textarea className="min-h-16 resize-y font-mono text-[10px]" value={form.caBundle} placeholder="例如 C:\\certs\\company-ca.pem；使用系统信任链时留空" onChange={(event) => setForm((current) => ({ ...current, caBundle: event.target.value }))} />
          </label>

          <label className="flex items-center justify-between gap-3 rounded-lg border bg-muted/25 px-3 py-2 text-[11px]">
            <span>
              <span className="block font-medium">启用实例</span>
              <span className="text-[10px] text-muted-foreground">关闭后保留配置，但不加载任务。</span>
            </span>
            <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm((current) => ({ ...current, enabled }))} aria-label="启用 Jenkins 实例" />
          </label>

          <DialogFooter className="mt-1">
            {onTest ? (
              <Button className="mr-auto" type="button" variant="outline" size="sm" disabled={submitting || testing} onClick={() => void onTest()}>
                {testing ? <LoaderCircle className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                测试已保存连接
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" disabled={submitting || testing} onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" size="sm" disabled={submitting || testing}>
              {submitting ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {mode === "edit" ? "保存修改" : mode === "copy" ? "创建副本" : "添加实例"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
