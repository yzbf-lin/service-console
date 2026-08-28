"use client";

import { ChevronRight, CircleAlert, LoaderCircle, Network, Plus, Search, Trash2 } from "lucide-react";
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
  onImportProcess: (pid: number) => Promise<void>;
  refreshSignal: number;
}
interface PortGroup {
  key: string;
  pid: number | null;
  rows: NormalizedPortRow[];
  ports: number[];
  processName: string;
  command: string;
  username: string;
}

interface TerminationTarget {
  group: PortGroup;
  expectedPort: number;
}

function buildPortGroups(rows: NormalizedPortRow[]): PortGroup[] {
  const groupedRows: Array<{ key: string; pid: number | null; rows: NormalizedPortRow[] }> = [];
  const pidIndexes = new Map<number, number>();

  rows.forEach((row, index) => {
    if (row.pid === null) {
      groupedRows.push({ key: "unknown-" + index, pid: null, rows: [row] });
      return;
    }

    const existingIndex = pidIndexes.get(row.pid);
    if (existingIndex !== undefined) {
      groupedRows[existingIndex]?.rows.push(row);
      return;
    }

    pidIndexes.set(row.pid, groupedRows.length);
    groupedRows.push({ key: "pid-" + row.pid, pid: row.pid, rows: [row] });
  });

  return groupedRows.map((group) => {
    const sortedRows = [...group.rows].sort(
      (left, right) => left.port - right.port
        || left.protocol.localeCompare(right.protocol)
        || left.localAddress.localeCompare(right.localAddress),
    );
    const primaryRow = sortedRows.find((row) => row.processName !== "未知进程") ?? sortedRows[0];
    const command = sortedRows.find((row) => row.command)?.command ?? "";
    const username = sortedRows.find((row) => row.username && row.username !== "—")?.username
      ?? primaryRow?.username
      ?? "—";

    return {
      ...group,
      rows: sortedRows,
      ports: [...new Set(sortedRows.map((row) => row.port))].sort((left, right) => left - right),
      processName: primaryRow?.processName || "未知进程",
      command,
      username,
    };
  });
}

function formatPortSet(ports: number[]): string {
  return ports.length ? ports.join("、") : "—";
}

export function PortsView({ api, active, onError, onSuccess, onImportProcess, refreshSignal }: PortsViewProps) {
  const { ports, filter, loading, loaded, busyPids, setFilter, loadPorts, terminate } = usePorts({ api, active, onError });
  const [filterInput, setFilterInput] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [preparingPid, setPreparingPid] = useState<number | null>(null);
  const [importingPid, setImportingPid] = useState<number | null>(null);
  const [target, setTarget] = useState<TerminationTarget | null>(null);
  const [forceTarget, setForceTarget] = useState<TerminationTarget | null>(null);

  const portGroups = useMemo(() => buildPortGroups(ports), [ports]);
  const processCount = useMemo(
    () => new Set(ports.map((item) => item.pid).filter((pid): pid is number => pid !== null)).size,
    [ports],
  );
  const unknownCount = useMemo(() => ports.filter((item) => item.pid === null).length, [ports]);

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

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openTerminateDialog = async (group: PortGroup) => {
    const expectedPort = group.rows[0]?.port;
    if (group.pid === null || expectedPort === undefined) return;
    setPreparingPid(group.pid);
    try {
      const completeGroup = buildPortGroups(await api.listPorts(null))
        .find((item) => item.pid === group.pid);
      const expectedRow = completeGroup?.rows.find((row) => row.port === expectedPort);

      if (!completeGroup || !expectedRow) {
        onError(
          "进程状态已变化",
          "PID " + group.pid + " 已不再监听端口 " + expectedPort + "，终止操作已取消，请刷新后重试",
        );
        void loadPorts({ silent: true });
        return;
      }
      setTarget({ group: completeGroup, expectedPort });
    } catch (error) {
      onError("核对进程端口失败", error instanceof Error ? error.message : String(error));
    } finally {
      setPreparingPid(null);
    }
  };

  const confirmTerminate = async (terminationTarget: TerminationTarget, force: boolean) => {
    const { group, expectedPort } = terminationTarget;
    const item = group.rows.find((row) => row.port === expectedPort);
    if (!item) {
      onError(
        "进程状态已变化",
        "PID " + group.pid + " 已不再监听端口 " + expectedPort + "，终止操作已取消，请刷新后重试",
      );
      return;
    }

    try {
      const outcome = await terminate(item, force);
      if (outcome.needsForce) {
        setForceTarget(terminationTarget);
        return;
      }
      if (outcome.terminated) {
        onSuccess("进程已终止", "PID " + group.pid + " 已释放端口 " + formatPortSet(group.ports));
      } else {
        onError("进程仍在运行", "PID " + group.pid + " 未退出，请刷新状态后重试");
      }
    } catch (error) {
      onError(force ? "强制结束失败" : "终止进程失败", error instanceof Error ? error.message : String(error));
    }
  };

  const importProcess = async (group: PortGroup) => {
    if (group.pid === null) return;
    setImportingPid(group.pid);
    try {
      await onImportProcess(group.pid);
    } catch (error) {
      onError("读取进程失败", error instanceof Error ? error.message : String(error));
    } finally {
      setImportingPid(null);
    }
  };

  return (
    <main id="portsView" className="flex min-h-0 min-w-0 flex-1 bg-background" aria-labelledby="portsHeading">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-card/80 px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 id="portsHeading" className="shrink-0 text-sm font-semibold tracking-tight">端口与进程</h2>
            <Badge variant="secondary" className="h-5 rounded-md px-1.5 text-[10px]">{portGroups.length} 组</Badge>
            <span className="truncate text-[10px] text-muted-foreground max-[840px]:hidden">
              {filter !== null
                ? "端口 " + filter + " · " + ports.length + " 条监听记录"
                : ports.length + " 条监听记录 · " + processCount + " 个进程"
                  + (unknownCount ? " · " + unknownCount + " 条未识别" : "")}
            </span>
          </div>

          <form className="flex shrink-0 items-center gap-1.5" role="search" onSubmit={applyFilter}>
            <label className="relative block">
              <span className="sr-only">按端口筛选</span>
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                className="h-7 w-32 pl-7 text-[11px] max-[640px]:w-24"
                type="number"
                min="1"
                max="65535"
                inputMode="numeric"
                value={filterInput}
                placeholder="筛选端口"
                onChange={(event) => setFilterInput(event.target.value)}
              />
            </label>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-[10px]" type="submit">查询</Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[10px]"
              type="button"
              disabled={filter === null}
              onClick={() => {
                setFilterInput("");
                setFilter(null);
              }}
            >
              清除
            </Button>
          </form>
        </header>

        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-warning/20 bg-warning/5 px-4 text-[10px] text-warning" role="note">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          <span>终止操作按 PID 生效；确认前会核对该进程占用的完整端口集合。</span>
        </div>

        <div className="no-visible-scrollbar min-h-0 flex-1 overflow-auto" aria-busy={loading} aria-live="polite">
          {portGroups.length ? (
            <div className="min-w-[700px]">
              <div
                className="sticky top-0 z-10 grid h-8 grid-cols-[minmax(220px,1.35fr)_minmax(96px,.55fr)_minmax(210px,1.15fr)_64px_72px] items-center border-b bg-secondary/95 text-[9px] font-semibold tracking-[0.08em] text-muted-foreground uppercase backdrop-blur"
              >
                <span className="px-3">进程</span>
                <span className="px-3">用户</span>
                <span className="px-3">监听端口</span>
                <span className="px-3">PID</span>
                <span className="sticky right-0 h-full border-l bg-secondary/95 px-2 text-right leading-8">操作</span>
              </div>

              <div role="list" aria-label="按进程聚合的监听端口">
                {portGroups.map((group) => {
                  const expanded = expandedGroups.has(group.key);
                  const busy = group.pid !== null && busyPids.has(group.pid);
                  const preparing = group.pid !== null && preparingPid === group.pid;

                  return (
                    <div key={group.key} role="listitem" className="border-b last:border-b-0">
                      <div className="group flex min-h-11 items-stretch transition-colors hover:bg-accent/35">
                        <button
                          type="button"
                          className="grid min-w-0 flex-1 grid-cols-[minmax(220px,1.35fr)_minmax(96px,.55fr)_minmax(210px,1.15fr)_64px] items-center text-left outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/80"
                          aria-expanded={expanded}
                          aria-controls={group.key + "-details"}
                          aria-label={
                            (expanded ? "收起 " : "展开 ")
                            + group.processName
                            + "，PID " + (group.pid ?? "未知")
                            + "，监听端口 " + formatPortSet(group.ports)
                            + " 的监听明细"
                          }
                          onClick={() => toggleGroup(group.key)}
                        >
                          <span className="flex min-w-0 items-center gap-2 px-3 py-1.5">
                            <ChevronRight
                              className={[
                                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                                expanded ? "rotate-90" : "",
                              ].join(" ")}
                              aria-hidden="true"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-[11px] font-semibold text-foreground" title={group.processName}>{group.processName}</span>
                              <span className="block truncate font-mono text-[9px] text-muted-foreground" title={group.command || "命令信息未提供"}>{group.command || "命令信息未提供"}</span>
                            </span>
                          </span>
                          <span className="truncate px-3 text-[10px] text-muted-foreground" title={group.username}>{group.username || "—"}</span>
                          <span className="flex flex-wrap items-center gap-1 px-3 py-1.5">
                            {group.ports.map((port) => (
                              <Badge key={port} variant="secondary" className="h-5 rounded-md px-1.5 font-mono text-[10px] font-semibold text-primary">
                                {port}
                              </Badge>
                            ))}
                          </span>
                          <span className="px-3 font-mono text-[10px] text-muted-foreground">{group.pid ?? "—"}</span>
                        </button>

                        <div className="sticky right-0 z-[1] flex w-[72px] shrink-0 items-center justify-end gap-1 border-l border-border/50 bg-background px-1.5 transition-colors group-hover:bg-accent/35">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-7 p-0 text-[9px]"
                            disabled={group.pid === null || importingPid !== null || preparingPid !== null || busy}
                            aria-label={group.pid === null ? "缺少 PID，添加服务不可用" : "将 PID " + group.pid + " 添加为服务"}
                            title={group.pid === null ? "缺少 PID，添加服务不可用" : "添加为服务"}
                            onClick={() => void importProcess(group)}
                          >
                            {group.pid !== null && importingPid === group.pid ? <LoaderCircle className="size-3 animate-spin" /> : <Plus className="size-3" />}
                            <span className="sr-only">{group.pid !== null && importingPid === group.pid ? "读取中" : "添加"}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-7 p-0 text-[9px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                            disabled={group.pid === null || busy || preparing || preparingPid !== null || importingPid !== null}
                            aria-label={group.pid === null ? "缺少 PID，终止操作不可用" : "终止 PID " + group.pid}
                            title={group.pid === null ? "缺少 PID，终止操作不可用" : "终止 PID " + group.pid}
                            onClick={() => void openTerminateDialog(group)}
                          >
                            {busy || preparing ? <LoaderCircle className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                            <span className="sr-only">{preparing ? "核对中" : busy ? "处理中" : "终止"}</span>
                          </Button>
                        </div>
                      </div>

                      {expanded ? (
                        <div
                          id={group.key + "-details"}
                          className="border-t border-border/50 bg-muted/25 px-10 py-2"
                          role="region"
                          aria-label={group.processName + " 的监听明细"}
                        >
                          {group.command ? (
                            <div className="mb-2 flex min-w-0 items-center gap-3 text-[10px]">
                              <span className="w-12 shrink-0 font-semibold text-muted-foreground">命令</span>
                              <code className="truncate text-foreground" title={group.command}>{group.command}</code>
                            </div>
                          ) : null}
                          <div className="grid grid-cols-[80px_minmax(220px,1fr)_100px] px-1 pb-1 text-[9px] font-semibold tracking-wide text-muted-foreground uppercase" aria-hidden="true">
                            <span>协议</span>
                            <span>监听地址</span>
                            <span>端口</span>
                          </div>
                          <div className="overflow-hidden rounded-md border bg-background/70">
                            {group.rows.map((row, index) => (
                              <div
                                key={row.protocol + "-" + row.localAddress + "-" + row.port + "-" + index}
                                className="grid min-h-8 grid-cols-[80px_minmax(220px,1fr)_100px] items-center border-t px-1 text-[10px] first:border-t-0"
                              >
                                <span className="px-2">
                                  <Badge variant="outline" className="h-5 rounded-md px-1.5 font-mono text-[9px] uppercase">{row.protocol}</Badge>
                                </span>
                                <code className="truncate px-1 text-muted-foreground" title={row.localAddress}>{row.localAddress || "*"}</code>
                                <code className="px-1 font-semibold text-primary">{row.port}</code>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center gap-1 text-muted-foreground">
              <Network className="mb-1 size-8" strokeWidth={1.4} aria-hidden="true" />
              <strong className="text-xs text-secondary-foreground">
                {loading && !loaded ? "正在扫描监听端口…" : filter !== null ? "该端口未被占用" : "没有发现监听端口"}
              </strong>
              <span className="text-[10px]">{filter !== null ? "清除筛选条件可查看全部监听记录" : "点击刷新后重新扫描"}</span>
            </div>
          )}
        </div>
      </section>

      <AlertDialog open={Boolean(target)} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>终止进程 {target?.group.processName}</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block">PID {target?.group.pid} 将先接收普通终止信号，系统会等待 3 秒。</span>
              <span className="mt-2 block rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
                完整端口集合：{formatPortSet(target?.group.ports ?? [])}
              </span>
              <span className="mt-2 block">继续后，以上端口会随该进程一并释放。</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const group = target;
                setTarget(null);
                if (group) void confirmTerminate(group, false);
              }}
            >
              普通终止
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(forceTarget)} onOpenChange={(open) => !open && setForceTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>进程未在 3 秒内退出</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block">是否强制结束 PID {forceTarget?.group.pid}？未保存的数据可能丢失。</span>
              <span className="mt-2 block rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 font-mono text-xs text-foreground">
                完整端口集合：{formatPortSet(forceTarget?.group.ports ?? [])}
              </span>
              <span className="mt-2 block">强制结束后，以上端口会随该进程一并释放。</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留进程</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const group = forceTarget;
                setForceTarget(null);
                if (group) void confirmTerminate(group, true);
              }}
            >
              强制结束
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
