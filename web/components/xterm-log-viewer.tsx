"use client";

import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { ChevronDown, ChevronUp, CircleAlert, RotateCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAutoScrollPreference } from "@/hooks/use-auto-scroll-preference";
import { terminalThemes } from "@/lib/terminal-theme";
import type { ResolvedTheme } from "@/lib/types";

interface XtermLogViewerProps {
  active: boolean;
  ariaLabel: string;
  resetKey: string;
  text: string;
  theme: ResolvedTheme;
}

export function XtermLogViewer({ active, ariaLabel, resetKey, text, theme }: XtermLogViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const renderedRef = useRef({ key: "", text: "" });
  const renderQueueRef = useRef(Promise.resolve());
  const renderRevisionRef = useRef(0);
  const themeRef = useRef(theme);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [autoScroll, setAutoScroll] = useAutoScrollPreference();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let terminal: Terminal | null = null;
    let observer: ResizeObserver | null = null;
    renderedRef.current = { key: "", text: "" };
    renderQueueRef.current = Promise.resolve();
    renderRevisionRef.current += 1;

    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
      import("@xterm/addon-web-links"),
    ]).then(([xtermModule, fitModule, searchModule, linksModule]) => {
      if (disposed) return;
      terminal = new xtermModule.Terminal({
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 11,
        lineHeight: 1.42,
        scrollback: 20_000,
        theme: terminalThemes[themeRef.current],
      });
      const fitAddon = new fitModule.FitAddon();
      const searchAddon = new searchModule.SearchAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(searchAddon);
      terminal.loadAddon(new linksModule.WebLinksAddon((event, uri) => {
        event.preventDefault();
        try {
          const url = new URL(uri);
          if (["http:", "https:"].includes(url.protocol)) window.open(url.href, "_blank", "noopener,noreferrer");
        } catch {
          // Jenkins 输出可能包含不完整 URL，忽略即可。
        }
      }));
      terminal.open(host);
      terminalRef.current = terminal;
      searchAddonRef.current = searchAddon;
      fitRef.current = () => {
        try {
          fitAddon.fit();
        } catch {
          // 正在切换窄屏面板时尺寸可能暂不可用。
        }
      };
      observer = new ResizeObserver(() => fitRef.current?.());
      observer.observe(host);
      window.requestAnimationFrame(() => fitRef.current?.());
      setReady(true);
    }).catch((error: unknown) => {
      if (!disposed) setLoadError(error instanceof Error ? error.message : "终端组件加载失败");
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      terminal?.dispose();
      terminalRef.current = null;
      searchAddonRef.current = null;
      fitRef.current = null;
    };
  }, [attempt]);

  useEffect(() => {
    themeRef.current = theme;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalThemes[theme];
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
  }, [theme]);

  useEffect(() => {
    if (active) window.requestAnimationFrame(() => fitRef.current?.());
  }, [active]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!ready || !terminal) return;
    const revision = ++renderRevisionRef.current;
    const previous = renderedRef.current;
    const appendOnly = previous.key === resetKey && text.startsWith(previous.text);
    const pending = appendOnly ? text.slice(previous.text.length) : text;
    const write = (value: string) => new Promise<void>((resolve) => terminal.write(value, resolve));

    renderQueueRef.current = renderQueueRef.current.then(async () => {
      if (revision !== renderRevisionRef.current) return;
      if (!appendOnly) terminal.reset();
      if (pending) await write(pending);
      if (revision !== renderRevisionRef.current) return;
      renderedRef.current = { key: resetKey, text };
      if (autoScroll && !searchOpen) terminal.scrollToBottom();
    });
  }, [autoScroll, ready, resetKey, searchOpen, text]);

  const runSearch = useCallback((forward: boolean, query = searchValue) => {
    const value = query.trim();
    const addon = searchAddonRef.current;
    if (!addon || !value) {
      addon?.clearDecorations();
      setSearchStatus("");
      return;
    }
    const found = forward
      ? addon.findNext(value, { caseSensitive: false })
      : addon.findPrevious(value, { caseSensitive: false });
    setSearchStatus(found ? "已定位" : "无匹配");
  }, [searchValue]);

  if (loadError) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-[#0e1621] p-4 text-xs text-[#d8e0ec]" role="alert">
        <div className="max-w-sm text-center">
          <CircleAlert className="mx-auto mb-2 size-5 text-warning" />
          <p>日志终端加载失败：{loadError}</p>
          <Button className="mt-3" size="sm" variant="secondary" onClick={() => {
            setLoadError("");
            setReady(false);
            setAttempt((value) => value + 1);
          }}><RotateCw className="size-3.5" />重试</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0e1621]">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-white/10 px-2 text-[10px] text-[#aab4c2]">
        <label className="mr-auto flex items-center gap-1.5">
          <Switch checked={autoScroll} onCheckedChange={setAutoScroll} aria-label="Jenkins 日志自动滚动" />
          自动滚动
        </label>
        {searchOpen ? (
          <div className="flex items-center gap-1" data-terminal-search>
            <Input
              className="h-6 w-40 border-white/15 bg-white/5 px-2 text-[10px] text-white"
              autoFocus
              value={searchValue}
              placeholder="搜索日志"
              aria-label="搜索 Jenkins 日志"
              onChange={(event) => {
                setSearchValue(event.target.value);
                runSearch(true, event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch(!event.shiftKey);
                if (event.key === "Escape") setSearchOpen(false);
              }}
            />
            <span className="min-w-9 text-center">{searchStatus}</span>
            <Button className="size-6 text-[#c6cfda] hover:bg-white/10 hover:text-white" variant="ghost" size="icon-sm" aria-label="上一个匹配" onClick={() => runSearch(false)}><ChevronUp className="size-3" /></Button>
            <Button className="size-6 text-[#c6cfda] hover:bg-white/10 hover:text-white" variant="ghost" size="icon-sm" aria-label="下一个匹配" onClick={() => runSearch(true)}><ChevronDown className="size-3" /></Button>
            <Button className="size-6 text-[#c6cfda] hover:bg-white/10 hover:text-white" variant="ghost" size="icon-sm" aria-label="关闭日志搜索" onClick={() => setSearchOpen(false)}><X className="size-3" /></Button>
          </div>
        ) : (
          <Button className="h-6 px-2 text-[10px] text-[#c6cfda] hover:bg-white/10 hover:text-white" variant="ghost" size="sm" disabled={!ready} onClick={() => setSearchOpen(true)}><Search className="size-3" />搜索</Button>
        )}
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-1 py-1" role="log" aria-label={ariaLabel} aria-live="off" />
    </div>
  );
}
