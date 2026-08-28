"use client";

import { useCallback, useEffect, useState } from "react";

import type { ViewId } from "@/lib/types";

const views = new Set<ViewId>(["services", "ports", "settings"]);

function viewFromLocation(): ViewId {
  if (typeof window === "undefined") return "services";
  const candidate = window.location.hash.slice(1) as ViewId;
  return views.has(candidate) ? candidate : "services";
}

export function useHashView() {
  const [activeView, setActiveViewState] = useState<ViewId>("services");

  useEffect(() => {
    const syncFromHash = () => setActiveViewState(viewFromLocation());
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  const setActiveView = useCallback((view: ViewId) => {
    setActiveViewState(view);
    const url = new URL(window.location.href);
    url.hash = view === "services" ? "" : view;
    window.history.replaceState(null, "", url);
  }, []);

  return { activeView, setActiveView };
}
