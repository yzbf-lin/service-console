"use client";

import { ArrowDown, Copy, FileWarning, Pause, Play, RefreshCw, Search } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { AppLogEntry, AppLogSnapshot } from "@/lib/types";

type LevelFilter = "all" | "issues" | "ERROR" | "WARN" | "INFO";
const filters: { value: LevelFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "issues", label: "警告与错误" },
  { value: "ERROR", label: "错误" },
  { value: "WARN", label: "警告" },
  { value: "INFO", label: "信息" },
];

function timestampLabel(timestamp: string | null) {
  if (!timestamp) return "时间未知";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString("zh-CN", { hour12: false });
}

const LogRow = memo(function LogRow({ entry }: { entry: AppLogEntry }) {
  return (
    <li data-log-id={entry.id} className="flex min-w-0 gap-3 border-b border-border/50 px-4 py-2 last:border-0 max-[620px]:px-3">
      <Badge variant={entry.level === "ERROR" ? "destructive" : entry.level === "WARN" ? "warning" : "secondary"} className="mt-0.5 w-12 self-start justify-center rounded-sm px-1 py-0.5 text-[9px]">
        {entry.level}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
          <span className="break-all font-mono font-medium">{entry.event}</span>
          <time dateTime={entry.timestamp ?? undefined} title={entry.timestamp ?? undefined} className="text-muted-foreground tabular-nums">{timestampLabel(entry.timestamp)}</time>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed select-text">{entry.message}</p>
      </div>
    </li>
  );
}, (previous, next) => previous.entry.id === next.entry.id);

export function AppLogsView({ api, refreshSignal }: { api: ServiceConsoleApiClient; refreshSignal: number }) {
  const [snapshot, setSnapshot] = useState<AppLogSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [manualRefresh, setManualRefresh] = useState(0);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const autoRefreshRef = useRef(true);
  const scrollAnchor = useRef<{ id: string; offset: number } | null>(null);

  useEffect(() => { autoRefreshRef.current = autoRefresh; }, [autoRefresh]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      try {
        const next = await api.getAppLogs(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
        if (disposed) return;
        const container = viewport.current;
        if (container && !followRef.current) {
          const row = [...container.querySelectorAll<HTMLElement>("[data-log-id]")].find((item) => item.offsetTop + item.offsetHeight > container.scrollTop);
          scrollAnchor.current = row ? { id: row.dataset.logId!, offset: row.offsetTop - container.scrollTop } : null;
        }
        setSnapshot((previous) => previous && previous.path === next.path && previous.logs.length === next.logs.length && previous.logs.every((entry, index) => entry.id === next.logs[index].id) ? previous : next);
        setLastUpdated(new Date());
        setError("");
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(poll, 2_000);
        }
      }
    };
    const poll = () => {
      if (autoRefreshRef.current && !document.hidden) void load();
      else timer = setTimeout(poll, 2_000);
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, manualRefresh, refreshSignal]);

  const visible = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (snapshot?.logs ?? []).filter((entry) => (
      (level === "all" || (level === "issues" ? entry.level !== "INFO" : entry.level === level))
      && (!search || `${entry.timestamp ?? ""} ${entry.event} ${entry.message}`.toLocaleLowerCase().includes(search))
    ));
  }, [snapshot, level, query]);

  useLayoutEffect(() => {
    const container = viewport.current;
    if (!container) return;
    if (followRef.current) {
      container.scrollTop = container.scrollHeight;
    } else if (scrollAnchor.current) {
      const { id, offset } = scrollAnchor.current;
      const row = [...container.querySelectorAll<HTMLElement>("[data-log-id]")].find((item) => item.dataset.logId === id);
      if (row) container.scrollTop = row.offsetTop - offset;
    }
    scrollAnchor.current = null;
  }, [visible]);

  const copyVisible = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前环境未提供剪贴板，请直接选中文字复制");
      await navigator.clipboard.writeText(visible.map((entry) => `${entry.timestamp ?? "—"} ${entry.level} ${entry.event} ${entry.message}`).join("\n"));
      setCopyStatus(`已复制 ${visible.length} 条；对外分享前请检查路径和业务信息。`);
    } catch (reason) {
      setCopyStatus(reason instanceof Error ? reason.message : String(reason));
    }
  }, [visible]);

  return (
    <main id="logsView" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background" aria-labelledby="appLogsHeading">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-card/75 px-4 py-3">
        <div>
          <h2 id="appLogsHeading" className="flex items-center gap-2 text-sm font-semibold"><FileWarning className="size-4 text-primary" aria-hidden="true" />应用日志</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">查看关键操作和异常原因；服务业务输出请在“服务控制”中查看。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" aria-pressed={autoRefresh} onClick={() => setAutoRefresh((value) => !value)}>
            {autoRefresh ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}{autoRefresh ? "暂停刷新" : "自动刷新"}
          </Button>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setManualRefresh((value) => value + 1)}><RefreshCw className="size-3.5" />刷新</Button>
          <Button size="sm" variant="outline" disabled={!visible.length} onClick={() => void copyVisible()}><Copy className="size-3.5" />复制筛选结果</Button>
        </div>
      </header>

      <section className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2" aria-label="日志筛选">
        <div className="flex flex-wrap gap-1" role="group" aria-label="日志级别">
          {filters.map((filter) => <Button key={filter.value} size="sm" variant={level === filter.value ? "secondary" : "ghost"} aria-pressed={level === filter.value} className="px-2 text-[11px]" onClick={() => { scrollAnchor.current = null; setLevel(filter.value); }}>{filter.label}</Button>)}
        </div>
        <div className="relative ml-auto min-w-40 flex-1 max-w-sm">
          <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
          <Input value={query} onChange={(event) => { scrollAnchor.current = null; setQuery(event.target.value); }} aria-label="搜索应用日志" placeholder="搜索事件或错误信息…" className="h-8 pl-8 text-xs" />
        </div>
      </section>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b px-4 py-1.5 text-[10px] text-muted-foreground">
        <span>{visible.length} / {snapshot?.logs.length ?? 0} 条 · 最近 500 条（含轮转历史）</span>
        <span>{autoRefresh ? "每 2 秒刷新" : "已暂停"}{lastUpdated ? ` · 更新于 ${lastUpdated.toLocaleTimeString("zh-CN", { hour12: false })}` : ""}</span>
      </div>
      {error ? <p role="alert" className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">读取应用日志失败：{error}。已保留上次结果，可重试或检查底部日志文件。</p> : null}
      <div ref={viewport} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]" role="region" aria-label="应用日志内容" tabIndex={0} onScroll={(event) => {
        const container = event.currentTarget;
        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 32;
        followRef.current = atBottom;
        setFollowing(atBottom);
      }}>
        {visible.length ? <ol aria-label="日志记录">{visible.map((entry) => <LogRow key={entry.id} entry={entry} />)}</ol> : (
          <div className="grid h-full min-h-28 place-content-center gap-2 px-4 text-center text-xs text-muted-foreground">
            <FileWarning className="mx-auto size-6 opacity-60" aria-hidden="true" />
            <p>{!snapshot ? error ? "等待恢复日志连接" : "正在读取日志…" : snapshot.logs.length ? "没有符合筛选条件的日志" : "暂无应用日志，关键操作发生后会显示在这里"}</p>
          </div>
        )}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-card/60 px-4 py-2">
        <div className="min-w-0 flex-1 text-[10px] leading-relaxed text-muted-foreground">
          <p className="break-all select-text">{snapshot?.path ?? "日志路径：控制器数据目录 / logs / service-console.log"}</p>
          <p>单文件 1 MiB，保留 2 个备份；相同诊断错误每分钟最多记录一次。错误也可能来自配置或网络，不一定是程序缺陷。</p>
          {copyStatus ? <p role="status">{copyStatus}</p> : null}
        </div>
        <Button size="sm" variant="ghost" className={cn("text-[11px]", following && "text-muted-foreground")} aria-pressed={following} onClick={() => {
          followRef.current = true;
          setFollowing(true);
          if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
        }}><ArrowDown className="size-3.5" />{following ? "跟随最新" : "回到最新"}</Button>
      </footer>
    </main>
  );
}
