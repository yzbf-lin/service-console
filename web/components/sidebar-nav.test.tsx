import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidebarNav } from "@/components/sidebar-nav";

describe("SidebarNav information architecture", () => {
  it("keeps Services and Ports in the upper section and Settings in the lower section", () => {
    const { container } = render(<SidebarNav activeView="services" onViewChange={vi.fn()} />);
    const navigation = screen.getByRole("navigation", { name: "功能导航" });
    const primary = container.querySelector<HTMLElement>('[data-nav-section="primary"]');
    const secondary = container.querySelector<HTMLElement>('[data-nav-section="secondary"]');

    expect(primary).not.toBeNull();
    expect(secondary).not.toBeNull();
    expect(primary?.parentElement).toBe(navigation);
    expect(secondary?.parentElement).toBe(navigation);
    expect(navigation.firstElementChild).toBe(primary);
    expect(navigation.lastElementChild).toBe(secondary);

    expect(within(primary as HTMLElement).getByRole("button", { name: "服务控制" })).toBeTruthy();
    expect(within(primary as HTMLElement).getByRole("button", { name: "端口进程" })).toBeTruthy();
    expect(within(primary as HTMLElement).queryByRole("button", { name: "设置" })).toBeNull();

    expect(within(secondary as HTMLElement).getByRole("button", { name: "设置" })).toBeTruthy();
    expect(within(secondary as HTMLElement).queryByRole("button", { name: "服务控制" })).toBeNull();
    expect(within(secondary as HTMLElement).queryByRole("button", { name: "端口进程" })).toBeNull();
  });

  it("dispatches the selected lower-section view", () => {
    const onViewChange = vi.fn();
    render(<SidebarNav activeView="services" onViewChange={onViewChange} />);

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onViewChange).toHaveBeenCalledOnce();
    expect(onViewChange).toHaveBeenCalledWith("settings");
  });
});
