"use client";

import {
  Copy,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getServiceActionDisabled } from "@/lib/service-logic";
import type { NormalizedService, ServiceAction } from "@/lib/types";
import { cn } from "@/lib/cn";

interface ServiceActionsProps {
  service: NormalizedService;
  busy: boolean;
  onAction: (action: ServiceAction) => void;
}

interface ActionButtonProps {
  action: ServiceAction;
  label: string;
  disabled: boolean;
  disabledReason?: string;
  icon: typeof Play;
  tone?: "default" | "danger";
  onAction: (action: ServiceAction) => void;
}

function ActionButton({
  action,
  label,
  disabled,
  disabledReason,
  icon: Icon,
  tone = "default",
  onAction,
}: ActionButtonProps) {
  const reasonId = useId();

  return (
    <>
      <Button
        className={cn(
          "h-7 gap-1.5 rounded-md px-2 text-[11px] shadow-none",
          tone === "danger" && !disabled && "text-destructive hover:bg-destructive/10 hover:text-destructive",
        )}
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-disabled={disabled}
        aria-describedby={disabledReason ? reasonId : undefined}
        data-action={action}
        onClick={() => onAction(action)}
      >
        <Icon className="size-3.5" />
        <span>{label}</span>
      </Button>
      {disabledReason ? <span id={reasonId} className="sr-only">{label}不可用：{disabledReason}</span> : null}
    </>
  );
}

function disabledReason(
  action: "start" | "stop" | "restart",
  service: NormalizedService,
  busy: boolean,
): string | undefined {
  if (busy) return "正在处理上一项操作";
  if (service.status === "UNKNOWN") return "服务状态未知";
  if (action === "start") {
    if (service.status === "RUNNING") return "服务已在运行";
    if (service.status === "STARTING") return "服务正在启动";
    if (service.status === "STOPPING") return "服务正在停止";
  }
  if (action === "stop") {
    if (service.status === "STOPPING") return "服务正在停止";
    if (["STOPPED", "EXITED", "FAILED"].includes(service.status)) return "服务当前未运行";
  }
  if (action === "restart") {
    if (service.status === "STARTING") return "服务正在启动";
    if (service.status === "STOPPING") return "服务正在停止";
  }
  return undefined;
}

export function ServiceLifecycleToolbar({ service, busy, onAction }: ServiceActionsProps) {
  const disabled = getServiceActionDisabled(service.status, busy);

  return (
    <div
      className="flex items-center rounded-lg border bg-secondary/35 p-0.5"
      role="toolbar"
      aria-label="服务生命周期操作"
      aria-busy={busy}
    >
      <ActionButton
        action="start"
        label="启动"
        icon={Play}
        disabled={disabled.start}
        disabledReason={disabledReason("start", service, busy)}
        onAction={onAction}
      />
      <ActionButton
        action="stop"
        label="停止"
        icon={Square}
        disabled={disabled.stop}
        disabledReason={disabledReason("stop", service, busy)}
        tone="danger"
        onAction={onAction}
      />
      <ActionButton
        action="restart"
        label="重启"
        icon={RotateCw}
        disabled={disabled.restart}
        disabledReason={disabledReason("restart", service, busy)}
        onAction={onAction}
      />
      {busy ? (
        <span className="flex h-7 items-center gap-1 border-l px-2 text-[10px] text-muted-foreground" role="status">
          <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
          处理中
        </span>
      ) : null}
    </div>
  );
}

interface ServiceActionsMenuProps extends ServiceActionsProps {
  includeLifecycle?: boolean;
  align?: "start" | "center" | "end";
  triggerClassName?: string;
  triggerLabel?: string;
}

export function ServiceActionsMenu({
  service,
  busy,
  onAction,
  includeLifecycle = true,
  align = "end",
  triggerClassName,
  triggerLabel = `打开 ${service.name} 操作菜单`,
}: ServiceActionsMenuProps) {
  const disabled = getServiceActionDisabled(service.status, busy);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={cn("size-7 rounded-md text-muted-foreground shadow-none", triggerClassName)}
          variant="ghost"
          size="icon-sm"
          aria-label={triggerLabel}
          title="更多操作"
          onClick={(event) => event.stopPropagation()}
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <MoreHorizontal className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuLabel>{service.name}</DropdownMenuLabel>
        {includeLifecycle ? (
          <>
            <DropdownMenuItem disabled={disabled.start} onSelect={() => onAction("start")}>
              <Play className="size-3.5" />启动
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled.stop} onSelect={() => onAction("stop")}>
              <Square className="size-3.5" />停止
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled.restart} onSelect={() => onAction("restart")}>
              <RotateCw className="size-3.5" />重启
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem disabled={disabled.edit} onSelect={() => onAction("edit")}>
          <Pencil className="size-3.5" />编辑配置
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled.copy} onSelect={() => onAction("copy")}>
          <Copy className="size-3.5" />复制服务
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          disabled={disabled.delete}
          onSelect={() => onAction("delete")}
        >
          <Trash2 className="size-3.5" />删除服务
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
