import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ServiceCard } from "@/components/service-card";
import type { NormalizedService, ServiceState } from "@/lib/types";

function serviceFixture(status: ServiceState): NormalizedService {
  return {
    name: "pd-qa-backend",
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

describe("ServiceCard lifecycle actions", () => {
  it("renders Start as a native disabled button while the service is RUNNING", () => {
    const onAction = vi.fn();
    render(
      <ServiceCard
        service={serviceFixture("RUNNING")}
        selected
        busy={false}
        onSelect={vi.fn()}
        onAction={onAction}
      />,
    );

    const startButton = screen.getByRole("button", { name: "启动" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    expect(startButton.hasAttribute("disabled")).toBe(true);
    expect(startButton.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(startButton);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("enables Start for a STOPPED service and dispatches the start action", () => {
    const onAction = vi.fn();
    render(
      <ServiceCard
        service={serviceFixture("STOPPED")}
        selected={false}
        busy={false}
        onSelect={vi.fn()}
        onAction={onAction}
      />,
    );

    const startButton = screen.getByRole("button", { name: "启动" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(false);
    expect(startButton.hasAttribute("disabled")).toBe(false);
    expect(startButton.getAttribute("aria-disabled")).toBe("false");

    fireEvent.click(startButton);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith("start");
  });
});
