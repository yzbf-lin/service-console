import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useMediaQuery } from "@/hooks/use-media-query";

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches,
    media: "",
    onchange: null,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  };
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => media) });
  /** Mirrors a real MediaQueryList: the flag flips first, then listeners are notified. */
  const setMatches = (next: boolean) => {
    media.matches = next;
    for (const listener of listeners) {
      listener({ matches: next } as MediaQueryListEvent);
    }
  };
  return { listeners, media, setMatches };
}

describe("useMediaQuery", () => {
  it("reports the live query result and follows change events", () => {
    const original = window.matchMedia;
    const { setMatches } = stubMatchMedia(true);
    try {
      const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
      expect(result.current).toBe(true);

      act(() => setMatches(false));
      expect(result.current).toBe(false);

      act(() => setMatches(true));
      expect(result.current).toBe(true);
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
    }
  });

  it("starts false and stops listening after unmount", () => {
    const original = window.matchMedia;
    const { listeners } = stubMatchMedia(false);
    try {
      const { result, unmount } = renderHook(() => useMediaQuery("(min-width: 1100px)"));
      expect(result.current).toBe(false);
      expect(listeners.size).toBe(1);
      unmount();
      expect(listeners.size).toBe(0);
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
    }
  });
});
