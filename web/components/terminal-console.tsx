"use client";

import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { ChevronDown, ChevronUp, CircleAlert, RotateCw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ServiceLifecycleToolbar } from "@/components/service-actions";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  currentUptime,
  formatBytes,
  formatDuration,
  formatPercent,
  formatTerminalEntry,
  statusLabel,
} from "@/lib/service-logic";
import type { NormalizedLogEntry, NormalizedService, ResolvedTheme, ServiceAction } from "@/lib/types";
import { cn } from "@/lib/cn";

const terminalThemes = {
  light: {
    background: "#111823",
    foreground: "#d7deea",
    cursor: "#7aa7e8",
    selectionBackground: "#355a87",
    black: "#111823",
    red: "#ff7b85",
    green: "#62d6a5",
    yellow: "#f4c66f",
    blue: "#83b4f2",
    magenta: "#cda2f2",
    cyan: "#76d6da",
    white: "#e6ebf2",
    brightBlack: "#8491a3",
  },
  dark: {
    background: "#0e1621",
    foreground: "#d8e0ec",
    cursor: "#8fc5f7",
    selectionBackground: "#294a70",
    black: "#0e1621",
    red: "#ff7f89",
    green: "#72d3a8",
    yellow: "#efc06f",
    blue: "#8fc5f7",
    magenta: "#caa0ef",
    cyan: "#7ad0da",
    white: "#e8edf4",
    brightBlack: "#8d99aa",
  },
} as const;

function logKey(entry: NormalizedLogEntry) {
  return `${entry.timestamp ?? ""}\u0000${entry.stream}\u0000${entry.message}`;
}

interface TerminalConsoleProps {
  service: NormalizedService | null;
  logs: NormalizedLogEntry[];
  logRevision: number;
  theme: ResolvedTheme;
  active: boolean;
  busy: boolean;
  onAction: (action: ServiceAction) => void;
  onClear: () => void;
}

export function TerminalConsole({
  service,
  logs,
  logRevision,
  theme,
  active,
  busy,
  onAction,
  onClear,
}: TerminalConsoleProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const themeRef = useRef(theme);
  const renderQueueRef = useRef(Promise.resolve());
  const renderRevisionRef = useRef(0);
  const renderedRef = useRef<{ service: string | null; keys: string[] }>({ service: null, keys: [] });
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [terminalAttempt, setTerminalAttempt] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [autoScroll, setAutoScroll] = useState(() => (
    typeof window === "undefined" || window.localStorage.getItem("service-console:auto-scroll") !== "false"
  ));

  useEffect(() => {
    window.localStorage.setItem("service-console:auto-scroll", String(autoScroll));
  }, [autoScroll]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    renderRevisionRef.current += 1;
    renderQueueRef.current = Promise.resolve();
    renderedRef.current = { service: null, keys: [] };
    let disposed = false;
    let observer: ResizeObserver | null = null;
    let terminal: Terminal | null = null;

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
      import("@xterm/addon-web-links"),
    ]).then(([xtermModule, fitModule, searchModule, linksModule]) => {
      if (disposed) return;
      terminal = new xtermModule.Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.42,
        scrollback: 10_000,
        theme: terminalThemes[themeRef.current],
      });
      const fitAddon = new fitModule.FitAddon();
      const searchAddon = new searchModule.SearchAddon();
      const webLinksAddon = new linksModule.WebLinksAddon((event, uri) => {
        event.preventDefault();
        try {
          const url = new URL(uri);
          if (["http:", "https:"].includes(url.protocol)) {
            window.open(url.href, "_blank", "noopener,noreferrer");
          }
        } catch {
          // 忽略无效链接。
        }
      });
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(searchAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(host);
      terminalRef.current = terminal;
      searchAddonRef.current = searchAddon;
      fitRef.current = () => {
        try {
          fitAddon.fit();
        } catch {
          // 隐藏视图可能暂时没有可计算尺寸。
        }
      };
      observer = new ResizeObserver(() => fitRef.current?.());
      observer.observe(host);
      window.requestAnimationFrame(() => fitRef.current?.());
      setReady(true);
    }).catch((error: unknown) => {
      if (disposed) return;
      setLoadError(error instanceof Error ? error.message : "未知加载错误");
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      terminal?.dispose();
      terminalRef.current = null;
      searchAddonRef.current = null;
      fitRef.current = null;
    };
  }, [terminalAttempt]);

  useEffect(() => {
    themeRef.current = theme;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalThemes[theme];
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  }, [theme]);

  const retryTerminal = useCallback(() => {
    setReady(false);
    setLoadError("");
    setTerminalAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (active) window.requestAnimationFrame(() => fitRef.current?.());
  }, [active]);

  useEffect(() => {
    if (!ready) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const revision = ++renderRevisionRef.current;
    const serviceName = service?.name ?? null;
    const nextKeys = logs.map(logKey);
    const previous = renderedRef.current;
    const appendOnly = previous.service === serviceName
      && previous.keys.length <= nextKeys.length
      && previous.keys.every((key, index) => nextKeys[index] === key);
    const pendingEntries = appendOnly ? logs.slice(previous.keys.length) : logs;

    const write = (value: string) => new Promise<void>((resolve) => terminal.write(value, resolve));
    renderQueueRef.current = renderQueueRef.current.then(async () => {
      if (renderRevisionRef.current !== revision) return;
      if (!appendOnly) terminal.reset();
      for (let index = 0; index < pendingEntries.length; index += 100) {
        if (renderRevisionRef.current !== revision) return;
        const chunk = pendingEntries.slice(index, index + 100).map(formatTerminalEntry).join("");
        await write(chunk);
      }
      if (renderRevisionRef.current !== revision) return;
      renderedRef.current = { service: serviceName, keys: nextKeys };
      if (autoScroll && !searchOpen) terminal.scrollToBottom();
    });
  }, [autoScroll, logRevision, logs, ready, searchOpen, service?.name]);

  const runSearch = useCallback((forward: boolean, incremental = false, queryOverride?: string) => {
    const query = (queryOverride ?? searchValue).trim();
    const addon = searchAddonRef.current;
    if (!addon || !query) {
      addon?.clearDecorations();
      setSearchStatus("");
      return;
    }
    const found = forward
      ? addon.findNext(query, { incremental, caseSensitive: false })
      : addon.findPrevious(query, { incremental, caseSensitive: false });
    setSearchStatus(found ? "已定位" : "无匹配");
  }, [searchValue]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchStatus("");
    searchAddonRef.current?.clearDecorations();
    if (autoScroll) terminalRef.current?.scrollToBottom();
  }, [autoScroll]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const editing = target?.closest("input, textarea, select, [contenteditable='true']");
      if (
        active
        && service
        && event.key.toLowerCase() === "f"
        && (event.metaKey || event.ctrlKey)
        && (!editing || target?.closest("[data-terminal-search]"))
      ) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        closeSearch();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, closeSearch, searchOpen, service]);

  const command = service?.command ?? "从左侧选择一个服务查看输出";
  const title = service?.name ?? "实时日志";
  const status = service ? statusLabel(service.status) : "未选择";
  const memory = service
    ? service.memoryBytes !== null ? formatBytes(service.memoryBytes) : formatPercent(service.memoryPercent)
    : "—";

  return (
    <section className="service-terminal flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card" aria-labelledby="consoleTitle">
      <header className="flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("size-2 shrink-0 rounded-full bg-muted-foreground", service?.status === "RUNNING" && "bg-success", service?.status === "FAILED" && "bg-destructive", ["STARTING", "STOPPING"].includes(service?.status ?? "") && "bg-warning animate-pulse")} aria-hidden="true" />
            <h2 id="consoleTitle" className="truncate text-[13px] font-semibold">{title}</h2>
            <span className="shrink-0 text-[10px] text-muted-foreground">{busy ? "处理中" : status}</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 pl-4 text-[10px] text-muted-foreground">
            <code className="min-w-0 flex-1 truncate font-mono text-secondary-foreground/80" title={command}>{command}</code>
            {service ? (
              <span className="flex shrink-0 items-center gap-1.5 max-[960px]:hidden">
                <span>PID {service.pid ?? "—"}</span><span aria-hidden="true">·</span>
                <span>{formatDuration(currentUptime(service))}</span><span aria-hidden="true">·</span>
                <span>CPU {formatPercent(service.cpuPercent)}</span><span aria-hidden="true">·</span>
                <span>{memory}</span>
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {service ? <ServiceLifecycleToolbar service={service} busy={busy} onAction={onAction} /> : null}
          {service ? <span className="mx-0.5 h-5 w-px bg-border" aria-hidden="true" /> : null}
          <label className="mr-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground max-[720px]:hidden">
            <Switch checked={autoScroll} onCheckedChange={setAutoScroll} aria-label="自动滚动" />
            <span className="max-[1080px]:sr-only">自动滚动</span>
          </label>
          <Button className="size-7 rounded-md p-0 shadow-none" variant="ghost" size="icon-sm" title="搜索日志 (⌘F)" aria-label="搜索日志" disabled={!service || !ready} onClick={() => setSearchOpen(true)}>
            <Search className="size-3.5" />
          </Button>
          <Button className="size-7 rounded-md p-0 shadow-none" variant="ghost" size="icon-sm" title="清空当前视图" aria-label="清空当前视图" disabled={!service} onClick={onClear}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--terminal)]">
        {loadError ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-[var(--terminal)] px-6 text-center" role="alert">
            <CircleAlert className="size-7 text-destructive" strokeWidth={1.6} aria-hidden="true" />
            <strong className="text-xs text-slate-200">终端组件加载失败</strong>
            <span className="max-w-lg break-words text-[10px] text-slate-400">{loadError}</span>
            <Button variant="outline" size="sm" className="border-slate-600 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-white" onClick={retryTerminal}>
              <RotateCw className="size-3.5" />
              重试
            </Button>
          </div>
        ) : null}

        {searchOpen ? (
          <div data-terminal-search className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-md border border-white/15 bg-[#172231]/95 p-1 shadow-xl">
            <input
              className="h-7 w-52 rounded border border-white/15 bg-[#111a27] px-2 font-mono text-[11px] text-slate-100 outline-none focus:border-blue-400"
              autoFocus
              value={searchValue}
              placeholder="搜索当前日志"
              aria-label="搜索当前日志"
              onChange={(event) => {
                const value = event.target.value;
                setSearchValue(value);
                runSearch(true, true, value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runSearch(!event.shiftKey);
                }
              }}
            />
            <span className="min-w-10 text-center text-[10px] text-slate-400" aria-live="polite">{searchStatus}</span>
            <button className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" type="button" aria-label="上一个匹配项" onClick={() => runSearch(false)}><ChevronUp className="size-3.5" /></button>
            <button className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" type="button" aria-label="下一个匹配项" onClick={() => runSearch(true)}><ChevronDown className="size-3.5" /></button>
            <button className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" type="button" aria-label="关闭搜索" onClick={closeSearch}><X className="size-3.5" /></button>
          </div>
        ) : null}

        {!service ? (
          <div className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-1 text-slate-500">
            <Search className="mb-1 size-7" strokeWidth={1.5} aria-hidden="true" />
            <strong className="text-xs text-slate-400">等待选择服务</strong>
            <span className="text-[11px]">日志会通过 WebSocket 实时显示在这里</span>
          </div>
        ) : null}
        <div ref={hostRef} className="h-full min-h-0 w-full px-2 py-1" aria-label="服务实时日志" />
      </div>
    </section>
  );
}
