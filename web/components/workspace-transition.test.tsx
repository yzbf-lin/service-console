import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceTransition } from "@/components/workspace-transition";

const preferences = vi.hoisted(() => ({ reducedMotion: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => preferences.reducedMotion,
}));

describe("WorkspaceTransition", () => {
  beforeEach(() => { preferences.reducedMotion = false; });

  it("keeps the glass surface and live content mounted on data refresh", () => {
    const mounted = vi.fn();
    function LiveLog({ lines }: { lines: number }) {
      useEffect(() => { mounted(); }, []);
      return <div>{lines} log lines</div>;
    }
    const { container, rerender } = render(
      <WorkspaceTransition view="services"><LiveLog lines={1} /></WorkspaceTransition>,
    );
    const surface = container.querySelector(".service-console-stage");
    const frame = container.querySelector("[data-workspace-view]");
    rerender(<WorkspaceTransition view="services"><LiveLog lines={2} /></WorkspaceTransition>);
    expect(container.querySelector(".service-console-stage")).toBe(surface);
    expect(container.querySelector("[data-workspace-view]")).toBe(frame);
    expect(screen.getByText("2 log lines")).toBeTruthy();
    expect(mounted).toHaveBeenCalledOnce();
  });

  it("makes the leaving page inert while the next page is immediately usable", async () => {
    const { container, rerender } = render(
      <WorkspaceTransition view="services"><button>旧页面操作</button></WorkspaceTransition>,
    );
    rerender(<WorkspaceTransition view="settings"><button>新页面操作</button></WorkspaceTransition>);
    const leaving = container.querySelector('[data-workspace-view="services"]');
    expect(leaving?.getAttribute("aria-hidden")).toBe("true");
    expect(leaving?.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("button", { name: "旧页面操作" })).toBeNull();
    expect(screen.getByRole("button", { name: "新页面操作" })).toBeTruthy();
    await waitFor(() => expect(container.querySelector('[data-workspace-view="services"]')).toBeNull());
  });

  it("skips spatial entrance animation with reduced motion", async () => {
    preferences.reducedMotion = true;
    const { container, rerender } = render(
      <WorkspaceTransition view="services"><button>服务</button></WorkspaceTransition>,
    );
    rerender(<WorkspaceTransition view="ports"><button>端口</button></WorkspaceTransition>);
    const frame = container.querySelector<HTMLElement>('[data-workspace-view="ports"]');
    expect(frame?.style.transform || "none").toBe("none");
    expect(frame?.style.opacity).toBe("1");
    await waitFor(() => expect(container.querySelector('[data-workspace-view="services"]')).toBeNull());
  });
});
