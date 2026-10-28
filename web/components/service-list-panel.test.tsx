import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ServiceListPanel } from "@/components/service-list-panel";
import type { NormalizedService, ServiceStatus } from "@/lib/types";

function serviceFixture(
  status: ServiceStatus,
  overrides: Partial<NormalizedService> = {},
): NormalizedService {
  return {
    name: `service-${status.toLowerCase()}`,
    group: null,
    sortOrder: 0,
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
    ...overrides,
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
      groups={[]}
      selectedName={null}
      busyServices={new Set()}
      busyGroups={new Set()}
      onDeleteGroup={vi.fn()}
      onMoveService={vi.fn()}
      onGroupAction={vi.fn()}
      onSelect={vi.fn()}
      onAction={vi.fn()}
    />,
  );
}

function pointAt(element: HTMLElement) {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => element,
  });
}

const POINTER = { button: 0, buttons: 1, isPrimary: true, pointerId: 1 } as const;

function handleOf(container: HTMLElement, service: string) {
  const handle = container.querySelector<HTMLElement>(`[data-service-drag-handle="${service}"]`);
  expect(handle).not.toBeNull();
  return handle as HTMLElement;
}

function stubRect(element: HTMLElement) {
  element.getBoundingClientRect = () => ({
    bottom: 100,
    height: 100,
    left: 0,
    right: 100,
    top: 0,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

/**
 * dnd-kit arms a drag only once the pointer travels past its 4px activation distance, and the move
 * that crosses that threshold starts the drag instead of reporting a position — so the drop target
 * is only known from the third move onwards.
 */
function startDrag(handle: HTMLElement, clientY: number) {
  fireEvent.pointerDown(handle, { ...POINTER, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(document, { ...POINTER, clientX: 1, clientY: 1 });
  fireEvent.pointerMove(document, { ...POINTER, clientX: 5, clientY: 5 });
  fireEvent.pointerMove(document, { ...POINTER, clientX: 10, clientY });
}

function endDrag(clientY: number) {
  fireEvent.pointerUp(document, { ...POINTER, clientX: 10, clientY });
}

async function dragServiceTo(
  container: HTMLElement,
  service: string,
  target: HTMLElement,
  clientY = 1,
) {
  const handle = handleOf(container, service);
  pointAt(target);
  startDrag(handle, clientY);
  endDrag(clientY);
  // Let the awaited move (and its landing-ghost teardown) settle inside act.
  await act(async () => {});
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

  it("places Add service in the service content header", async () => {
    const user = userEvent.setup();
    const onAddService = vi.fn();
    render(
      <ServiceListPanel
        services={services}
        groups={[]}
        selectedName={null}
        busyServices={new Set()}
        busyGroups={new Set()}
        onDeleteGroup={vi.fn()}
        onMoveService={vi.fn()}
        onGroupAction={vi.fn()}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        onAddService={onAddService}
      />,
    );

    await user.click(screen.getByRole("button", { name: "添加服务" }));
    expect(onAddService).toHaveBeenCalledOnce();
  });

  it("runs one-click start and stop actions for a group", async () => {
    const user = userEvent.setup();
    const onGroupAction = vi.fn();
    render(
      <ServiceListPanel
        services={[
          serviceFixture("STOPPED", { name: "api", group: "后端" }),
          serviceFixture("RUNNING", { name: "worker", group: "后端" }),
        ]}
        groups={["后端"]}
        selectedName={null}
        busyServices={new Set()}
        busyGroups={new Set()}
        onDeleteGroup={vi.fn()}
        onMoveService={vi.fn()}
        onGroupAction={onGroupAction}
        onSelect={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "启动分组 后端" }));
    await user.click(screen.getByRole("button", { name: "停止分组 后端" }));
    expect(onGroupAction).toHaveBeenNthCalledWith(1, "后端", "start");
    expect(onGroupAction).toHaveBeenNthCalledWith(2, "后端", "stop");
  });

  it("moves a service into a group by drag and drop", async () => {
    const onMoveService = vi.fn();
    const { container } = render(
      <ServiceListPanel
        services={[serviceFixture("STOPPED", { name: "api", group: null })]}
        groups={["后端"]}
        selectedName={null}
        busyServices={new Set()}
        busyGroups={new Set()}
        onDeleteGroup={vi.fn()}
        onMoveService={onMoveService}
        onGroupAction={vi.fn()}
        onSelect={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    const target = screen.getByRole("region", { name: "后端" });

    await dragServiceTo(container, "api", target);

    expect(onMoveService).toHaveBeenCalledWith("api", "后端", 0);
  });

  it("moves a service back and forth between different groups", async () => {
    const onMoveService = vi.fn();

    function Harness() {
      const [group, setGroup] = useState<string | null>("后端");
      return (
        <ServiceListPanel
          services={[
            serviceFixture("STOPPED", { name: "api", group }),
            serviceFixture("RUNNING", { name: "worker", group: "任务" }),
          ]}
          groups={["后端", "任务"]}
          selectedName={null}
          busyServices={new Set()}
          busyGroups={new Set()}
          onDeleteGroup={vi.fn()}
          onMoveService={(service, nextGroup, position) => {
            onMoveService(service, nextGroup, position);
            setGroup(nextGroup);
          }}
          onGroupAction={vi.fn()}
          onSelect={vi.fn()}
          onAction={vi.fn()}
        />
      );
    }

    const { container } = render(<Harness />);
    const backend = screen.getByRole("region", { name: "后端" });
    const tasks = screen.getByRole("region", { name: "任务" });
    const worker = tasks.querySelector<HTMLElement>('[data-service="worker"]');

    expect(backend.querySelector('[data-service="api"]')).not.toBeNull();
    expect(worker).not.toBeNull();
    await dragServiceTo(container, "api", worker as HTMLElement);
    expect(tasks.querySelector('[data-service="api"]')).not.toBeNull();

    await dragServiceTo(container, "api", backend);
    expect(backend.querySelector('[data-service="api"]')).not.toBeNull();
    expect(onMoveService).toHaveBeenNthCalledWith(1, "api", "任务", 1);
    expect(onMoveService).toHaveBeenNthCalledWith(2, "api", "后端", 0);
  });

  it("shows an animated landing placeholder and persists same-group ordering", async () => {
    const onMoveService = vi.fn();
    const { container } = render(
      <ServiceListPanel
        services={[
          serviceFixture("STOPPED", { name: "third", group: "后端", sortOrder: 2 }),
          serviceFixture("STOPPED", { name: "first", group: "后端", sortOrder: 0 }),
          serviceFixture("STOPPED", { name: "second", group: "后端", sortOrder: 1 }),
        ]}
        groups={["后端"]}
        selectedName={null}
        busyServices={new Set()}
        busyGroups={new Set()}
        onDeleteGroup={vi.fn()}
        onMoveService={onMoveService}
        onGroupAction={vi.fn()}
        onSelect={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    const renderedOrder = [...container.querySelectorAll<HTMLElement>("[data-service]")]
      .map((element) => element.dataset.service);
    expect(renderedOrder).toEqual(["first", "second", "third"]);

    const source = container.querySelector<HTMLElement>('[data-service-drag-handle="third"]');
    const target = container.querySelector<HTMLElement>('[data-service-drop-item="first"]');
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();
    stubRect(target as HTMLElement);
    pointAt(target as HTMLElement);

    startDrag(source as HTMLElement, 10);

    const placeholder = screen.getByLabelText("third 的预计落点");
    expect(placeholder.hasAttribute("data-service-drop-preview")).toBe(true);
    expect(placeholder.compareDocumentPosition(target as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    endDrag(10);
    await act(async () => {});
    expect(onMoveService).toHaveBeenCalledWith("third", "后端", 0);
  });

  it("keeps the landing ghost visible until the new order is persisted", async () => {
    let finishMove: (() => void) | undefined;
    const onMoveService = vi.fn(() => new Promise<void>((resolve) => {
      finishMove = resolve;
    }));
    const { container } = render(
      <ServiceListPanel
        services={[
          serviceFixture("STOPPED", { name: "first", group: "后端", sortOrder: 0 }),
          serviceFixture("STOPPED", { name: "second", group: "后端", sortOrder: 1 }),
        ]}
        groups={["后端"]}
        selectedName={null}
        busyServices={new Set()}
        busyGroups={new Set()}
        onDeleteGroup={vi.fn()}
        onMoveService={onMoveService}
        onGroupAction={vi.fn()}
        onSelect={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    const source = container.querySelector<HTMLElement>('[data-service-drag-handle="second"]');
    const target = container.querySelector<HTMLElement>('[data-service-drop-item="first"]');
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();
    stubRect(target as HTMLElement);
    pointAt(target as HTMLElement);

    startDrag(source as HTMLElement, 10);
    endDrag(10);

    expect(screen.getByLabelText("second 的预计落点")).not.toBeNull();
    expect(onMoveService).toHaveBeenCalledWith("second", "后端", 0);

    await act(async () => finishMove?.());
    expect(screen.queryByLabelText("second 的预计落点")).toBeNull();
  });
});
