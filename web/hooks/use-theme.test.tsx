import { renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTheme } from "@/hooks/use-theme";

const onSaveError = vi.fn();

function installMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string): MediaQueryList => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
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
  });

  it("keeps the render-time state deterministic, then applies the browser theme after mount", async () => {
    const markup = renderToString(<ThemeProbe />);
    expect(markup).toContain('data-resolved-theme="light"');

    const { result } = renderHook(() => useTheme("", onSaveError));

    await waitFor(() => expect(result.current.resolvedTheme).toBe("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themePreference).toBe("system");
  });
});
