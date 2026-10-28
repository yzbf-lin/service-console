"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Tracks a CSS media query in React state.
 *
 * Layout branches that mount or unmount whole panels cannot be expressed with
 * responsive utility classes alone, because a resizable panel keeps consuming
 * space even when its content is hidden. Those branches subscribe here instead.
 *
 * `useSyncExternalStore` reports `false` for the server snapshot so the static
 * export and the hydration pass agree, then switches to the live value without
 * an effect-driven extra render.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
