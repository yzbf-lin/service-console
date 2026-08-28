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

function initialPreference(): ThemePreference {
  if (typeof document === "undefined") return "system";
  const value = document.documentElement.dataset.themePreference;
  return value === "light" || value === "dark" ? value : "system";
}

function initialSystemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function useTheme(token: string, onSaveError: (message: string) => void) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const [systemDark, setSystemDark] = useState(initialSystemDark);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme = useMemo(
    () => resolveTheme(preference, systemDark),
    [preference, systemDark],
  );

  useEffect(() => {
    applyTheme(preference, systemDark);
  }, [preference, systemDark]);

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
