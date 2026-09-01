import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ServiceControlView } from "@/components/service-control-view";

vi.mock("@/components/service-list-panel", () => ({
  ServiceListPanel: ({ onAddService }: { onAddService?: () => void }) => (
    <section data-testid="service-list-panel">
      {onAddService ? <button type="button" onClick={onAddService}>服务列表添加</button> : null}
    </section>
  ),
}));
vi.mock("@/components/terminal-console", () => ({ TerminalConsole: () => <div>终端日志</div> }));
vi.mock("@/components/service-inspector", () => ({ ServiceInspector: () => <div>服务状态</div> }));

describe("ServiceControlView layout", () => {
  it("owns the service list and its add action inside the service content area", () => {
    const onAddService = vi.fn();
    render(
      <ServiceControlView
        services={[]}
        groups={[]}
        selectedName={null}
        selectedService={null}
        logs={[]}
        logRevision={0}
        busyServices={new Set()}
        busyGroups={new Set()}
        theme="dark"
        active
        onSelect={vi.fn()}
        onAction={vi.fn()}
        onAddService={onAddService}
        onCreateGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        onMoveService={vi.fn()}
        onGroupAction={vi.fn()}
        onClearLogs={vi.fn()}
      />,
    );

    const view = screen.getByRole("main", { name: "服务控制" });
    const serviceList = within(view).getByTestId("service-list-panel");
    expect(serviceList.parentElement).toBe(view);
    fireEvent.click(within(serviceList).getByRole("button", { name: "服务列表添加" }));
    expect(onAddService).toHaveBeenCalledOnce();
  });
});
