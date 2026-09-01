import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ServiceActionsMenu, ServiceLifecycleToolbar } from "@/components/service-actions";
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

describe("ServiceLifecycleToolbar", () => {
  it("renders Start as a native disabled button while the service is RUNNING", () => {
    const onAction = vi.fn();
    render(
      <ServiceLifecycleToolbar
        service={serviceFixture("RUNNING")}
        busy={false}
        onAction={onAction}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "服务生命周期操作" });
    const startButton = within(toolbar).getByRole("button", { name: "启动" }) as HTMLButtonElement;

    expect(startButton).toBeInstanceOf(HTMLButtonElement);
    expect(startButton.disabled).toBe(true);
    expect(startButton.hasAttribute("disabled")).toBe(true);
    expect(startButton.getAttribute("aria-disabled")).toBe("true");
    expect(within(startButton).getByText("启动").className).not.toContain("sr-only");

    const reasonId = startButton.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId ?? "")?.textContent).toBe("启动不可用：服务已在运行");

    fireEvent.click(startButton);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("enables Start for a STOPPED service and dispatches the start action", () => {
    const onAction = vi.fn();
    render(
      <ServiceLifecycleToolbar
        service={serviceFixture("STOPPED")}
        busy={false}
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

  it("disables every lifecycle action while another action is busy", () => {
    const onAction = vi.fn();
    render(
      <ServiceLifecycleToolbar
        service={serviceFixture("RUNNING")}
        busy
        onAction={onAction}
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "服务生命周期操作" });
    expect(toolbar.getAttribute("aria-busy")).toBe("true");
    for (const label of ["启动", "停止", "重启"]) {
      const button = within(toolbar).getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("aria-describedby")).not.toBeNull();
      fireEvent.click(button);
    }

    expect(within(toolbar).getByRole("status").textContent).toContain("处理中");
    expect(toolbar.querySelector(".animate-spin")?.closest("button")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("restores focus to the actions trigger after the menu closes", async () => {
    const user = userEvent.setup();
    render(
      <ServiceActionsMenu
        service={serviceFixture("STOPPED")}
        busy={false}
        onAction={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "打开 pd-qa-backend 操作菜单" });
    await user.click(trigger);
    expect(await screen.findByRole("menu")).not.toBeNull();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
