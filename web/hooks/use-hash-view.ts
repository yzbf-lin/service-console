"use client";

import { useCallback, useEffect } from "react";

import type { ViewId } from "@/lib/types";
import { useConsoleUiStore } from "@/stores/console-ui-store";

const views = new Set<ViewId>(["services", "ports", "jenkins", "logs", "settings"]);

function viewFromLocation(): ViewId {
  if (typeof window === "undefined") return "services";
  const candidate = window.location.hash.slice(1) as ViewId;
  return views.has(candidate) ? candidate : "services";
}

/**
 * Hash-backed routing. The current view lives in `useConsoleUiStore` so every
 * panel can read it without prop drilling; this hook only owns the
 * `hashchange` subscription and the history write.
 */
export function useHashView() {
  const activeView = useConsoleUiStore((state) => state.activeView);
  const storeSetActiveView = useConsoleUiStore((state) => state.setActiveView);

  useEffect(() => {
    const syncFromHash = () => storeSetActiveView(viewFromLocation());
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [storeSetActiveView]);

  const setActiveView = useCallback((view: ViewId) => {
    storeSetActiveView(view);
    const url = new URL(window.location.href);
    url.hash = view === "services" ? "" : view;
    window.history.replaceState(null, "", url);
  }, [storeSetActiveView]);

  return { activeView, setActiveView };
}
