import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidebarNav } from "@/components/sidebar-nav";

describe("SidebarNav information architecture", () => {
  it("keeps Services, Ports and Jenkins above the service content and Settings in the lower section", () => {
    const { container } = render(
      <SidebarNav activeView="services" onViewChange={vi.fn()}>
        <div data-testid="service-list">服务列表</div>
      </SidebarNav>,
    );
    const navigation = screen.getByRole("navigation", { name: "功能导航" });
    const primary = container.querySelector<HTMLElement>('[data-nav-section="primary"]');
    const content = container.querySelector<HTMLElement>('[data-nav-content="services"]');
    const secondary = container.querySelector<HTMLElement>('[data-nav-section="secondary"]');

    expect(primary).not.toBeNull();
    expect(content).not.toBeNull();
    expect(secondary).not.toBeNull();
    expect(primary?.parentElement).toBe(navigation);
    expect(content?.parentElement).toBe(navigation);
    expect(secondary?.parentElement).toBe(navigation);
    expect(navigation.firstElementChild).toBe(primary);
    expect(navigation.lastElementChild).toBe(secondary);
    expect(primary?.nextElementSibling).toBe(content);
    expect(content?.nextElementSibling).toBe(secondary);
    expect(within(content as HTMLElement).getByTestId("service-list")).toBeTruthy();

    expect(within(primary as HTMLElement).getByRole("button", { name: /^服务控制/ }).getAttribute("aria-current")).toBe("page");
    expect(within(primary as HTMLElement).getByRole("button", { name: /^端口进程/ })).toBeTruthy();
    expect(within(primary as HTMLElement).getByRole("button", { name: /^Jenkins/ })).toBeTruthy();
    expect(within(primary as HTMLElement).queryByRole("button", { name: /^设置/ })).toBeNull();

    expect(within(secondary as HTMLElement).getByRole("button", { name: /^设置/ })).toBeTruthy();
    expect(within(secondary as HTMLElement).queryByRole("button", { name: /^服务控制/ })).toBeNull();
    expect(within(secondary as HTMLElement).queryByRole("button", { name: /^端口进程/ })).toBeNull();
    expect(within(secondary as HTMLElement).queryByRole("button", { name: /^Jenkins/ })).toBeNull();
  });

  it("dispatches the selected lower-section view", () => {
    const onViewChange = vi.fn();
    render(<SidebarNav activeView="services" onViewChange={onViewChange} />);

    fireEvent.click(screen.getByRole("button", { name: /^设置/ }));
    expect(onViewChange).toHaveBeenCalledOnce();
    expect(onViewChange).toHaveBeenCalledWith("settings");
  });

  it("marks Settings when an application update is available", () => {
    const { container } = render(
      <SidebarNav activeView="services" updateAvailable onViewChange={vi.fn()} />,
    );

    expect(container.querySelector("[data-update-indicator]")).not.toBeNull();
    expect(screen.getByRole("button", { name: /设置.*有可用更新/ })).toBeTruthy();
  });
});
