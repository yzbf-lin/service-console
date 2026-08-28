"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ThemePreference } from "@/lib/types";

function resolveTheme(preference: ThemePreference, systemDark: boolean): "light" | "dark" {
  if (preference === "light" || preference === "dark") return preference;
  return systemDark ? "dark" : "light";
}

function applyTheme(preference: ThemePreference, systemDark: boolean) {
  const theme = resolveTheme(preference, systemDark);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>("#themeColorMeta")?.setAttribute(
    "content",
    theme === "dark" ? "#0d131d" : "#f4f6f8",
  );
  return theme;
}

export function useTheme(token: string, onSaveError: (message: string) => void) {
  // 首次渲染必须与静态 HTML 一致；真实偏好由内联脚本提前应用到根节点，
  // React 挂载后再同步到组件状态，避免深色系统下发生 hydration mismatch。
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [systemDark, setSystemDark] = useState(false);
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTimer = window.setTimeout(() => {
      const storedPreference = document.documentElement.dataset.themePreference;
      setPreferenceState(
        storedPreference === "light" || storedPreference === "dark" ? storedPreference : "system",
      );
      setSystemDark(media.matches);
      setThemeReady(true);
    }, 0);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => {
      window.clearTimeout(syncTimer);
      media.removeEventListener("change", onChange);
    };
  }, []);

  const resolvedTheme = useMemo(
    () => resolveTheme(preference, systemDark),
    [preference, systemDark],
  );

  useEffect(() => {
    if (!themeReady) return;
    applyTheme(preference, systemDark);
  }, [preference, systemDark, themeReady]);

  const setPreference = useCallback(async (nextPreference: ThemePreference) => {
    setPreferenceState(nextPreference);
    applyTheme(nextPreference, window.matchMedia("(prefers-color-scheme: dark)").matches);
    try {
      const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
      if (token) headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch("/api/ui-preferences", {
        method: "PUT",
        headers,
        body: JSON.stringify({ theme: nextPreference }),
        keepalive: true,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      onSaveError(error instanceof Error ? error.message : "未知错误");
    }
  }, [onSaveError, token]);

  const toggleTheme = useCallback(() => {
    void setPreference(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setPreference]);

  return { preference, resolvedTheme, setPreference, toggleTheme };
}
