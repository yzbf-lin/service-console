import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Topbar } from "@/components/topbar";

vi.mock("next/image", () => ({ default: () => <span data-testid="product-logo" /> }));

describe("Topbar", () => {
  it("keeps service-specific Add service actions out of the public toolbar", () => {
    render(
      <Topbar
        activeView="services"
        apiStatus="ok"
        socketStatus="ok"
        resolvedTheme="dark"
        refreshing={false}
        runningCount={1}
        serviceCount={2}
        selectedServiceName="api"
        onRefresh={vi.fn()}
        onToggleTheme={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "添加服务" })).toBeNull();
    expect(screen.getByRole("button", { name: "刷新服务列表" })).toBeTruthy();
  });
});
