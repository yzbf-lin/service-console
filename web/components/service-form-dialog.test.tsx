import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ServiceFormDialog, type ServiceFormMode } from "@/components/service-form-dialog";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type {
  NormalizedProcessCandidate,
  NormalizedService,
  ServiceCreateInput,
  ServiceUpdateInput,
} from "@/lib/types";

function processFixture(overrides: Partial<NormalizedProcessCandidate> = {}): NormalizedProcessCandidate {
  return {
    pid: 42,
    parentPid: 1,
    createTime: 123.5,
    startedAt: "2026-08-28T00:00:00Z",
    processName: "celery",
    command: "uv run fba celery worker",
    cwd: "/workspace",
    username: "developer",
    ports: [],
    suggestedName: "pd-worker",
    safeEnv: { PYTHONUNBUFFERED: "1" },
    restorable: true,
    warnings: [],
    managedService: null,
    ...overrides,
  };
}

function serviceFixture(): NormalizedService {
  return {
    name: "backend",
    command: "uv run backend/run.py",
    cwd: "/workspace",
    env: {},
    autoStart: false,
    stopTimeout: 10,
    status: "STOPPED",
    pid: null,
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

function renderDialog({
  mode = "create",
  sourceProcess = null,
  sourceService = null,
  processes = [],
  getProcess,
  onSubmit,
}: {
  mode?: ServiceFormMode;
  sourceProcess?: NormalizedProcessCandidate | null;
  sourceService?: NormalizedService | null;
  processes?: NormalizedProcessCandidate[];
  getProcess?: (pid: number) => Promise<NormalizedProcessCandidate>;
  onSubmit?: (value: ServiceCreateInput | ServiceUpdateInput) => Promise<void>;
} = {}) {
  const listProcesses = vi.fn().mockResolvedValue(processes);
  const readProcess = vi.fn(getProcess ?? (async (pid: number) => (
    processes.find((candidate) => candidate.pid === pid)
    ?? sourceProcess
    ?? processFixture({ pid })
  )));
  const submit = vi.fn(onSubmit ?? (async () => undefined));
  const api = { getProcess: readProcess, listProcesses } as unknown as ServiceConsoleApiClient;
  render(
    <ServiceFormDialog
      open
      mode={mode}
      sourceService={sourceService}
      sourceProcess={sourceProcess}
      existingNames={["pd-worker"]}
      submitting={false}
      api={api}
      onOpenChange={vi.fn()}
      onSubmit={submit}
    />,
  );
  return { getProcess: readProcess, listProcesses, onSubmit: submit };
}

describe("ServiceFormDialog process import", () => {
  it("searches running processes and fills the existing create form before submission", async () => {
    const user = userEvent.setup();
    const candidate = processFixture({ warnings: ["环境变量未完整读取"] });
    const managed = processFixture({ pid: 99, processName: "managed", command: "managed --worker", managedService: "worker" });
    const { getProcess, listProcesses, onSubmit } = renderDialog({ processes: [candidate, managed] });

    await user.click(screen.getByRole("tab", { name: "运行中进程" }));
    await waitFor(() => expect(listProcesses).toHaveBeenCalledWith(""));
    expect(screen.getByText("uv run fba celery worker")).toBeTruthy();
    expect(screen.getByText("• 环境变量未完整读取")).toBeTruthy();
    expect(screen.getByText("已由服务 worker 管理")).toBeTruthy();
    expect((screen.getByRole("button", { name: "managed 不可导入：已由服务 worker 管理" }) as HTMLButtonElement).disabled).toBe(true);

    const searchInput = screen.getByRole("textbox", { name: "搜索运行中进程" });
    fireEvent.change(searchInput, { target: { value: "celery worker" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(listProcesses).toHaveBeenLastCalledWith("celery worker"));

    await user.click(screen.getByRole("button", { name: "填入 celery 的配置" }));
    await waitFor(() => expect(getProcess).toHaveBeenCalledWith(42));
    expect(screen.getByRole("status").textContent).toContain("当前进程不会被接管");
    expect(screen.getByRole("status").textContent).toContain("环境变量未完整读取");
    expect(screen.getByRole("status").textContent).toContain("先停止原进程");
    expect(screen.getByRole("status").textContent).toContain("避免重复实例或端口冲突");
    expect(screen.getByRole("status").textContent).toContain("日志从首次受管启动开始采集");
    const serviceName = screen.getByLabelText(/服务名称/) as HTMLInputElement;
    expect(serviceName.value).toBe("pd-worker-2");
    await waitFor(() => expect(document.activeElement).toBe(serviceName));
    expect((screen.getByLabelText(/启动命令/) as HTMLTextAreaElement).value).toBe("uv run fba celery worker");
    expect((screen.getByLabelText(/工作目录/) as HTMLInputElement).value).toBe("/workspace");
    expect((screen.getByLabelText(/环境变量/) as HTMLTextAreaElement).value).toContain("PYTHONUNBUFFERED");

    await user.click(screen.getByRole("button", { name: "添加服务" }));
    expect(screen.getByRole("alertdialog", { name: "仅保存服务配置？" })).toBeTruthy();
    expect(screen.getByText(/原进程仍在运行/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "添加服务" }));
    await user.click(screen.getByRole("button", { name: "仅保存配置" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      name: "pd-worker-2",
      command: "uv run fba celery worker",
      cwd: "/workspace",
      env: { PYTHONUNBUFFERED: "1" },
      auto_start: false,
      stop_timeout: 10,
    }));
  });

  it("uses a process supplied by the ports shortcut without loading the process list", () => {
    const { listProcesses } = renderDialog({
      sourceProcess: processFixture({ pid: 77, suggestedName: "beat", warnings: ["请复核启动参数"] }),
    });

    expect(screen.getByRole("status").textContent).toContain("PID 77");
    expect(screen.getByRole("status").textContent).toContain("请复核启动参数");
    expect((screen.getByLabelText(/服务名称/) as HTMLInputElement).value).toBe("beat");
    expect(listProcesses).not.toHaveBeenCalled();
  });

  it("rejects a candidate when its PID identity changes before applying", async () => {
    const user = userEvent.setup();
    const candidate = processFixture();
    renderDialog({
      processes: [candidate],
      getProcess: async () => processFixture({ createTime: 999 }),
    });

    await user.click(screen.getByRole("tab", { name: "运行中进程" }));
    await user.click(await screen.findByRole("button", { name: "填入 celery 的配置" }));

    expect((await screen.findByRole("alert")).textContent).toContain("进程身份已变化");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("rechecks whether a candidate became managed before applying", async () => {
    const user = userEvent.setup();
    const candidate = processFixture();
    renderDialog({
      processes: [candidate],
      getProcess: async () => processFixture({ managedService: "worker", restorable: false }),
    });

    await user.click(screen.getByRole("tab", { name: "运行中进程" }));
    await user.click(await screen.findByRole("button", { name: "填入 celery 的配置" }));

    expect((await screen.findByRole("alert")).textContent).toContain("已由服务 worker 管理");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["edit", "copy"] as const)("does not expose process import while in %s mode", (mode) => {
    renderDialog({ mode, sourceService: serviceFixture() });
    expect(screen.queryByRole("tablist", { name: "添加服务方式" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "运行中进程" })).toBeNull();
  });
});
