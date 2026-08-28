"use client";

import { CircleAlert, Network, Search, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

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
import { Input } from "@/components/ui/input";
import { usePorts } from "@/hooks/use-ports";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { NormalizedPortRow } from "@/lib/types";

interface PortsViewProps {
  api: ServiceConsoleApiClient;
  active: boolean;
  onError: (title: string, message: string) => void;
  onSuccess: (title: string, message: string) => void;
  refreshSignal: number;
}

export function PortsView({ api, active, onError, onSuccess, refreshSignal }: PortsViewProps) {
  const { ports, filter, loading, loaded, busyPids, setFilter, loadPorts, terminate } = usePorts({ api, active, onError });
  const [filterInput, setFilterInput] = useState("");
  const [target, setTarget] = useState<NormalizedPortRow | null>(null);
  const [forceTarget, setForceTarget] = useState<NormalizedPortRow | null>(null);

  const processCount = useMemo(
    () => new Set(ports.map((item) => item.pid).filter((pid): pid is number => pid !== null)).size,
    [ports],
  );

  useEffect(() => {
    if (!active || refreshSignal <= 0) return;
    const timer = window.setTimeout(() => void loadPorts(), 0);
    return () => window.clearTimeout(timer);
  }, [active, loadPorts, refreshSignal]);

  const applyFilter = (event: FormEvent) => {
    event.preventDefault();
    const value = filterInput.trim();
    setFilter(value ? Number(value) : null);
  };

  const confirmTerminate = async (item: NormalizedPortRow, force: boolean) => {
    try {
      const outcome = await terminate(item, force);
      if (outcome.needsForce) {
        setForceTarget(item);
        return;
      }
      if (outcome.terminated) onSuccess("进程已终止", `PID ${item.pid} 已释放端口 ${item.port}`);
      else onError("进程仍在运行", `PID ${item.pid} 未退出，请刷新状态后重试`);
    } catch (error) {
      onError(force ? "强制结束失败" : "终止进程失败", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main id="portsView" className="flex min-h-0 min-w-0 flex-1 p-2.5" aria-labelledby="portsHeading">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card shadow-[var(--shadow-panel)]">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3 max-[720px]:items-start max-[720px]:flex-col">
          <div>
            <span className="text-[9px] font-bold tracking-[0.12em] text-primary uppercase">系统监听端口</span>
            <div className="mt-0.5 flex items-center gap-2">
              <h2 id="portsHeading" className="text-base font-bold">端口与进程</h2>
              <Badge variant="secondary">{ports.length}</Badge>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {filter !== null
                ? ports.length ? `端口 ${filter}：${ports.length} 条记录，涉及 ${processCount} 个进程` : `端口 ${filter} 当前没有监听进程`
                : `${ports.length} 条监听记录 · ${processCount} 个进程`}
            </p>
          </div>

          <form className="flex items-end gap-1.5" role="search" onSubmit={applyFilter}>
            <label className="space-y-1 text-[10px] font-semibold text-muted-foreground">
              <span className="block">按端口筛选</span>
              <Input className="h-8 w-36 text-xs" type="number" min="1" max="65535" inputMode="numeric" value={filterInput} placeholder="例如 8000" onChange={(event) => setFilterInput(event.target.value)} />
            </label>
            <Button variant="outline" size="sm" type="submit"><Search className="size-3.5" />查询</Button>
            <Button variant="ghost" size="sm" type="button" disabled={filter === null} onClick={() => { setFilterInput(""); setFilter(null); }}>清除</Button>
          </form>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-warning/25 bg-warning/10 px-4 py-2 text-[11px] text-warning" role="note">
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span>终止进程会同时释放该进程占用的其他端口。请先核对 PID 和命令。</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto" aria-busy={loading} aria-live="polite">
          <table className="w-full min-w-[900px] table-fixed border-collapse text-left text-[11px]">
            <thead className="sticky top-0 z-10 bg-secondary text-[9px] tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="w-16 px-3 py-2">协议</th>
                <th className="w-36 px-3 py-2">监听地址</th>
                <th className="w-20 px-3 py-2">端口</th>
                <th className="w-20 px-3 py-2">PID</th>
                <th className="w-36 px-3 py-2">进程</th>
                <th className="px-3 py-2">命令</th>
                <th className="w-28 px-3 py-2">用户</th>
                <th className="w-24 px-3 py-2"><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {ports.map((item, index) => (
                <tr key={`${item.protocol}-${item.localAddress}-${item.port}-${item.pid ?? "unknown"}-${index}`} className="border-t hover:bg-accent/30">
                  <td className="px-3 py-2"><Badge variant="outline" className="font-mono text-[9px] uppercase">{item.protocol}</Badge></td>
                  <td className="truncate px-3 py-2 font-mono text-muted-foreground" title={item.localAddress}>{item.localAddress}</td>
                  <td className="px-3 py-2 font-mono font-bold text-primary">{item.port}</td>
                  <td className="px-3 py-2 font-mono">{item.pid ?? "—"}</td>
                  <td className="truncate px-3 py-2 font-semibold" title={item.processName}>{item.processName}</td>
                  <td className="truncate px-3 py-2 font-mono text-[10px] text-muted-foreground" title={item.command}>{item.command || "—"}</td>
                  <td className="truncate px-3 py-2 text-muted-foreground" title={item.username}>{item.username || "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="outline" size="sm" className="h-7 text-[9px] text-destructive" disabled={item.pid === null || (item.pid !== null && busyPids.has(item.pid))} onClick={() => setTarget(item)}>
                      <Trash2 className="size-3" />终止
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!ports.length ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-1 text-muted-foreground">
              <Network className="mb-1 size-8" strokeWidth={1.4} aria-hidden="true" />
              <strong className="text-xs text-secondary-foreground">{loading && !loaded ? "正在扫描监听端口…" : filter !== null ? "该端口未被占用" : "没有发现监听端口"}</strong>
              <span className="text-[10px]">{filter !== null ? "清除筛选条件可查看全部监听记录" : "点击刷新后重新扫描"}</span>
            </div>
          ) : null}
        </div>
      </section>

      <AlertDialog open={Boolean(target)} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>终止进程 {target?.processName}</AlertDialogTitle>
            <AlertDialogDescription>
              PID {target?.pid} 正在监听 {target?.localAddress}:{target?.port}。终止后，该进程占用的其他端口也会被释放。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { const item = target; setTarget(null); if (item) void confirmTerminate(item, false); }}>终止进程</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(forceTarget)} onOpenChange={(open) => !open && setForceTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>进程未在 3 秒内退出</AlertDialogTitle>
            <AlertDialogDescription>是否强制结束 PID {forceTarget?.pid}？未保存的数据可能丢失。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留进程</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { const item = forceTarget; setForceTarget(null); if (item) void confirmTerminate(item, true); }}>强制结束</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
