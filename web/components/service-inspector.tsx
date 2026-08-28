"use client";

import {
  Activity,
  Braces,
  Clock3,
  Cpu,
  Folder,
  Gauge,
  MemoryStick,
  Power,
  Repeat2,
  TerminalSquare,
} from "lucide-react";

import { ServiceActionsMenu } from "@/components/service-actions";
import {
  currentUptime,
  formatBytes,
  formatDuration,
  formatPercent,
  statusLabel,
} from "@/lib/service-logic";
import type { NormalizedService, ServiceAction } from "@/lib/types";
import { cn } from "@/lib/cn";

interface ServiceInspectorProps {
  service: NormalizedService | null;
  busy: boolean;
  onAction: (action: ServiceAction) => void;
}

const statusDotClasses: Record<NormalizedService["status"], string> = {
  RUNNING: "bg-success",
  STARTING: "bg-warning animate-pulse",
  STOPPING: "bg-warning animate-pulse",
  FAILED: "bg-destructive",
  EXITED: "bg-violet-500",
  STOPPED: "bg-muted-foreground/65",
  UNKNOWN: "bg-muted-foreground/65",
};

function InspectorRow({ icon: Icon, label, value }: { icon: typeof Gauge; label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-2.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden="true" />
      <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 max-w-[58%] truncate text-right font-mono text-[11px] font-medium" title={typeof value === "string" ? value : undefined}>{value}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1 text-[10px] font-semibold tracking-wide text-muted-foreground">{children}</h3>;
}

export function ServiceInspector({ service, busy, onAction }: ServiceInspectorProps) {
  return (
    <aside className="service-inspector flex min-h-0 flex-col border-l bg-[var(--inspector)]" aria-label="服务详情">
      <header className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <h2 className="text-[12px] font-semibold">详情</h2>
        {service ? (
          <ServiceActionsMenu
            service={service}
            busy={busy}
            includeLifecycle={false}
            onAction={onAction}
            triggerLabel={`打开 ${service.name} 配置菜单`}
          />
        ) : null}
      </header>

      {service ? (
        <div className="no-visible-scrollbar min-h-0 flex-1 overflow-y-auto">
          <section className="border-b px-3 py-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", statusDotClasses[service.status])} aria-hidden="true" />
              <div className="min-w-0">
                <strong className="block truncate text-[13px] font-semibold" title={service.name}>{service.name}</strong>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">{busy ? "正在处理操作" : statusLabel(service.status)}</span>
              </div>
            </div>
          </section>

          <section className="border-b px-3 py-3">
            <SectionLabel>运行状态</SectionLabel>
            <InspectorRow icon={Power} label="PID" value={service.pid ?? "—"} />
            <InspectorRow icon={Clock3} label="运行时长" value={formatDuration(currentUptime(service))} />
            <InspectorRow icon={Cpu} label="CPU" value={formatPercent(service.cpuPercent)} />
            <InspectorRow
              icon={MemoryStick}
              label="内存"
              value={service.memoryBytes !== null ? formatBytes(service.memoryBytes) : formatPercent(service.memoryPercent)}
            />
            <InspectorRow icon={Repeat2} label="重启次数" value={service.restartCount ?? 0} />
            <InspectorRow icon={Activity} label="退出码" value={service.exitCode ?? "—"} />
          </section>

          <section className="border-b px-3 py-3">
            <SectionLabel>启动配置</SectionLabel>
            <div className="mb-2">
              <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground"><TerminalSquare className="size-3.5" />命令</div>
              <code className="block break-words rounded-md bg-secondary/55 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-secondary-foreground">{service.command}</code>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground"><Folder className="size-3.5" />工作目录</div>
              <code className="block break-all rounded-md bg-secondary/55 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-secondary-foreground">{service.cwd}</code>
            </div>
          </section>

          <section className="px-3 py-3">
            <SectionLabel>行为</SectionLabel>
            <InspectorRow icon={Power} label="自动启动" value={service.autoStart ? "已开启" : "已关闭"} />
            <InspectorRow icon={Clock3} label="停止超时" value={`${service.stopTimeout}s`} />
            <InspectorRow icon={Braces} label="环境变量" value={Object.keys(service.env).length} />
          </section>

          {service.lastError ? (
            <section className="mx-3 mb-3 rounded-md border border-destructive/30 bg-destructive/8 px-2.5 py-2 text-[10px] leading-relaxed text-destructive">
              {service.lastError}
            </section>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 text-center text-muted-foreground">
          <Gauge className="mb-2 size-7" strokeWidth={1.4} aria-hidden="true" />
          <strong className="text-[12px] text-secondary-foreground">未选择服务</strong>
          <span className="mt-1 text-[11px]">从左侧选择服务查看详情</span>
        </div>
      )}
    </aside>
  );
}
