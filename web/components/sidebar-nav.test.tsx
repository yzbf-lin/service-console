import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SidebarNav } from "@/components/sidebar-nav";

describe("SidebarNav information architecture", () => {
  it("keeps only workspace destinations in the menu and Settings in the lower section", () => {
    const { container } = render(
      <SidebarNav activeView="services" onViewChange={vi.fn()} />,
    );
    const navigation = screen.getByRole("navigation", { name: "功能导航" });
    const primary = container.querySelector<HTMLElement>('[data-nav-section="primary"]');
    const secondary = container.querySelector<HTMLElement>('[data-nav-section="secondary"]');

    expect(primary).not.toBeNull();
    expect(secondary).not.toBeNull();
    expect(primary?.parentElement).toBe(navigation);
    expect(secondary?.parentElement).toBe(navigation);
    expect(navigation.firstElementChild).toBe(primary);
    expect(navigation.lastElementChild).toBe(secondary);
    expect(primary?.nextElementSibling).toBe(secondary);
    expect(container.querySelector('[data-nav-content="services"]')).toBeNull();

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

  it("keeps a fixed icon-only rail and reveals the destination name on hover", async () => {
    const user = userEvent.setup();
    const { container } = render(<SidebarNav activeView="services" onViewChange={vi.fn()} />);

    expect(container.querySelector("aside")?.getAttribute("data-rail")).toBe("icon-only");
    expect(screen.queryByRole("button", { name: "收起菜单栏" })).toBeNull();
    expect(screen.queryByRole("button", { name: "展开菜单栏" })).toBeNull();

    await user.hover(screen.getByRole("button", { name: "端口进程" }));
    expect((await screen.findByRole("tooltip")).textContent).toContain("端口进程");
  });
});
