import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ServiceCard } from "@/components/service-card";
import type { NormalizedService, ServiceState } from "@/lib/types";

function serviceFixture(status: ServiceState): NormalizedService {
  return {
    name: "pd-qa-backend",
    group: null,
    command: "uv run backend/run.py",
    cwd: "/workspace/pd-qa-backend",
    env: {},
    autoStart: false,
    stopTimeout: 10,
    status,
    pid: status === "RUNNING" ? 12_345 : null,
    uptimeSeconds: status === "RUNNING" ? 60 : null,
    startedAt: null,
    stoppedAt: null,
    cpuPercent: status === "RUNNING" ? 0.25 : 0,
    memoryBytes: status === "RUNNING" ? 128 * 1_024 * 1_024 : 0,
    memoryPercent: null,
    exitCode: null,
    restartCount: 0,
    lastError: null,
    raw: {},
  };
}

describe("ServiceCard", () => {
  it("uses a dedicated native button to select the service", () => {
    const onSelect = vi.fn();
    render(
      <ServiceCard
        service={serviceFixture("RUNNING")}
        selected={false}
        busy={false}
        onSelect={onSelect}
        onAction={vi.fn()}
      />,
    );

    const selectButton = screen.getByRole("button", { name: /^pd-qa-backend，/ });
    expect(selectButton).toBeInstanceOf(HTMLButtonElement);
    expect(selectButton.getAttribute("data-service-select")).toBe("pd-qa-backend");
    expect(selectButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(selectButton);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("keeps the selection button and actions menu as sibling interactions", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ServiceCard
        service={serviceFixture("RUNNING")}
        selected
        busy={false}
        onSelect={onSelect}
        onAction={vi.fn()}
      />,
    );

    const article = container.querySelector<HTMLElement>('[data-service="pd-qa-backend"]');
    const selectButton = screen.getByRole("button", { name: /^pd-qa-backend，/ });
    const menuButton = screen.getByRole("button", { name: "打开 pd-qa-backend 操作菜单" });

    expect(article).not.toBeNull();
    expect(selectButton.getAttribute("aria-pressed")).toBe("true");
    expect(selectButton.contains(menuButton)).toBe(false);
    expect(article?.querySelector("button button")).toBeNull();

    fireEvent.click(menuButton);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
