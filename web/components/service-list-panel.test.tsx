import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ServiceListPanel } from "@/components/service-list-panel";
import type { NormalizedService, ServiceStatus } from "@/lib/types";

function serviceFixture(status: ServiceStatus): NormalizedService {
  return {
    name: `service-${status.toLowerCase()}`,
    command: `run ${status.toLowerCase()}`,
    cwd: "/workspace",
    env: {},
    autoStart: false,
    stopTimeout: 10,
    status,
    pid: status === "RUNNING" ? 12_345 : null,
    uptimeSeconds: null,
    startedAt: null,
    stoppedAt: null,
    cpuPercent: 0,
    memoryBytes: 0,
    memoryPercent: null,
    exitCode: null,
    restartCount: 0,
    lastError: null,
    raw: {},
  };
}

const services: NormalizedService[] = [
  serviceFixture("RUNNING"),
  serviceFixture("STARTING"),
  serviceFixture("STOPPING"),
  serviceFixture("STOPPED"),
  serviceFixture("EXITED"),
  serviceFixture("FAILED"),
  serviceFixture("UNKNOWN"),
];

function renderPanel() {
  return render(
    <ServiceListPanel
      services={services}
      selectedName={null}
      busyServices={new Set()}
      onSelect={vi.fn()}
      onAction={vi.fn()}
    />,
  );
}

describe("ServiceListPanel", () => {
  it("uses the same active, stopped, and failed grouping in its summary", () => {
    renderPanel();

    expect(screen.getByText("活动中 3")).not.toBeNull();
    expect(screen.getByText("已停止 2")).not.toBeNull();
    expect(screen.getByText("异常 2")).not.toBeNull();
    expect(screen.getByRole("region", { name: "服务列表，可滚动" }).className).toContain("focus-visible:ring-ring/80");
  });

  it("keeps STOPPING in the active filter instead of the stopped filter", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: /筛选服务状态/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "已停止" }));

    expect(screen.getByRole("button", { name: /^service-stopped，/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^service-exited，/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^service-stopping，/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /筛选服务状态/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "活动中" }));

    expect(screen.getByRole("button", { name: /^service-running，/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^service-starting，/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^service-stopping，/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^service-stopped，/ })).toBeNull();
  });

  it("groups FAILED and UNKNOWN under the abnormal filter", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: /筛选服务状态/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "异常" }));

    expect(screen.getByRole("button", { name: /^service-failed，/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^service-unknown，/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^service-stopped，/ })).toBeNull();
  });
});
