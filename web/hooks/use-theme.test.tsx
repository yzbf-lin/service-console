import { act, renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTheme } from "@/hooks/use-theme";
import { CHROME_COLORS } from "@/lib/theme-colors";

const onSaveError = vi.fn();

function installMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string): MediaQueryList => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn((_type, listener) => listeners.add(listener)),
      removeEventListener: vi.fn((_type, listener) => listeners.delete(listener)),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
  return (dark: boolean) => {
    matches = dark;
    for (const listener of listeners) listener({ matches: dark } as MediaQueryListEvent);
  };
}

function ThemeProbe() {
  const { resolvedTheme } = useTheme("", onSaveError);
  return <span data-resolved-theme={resolvedTheme}>{resolvedTheme}</span>;
}

describe("useTheme hydration", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.dataset.themePreference = "system";
    installMatchMedia(true);
    onSaveError.mockClear();
    const meta = document.createElement("meta");
    meta.id = "themeColorMeta";
    document.head.append(meta);
  });

  afterEach(() => {
    document.querySelector("#themeColorMeta")?.remove();
    vi.unstubAllGlobals();
  });

  it("keeps the render-time state deterministic, then applies the browser theme after mount", async () => {
    const markup = renderToString(<ThemeProbe />);
    expect(markup).toContain('data-resolved-theme="light"');

    const { result } = renderHook(() => useTheme("", onSaveError));

    await waitFor(() => expect(result.current.resolvedTheme).toBe("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(document.querySelector("#themeColorMeta")?.getAttribute("content")).toBe(CHROME_COLORS.dark);
  });

  it("keeps browser chrome in sync when switching an explicit theme", async () => {
    document.documentElement.dataset.themePreference = "light";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { result } = renderHook(() => useTheme("theme-test-token", onSaveError));
    await waitFor(() => expect(result.current.preference).toBe("light"));
    expect(document.querySelector("#themeColorMeta")?.getAttribute("content")).toBe(CHROME_COLORS.light);

    await act(() => result.current.setPreference("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector("#themeColorMeta")?.getAttribute("content")).toBe(CHROME_COLORS.dark);
    expect(onSaveError).not.toHaveBeenCalled();
  });

  it("updates browser chrome with system appearance when following the system", async () => {
    const changeSystem = installMatchMedia(false);
    const { result } = renderHook(() => useTheme("", onSaveError));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    act(() => changeSystem(true));
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.querySelector("#themeColorMeta")?.getAttribute("content")).toBe(CHROME_COLORS.dark);
  });
});
