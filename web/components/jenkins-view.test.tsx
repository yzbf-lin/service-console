import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JenkinsView } from "@/components/jenkins-view";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { JenkinsBuild, JenkinsInstance, JenkinsJob, JenkinsQueueItem } from "@/lib/types";

vi.mock("@/components/xterm-log-viewer", () => ({
  XtermLogViewer: ({ text, resetKey }: { text: string; resetKey: string }) => (
    <pre data-testid="jenkins-log" data-reset-key={resetKey}>{text}</pre>
  ),
}));

const instanceA: JenkinsInstance = {
  id: "a",
  name: "Jenkins A",
  baseUrl: "https://a.example.com",
  username: "builder-a",
  caBundle: "",
  enabled: true,
  requestTimeout: 15,
  tokenPresent: true,
  credentialError: null,
};

const instanceB: JenkinsInstance = {
  ...instanceA,
  id: "b",
  name: "Jenkins B",
  baseUrl: "https://b.example.com",
  username: "builder-b",
};

function jobFixture(fullName = "Job A", parameters: JenkinsJob["parameters"] = []): JenkinsJob {
  const name = fullName.split("/").at(-1) ?? fullName;
  return {
    name,
    fullName,
    url: `https://jenkins.example.com/job/${fullName}`,
    kind: "WorkflowJob",
    color: "blue",
    status: "SUCCESS",
    buildable: true,
    inQueue: false,
    description: "",
    parameters,
    lastBuild: { number: 42, url: "build/42", building: false, result: "SUCCESS", status: "SUCCESS" },
  };
}

function buildFixture(building = false): JenkinsBuild {
  return {
    number: 42,
    url: "https://jenkins.example.com/build/42",
    displayName: "#42",
    fullDisplayName: "Job A #42",
    building,
    result: building ? null : "SUCCESS",
    status: building ? "RUNNING" : "SUCCESS",
    timestamp: 1_700_000_000_000,
    duration: 5_000,
    estimatedDuration: 30_000,
    queueId: 10,
    description: "",
  };
}

function queueFixture(): JenkinsQueueItem {
  return {
    id: 10,
    url: "queue/10",
    blocked: false,
    buildable: true,
    stuck: false,
    why: "等待执行器",
    taskName: "Job A",
    taskFullName: "Job A",
    taskUrl: "job/a",
    executableNumber: null,
    executableUrl: "",
  };
}

const mocks = {
  listJenkinsInstances: vi.fn(),
  createJenkinsInstance: vi.fn(),
  updateJenkinsInstance: vi.fn(),
  deleteJenkinsInstance: vi.fn(),
  testJenkinsInstance: vi.fn(),
  listJenkinsJobs: vi.fn(),
  getJenkinsJob: vi.fn(),
  listJenkinsBuilds: vi.fn(),
  getJenkinsBuild: vi.fn(),
  triggerJenkinsBuild: vi.fn(),
  stopJenkinsBuild: vi.fn(),
  listJenkinsQueue: vi.fn(),
  cancelJenkinsQueueItem: vi.fn(),
  getJenkinsBuildLog: vi.fn(),
};

const storageValues = new Map<string, string>();
const localStorageMock: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, String(value)); },
};

function api(): ServiceConsoleApiClient {
  return mocks as unknown as ServiceConsoleApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function renderView(onError = vi.fn(), onSuccess = vi.fn()) {
  const renderResult = render(
    <JenkinsView
      active
      api={api()}
      refreshSignal={0}
      theme="dark"
      onError={onError}
      onSuccess={onSuccess}
    />,
  );
  return {
    onError,
    onSuccess,
    rerenderSignal: (refreshSignal: number) => renderResult.rerender(
      <JenkinsView
        active
        api={api()}
        refreshSignal={refreshSignal}
        theme="dark"
        onError={onError}
        onSuccess={onSuccess}
      />,
    ),
  };
}

describe("JenkinsView", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: localStorageMock });
    window.localStorage.clear();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listJenkinsInstances.mockResolvedValue([instanceA, instanceB]);
    mocks.listJenkinsJobs.mockImplementation(async (id: string) => [jobFixture(id === "b" ? "Job B" : "Job A")]);
    mocks.getJenkinsJob.mockImplementation(async (_id: string, job: string) => jobFixture(job));
    mocks.listJenkinsBuilds.mockResolvedValue([buildFixture()]);
    mocks.getJenkinsBuild.mockResolvedValue(buildFixture());
    mocks.listJenkinsQueue.mockResolvedValue([]);
    mocks.getJenkinsBuildLog.mockResolvedValue({ job: "Job A", number: 42, offset: 0, nextOffset: 4, text: "done", more: false, complete: true });
    mocks.testJenkinsInstance.mockResolvedValue({ ok: true, version: "2.492", url: instanceA.baseUrl });
    mocks.createJenkinsInstance.mockResolvedValue(instanceB);
    mocks.updateJenkinsInstance.mockResolvedValue(instanceA);
    mocks.deleteJenkinsInstance.mockResolvedValue(undefined);
    mocks.triggerJenkinsBuild.mockResolvedValue({ id: 10, url: "queue/10", location: "queue/10" });
    mocks.stopJenkinsBuild.mockResolvedValue(undefined);
    mocks.cancelJenkinsQueueItem.mockResolvedValue(undefined);
  });

  it("persists instance selection and ignores a late response from the previous instance", async () => {
    window.localStorage.setItem("service-console.jenkins.active-instance", "a");
    const pendingA = deferred<JenkinsJob[]>();
    mocks.listJenkinsJobs.mockImplementation((id: string) => id === "a" ? pendingA.promise : Promise.resolve([jobFixture("Job B")]));
    renderView();

    await waitFor(() => expect(mocks.listJenkinsJobs).toHaveBeenCalledWith("a", "", ""));
    fireEvent.click(screen.getByText("Jenkins B").closest("button") as HTMLButtonElement);
    await waitFor(() => expect(screen.getAllByText("Job B").length).toBeGreaterThan(0));

    await act(async () => pendingA.resolve([jobFixture("Job A")]));
    expect(screen.queryByText("Job A")).toBeNull();
    expect(window.localStorage.getItem("service-console.jenkins.active-instance")).toBe("b");
    expect(mocks.getJenkinsJob).toHaveBeenCalledWith("b", "Job B");
  });

  it("creates an instance with a non-echoed token and selects the returned item", async () => {
    mocks.listJenkinsInstances
      .mockResolvedValueOnce([instanceA])
      .mockResolvedValueOnce([instanceA, instanceB]);
    renderView();
    await waitFor(() => expect(screen.getByText("Jenkins A")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "添加 Jenkins 实例" }));
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Jenkins B" } });
    fireEvent.change(screen.getByLabelText("Jenkins 地址"), { target: { value: instanceB.baseUrl } });
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: instanceB.username } });
    fireEvent.change(screen.getByLabelText("API Token"), { target: { value: "fresh-token" } });
    fireEvent.click(screen.getByRole("button", { name: "添加实例" }));

    await waitFor(() => expect(mocks.createJenkinsInstance).toHaveBeenCalledWith(expect.objectContaining({
      name: "Jenkins B",
      token: "fresh-token",
    })));
    await waitFor(() => expect(window.localStorage.getItem("service-console.jenkins.active-instance")).toBe("b"));
    expect(screen.queryByDisplayValue("fresh-token")).toBeNull();
  });

  it("triggers parameterized builds, stops running builds, and cancels queue items with confirmation", async () => {
    const parameterizedJob = jobFixture("Job A", [
      { name: "DRY_RUN", type: "boolean", description: "", defaultValue: true, choices: [] },
      { name: "RETRIES", type: "number", description: "", defaultValue: 2, choices: [] },
      { name: "SECRET", type: "password", description: "", defaultValue: null, choices: [] },
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([parameterizedJob]);
    mocks.getJenkinsJob.mockResolvedValue(parameterizedJob);
    mocks.listJenkinsBuilds.mockResolvedValue([buildFixture(true)]);
    mocks.getJenkinsBuild.mockResolvedValue(buildFixture(true));
    mocks.listJenkinsQueue.mockResolvedValue([queueFixture()]);
    renderView();

    await waitFor(() => expect(screen.getByRole("button", { name: "停止构建 #42" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "停止构建 #42" }));
    fireEvent.click(screen.getByRole("button", { name: "停止构建" }));
    await waitFor(() => expect(mocks.stopJenkinsBuild).toHaveBeenCalledWith("a", "Job A", 42));

    fireEvent.click(screen.getByRole("tab", { name: /队列/ }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "取消排队" }));
    await waitFor(() => expect(mocks.cancelJenkinsQueueItem).toHaveBeenCalledWith("a", 10));

    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    expect(screen.getByPlaceholderText("留空使用 Jenkins 默认值")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/RETRIES/), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "确认运行" }));
    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith("a", "Job A", {
      DRY_RUN: true,
      RETRIES: 3,
    }));
    expect(mocks.triggerJenkinsBuild.mock.calls[0]?.[2]).not.toHaveProperty("SECRET");
  });

  it("blocks local triggering when a Jenkins job requires a file parameter", async () => {
    const fileJob = jobFixture("Upload Job", [
      { name: "PACKAGE", type: "file", description: "artifact", defaultValue: null, choices: [] },
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([fileJob]);
    mocks.getJenkinsJob.mockResolvedValue(fileJob);
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(true));
    expect(await screen.findByText(/文件参数 PACKAGE 暂不支持/)).toBeTruthy();
    fireEvent.click(runButton);
    expect(mocks.triggerJenkinsBuild).not.toHaveBeenCalled();
  });

  it("keeps successful snapshots across polling failures and deduplicates repeated errors", async () => {
    mocks.listJenkinsQueue.mockResolvedValue([queueFixture()]);
    const { onError, rerenderSignal } = renderView();
    await waitFor(() => expect(screen.getAllByText("Job A").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText("#42")).toBeTruthy());

    const transient = new Error("temporary Jenkins failure");
    mocks.listJenkinsJobs.mockRejectedValue(transient);
    mocks.listJenkinsBuilds.mockRejectedValue(transient);
    mocks.listJenkinsQueue.mockRejectedValue(transient);
    mocks.getJenkinsBuild.mockRejectedValue(transient);
    rerenderSignal(1);
    await waitFor(() => expect(onError.mock.calls.filter(([title]) => title === "读取 Jenkins 任务失败")).toHaveLength(1));
    await waitFor(() => expect(onError.mock.calls.filter(([title]) => title === "读取 Jenkins 构建失败")).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("temporary Jenkins failure")).toBeTruthy());
    expect(screen.getAllByText("Job A").length).toBeGreaterThan(0);
    expect(screen.getByText("#42")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /队列/ }));
    expect(screen.getByText(/等待执行器/)).toBeTruthy();

    rerenderSignal(2);
    await waitFor(() => expect(mocks.listJenkinsJobs.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(onError.mock.calls.filter(([title]) => title === "读取 Jenkins 任务失败")).toHaveLength(1);
    expect(onError.mock.calls.filter(([title]) => title === "读取 Jenkins 构建失败")).toHaveLength(1);

    mocks.listJenkinsJobs.mockResolvedValue([jobFixture()]);
    mocks.listJenkinsBuilds.mockResolvedValue([buildFixture()]);
    mocks.listJenkinsQueue.mockResolvedValue([queueFixture()]);
    mocks.getJenkinsBuild.mockResolvedValue(buildFixture());
    rerenderSignal(3);
    await waitFor(() => expect(screen.getByText("已连接")).toBeTruthy());

    mocks.listJenkinsJobs.mockRejectedValue(transient);
    rerenderSignal(4);
    await waitFor(() => expect(onError.mock.calls.filter(([title]) => title === "读取 Jenkins 任务失败")).toHaveLength(2));
  });

  it("polls progressive logs with the next offset", async () => {
    mocks.getJenkinsBuildLog
      .mockResolvedValueOnce({ job: "Job A", number: 42, offset: 0, nextOffset: 5, text: "first", more: true, complete: false })
      .mockRejectedValueOnce(new Error("temporary log failure"))
      .mockResolvedValueOnce({ job: "Job A", number: 42, offset: 5, nextOffset: 11, text: "second", more: false, complete: true });
    renderView();

    await waitFor(() => expect(mocks.getJenkinsBuildLog).toHaveBeenCalledWith("a", "Job A", 42, 0));
    await waitFor(() => expect(screen.getByText("temporary log failure")).toBeTruthy(), { timeout: 2_500 });
    await waitFor(() => expect(mocks.getJenkinsBuildLog).toHaveBeenCalledTimes(3), { timeout: 4_500 });
    expect(mocks.getJenkinsBuildLog.mock.calls[1]).toEqual(["a", "Job A", 42, 5]);
    expect(mocks.getJenkinsBuildLog.mock.calls[2]).toEqual(["a", "Job A", 42, 5]);
    await waitFor(() => expect(screen.getByTestId("jenkins-log").textContent).toBe("firstsecond"));
    expect(screen.queryByText("temporary log failure")).toBeNull();
  });

  it("renders only the selected content branch in narrow layout", async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("980px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) });
    try {
      renderView();
      await waitFor(() => expect(screen.getByRole("navigation", { name: "Jenkins 移动面板" })).toBeTruthy());
      expect(screen.getByRole("region", { name: "Jenkins 实例与任务" })).toBeTruthy();
      expect(screen.queryByRole("region", { name: "Jenkins 构建与队列" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "构建 / 队列" }));
      expect(screen.queryByRole("region", { name: "Jenkins 实例与任务" })).toBeNull();
      expect(screen.getByRole("region", { name: "Jenkins 构建与队列" })).toBeTruthy();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
    }
  });
});
