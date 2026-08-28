import { act, renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { useAutoScrollPreference } from "@/hooks/use-auto-scroll-preference";

function installLocalStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

function AutoScrollProbe() {
  const [autoScroll] = useAutoScrollPreference();
  return <span data-auto-scroll={String(autoScroll)} />;
}

describe("useAutoScrollPreference hydration", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  it("uses a stable render-time default and restores the saved preference after mount", async () => {
    window.localStorage.setItem("service-console:auto-scroll", "false");

    const markup = renderToString(<AutoScrollProbe />);
    expect(markup).toContain('data-auto-scroll="true"');

    const { result } = renderHook(() => useAutoScrollPreference());
    await waitFor(() => expect(result.current[0]).toBe(false));

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem("service-console:auto-scroll")).toBe("true");
  });
});
