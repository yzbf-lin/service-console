import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JenkinsView } from "@/components/jenkins-view";
import type { ServiceConsoleApiClient } from "@/lib/api-client";
import type { JenkinsBuild, JenkinsInstance, JenkinsJob, JenkinsJobParameter, JenkinsQueueItem, JenkinsStageNodes } from "@/lib/types";

vi.mock("@/components/xterm-log-viewer", () => ({
  XtermLogViewer: ({ appendRevision, appendText, text, resetKey }: { appendRevision?: number; appendText?: string; text: string; resetKey: string }) => (
    <pre data-testid="jenkins-log" data-append-revision={appendRevision} data-append-text={appendText} data-reset-key={resetKey}>{text}</pre>
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
    requiresExplicitPassword: false,
    lastBuild: { number: 42, url: "build/42", building: false, result: "SUCCESS", status: "SUCCESS" },
  };
}

function parameterFixture(
  input: Pick<JenkinsJobParameter, "name" | "type"> & Partial<Omit<JenkinsJobParameter, "name" | "type">>,
): JenkinsJobParameter {
  const choices = input.choices ?? [];
  return {
    description: "",
    defaultValue: null,
    optionsState: input.type === "choice" ? (choices.length ? "ready" : "not_loaded") : "not_applicable",
    multiple: false,
    header: "",
    ...input,
    choices,
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
  resolveJenkinsJobParameters: vi.fn(),
  listJenkinsBuilds: vi.fn(),
  getJenkinsBuild: vi.fn(),
  getJenkinsBuildStages: vi.fn(),
  getJenkinsStageNodes: vi.fn(),
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
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
    mocks.resolveJenkinsJobParameters.mockImplementation(async (_id: string, job: string) => jobFixture(job));
    mocks.listJenkinsBuilds.mockResolvedValue([buildFixture()]);
    mocks.getJenkinsBuild.mockResolvedValue(buildFixture());
    mocks.getJenkinsBuildStages.mockResolvedValue({ available: false, stages: [] });
    mocks.getJenkinsStageNodes.mockResolvedValue({ available: false, nodes: [] });
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

  it("opens a build through the selected instance Web address", async () => {
    mocks.listJenkinsInstances.mockResolvedValue([{ ...instanceA, baseUrl: "https://public.example.com/jenkins" }]);
    mocks.getJenkinsBuild.mockResolvedValue({
      ...buildFixture(),
      url: "http://jenkins.internal:8080/job/folder/job/app/42/?view=plain#console",
    });
    renderView();

    const link = await screen.findByRole("link", { name: "在 Jenkins 打开构建" });
    expect(link.getAttribute("href")).toBe(
      "https://public.example.com/jenkins/job/folder/job/app/42/?view=plain#console",
    );
  });

  it("shows Pipeline stage progress and timing for the selected build", async () => {
    mocks.listJenkinsBuilds.mockResolvedValue([buildFixture(true)]);
    mocks.getJenkinsBuild.mockResolvedValue(buildFixture(true));
    mocks.getJenkinsBuildStages.mockResolvedValue({
      available: true,
      stages: [
        { id: "1", name: "Checkout", status: "SUCCESS", startTime: 1_700_000_000_000, duration: 4_000, pauseDuration: 0 },
        {
          id: "2",
          name: "Build",
          status: "IN_PROGRESS",
          startTime: Date.now() - 8_000,
          duration: 8_000,
          pauseDuration: 0,
          nodes: [{ id: "2-1", name: "Shell Script", status: "IN_PROGRESS", startTime: Date.now() - 7_000, duration: 7_000, pauseDuration: 0, error: null }],
        },
        { id: "3", name: "Deploy", status: "NOT_EXECUTED", startTime: null, duration: 0, pauseDuration: 0 },
      ],
    });
    mocks.getJenkinsStageNodes.mockResolvedValue({
      available: true,
      nodes: [
        { id: "2-1", name: "Shell Script", status: "IN_PROGRESS", startTime: Date.now() - 7_000, duration: 7_000, pauseDuration: 0, error: null },
        { id: "2-2", name: "Publish", status: "SUCCESS", startTime: Date.now() - 2_000, duration: 2_000, pauseDuration: 0, error: null },
      ],
    });
    renderView();

    expect(await screen.findByText(/Pipeline · 选择构建查看 Stage/)).toBeTruthy();
    const panel = await screen.findByRole("region", { name: "Jenkins Pipeline 阶段" });
    const overview = await within(panel).findByRole("list", { name: "Pipeline Stage 概览" });
    expect(within(overview).getByText("Start")).toBeTruthy();
    expect(within(overview).getByText("Checkout")).toBeTruthy();
    expect(within(overview).getByText("End")).toBeTruthy();
    const expandButton = within(panel).getByRole("button", { name: "展开 Pipeline 阶段" });
    expect(overview.parentElement).toBe(expandButton.parentElement);
    expect(expandButton.nextElementSibling).toBe(overview);
    expect(overview.parentElement?.classList.contains("flex-nowrap")).toBe(true);

    fireEvent.click(expandButton);
    await waitFor(() => expect(within(panel).getByText("当前 2/3：Build")).toBeTruthy());
    expect(within(panel).getByText("Checkout")).toBeTruthy();
    expect(within(panel).getAllByText("已完成").length).toBeGreaterThan(0);
    expect(within(panel).getByText("Build")).toBeTruthy();
    expect(within(panel).getAllByText("进行中").length).toBeGreaterThan(0);
    fireEvent.click(within(panel).getByRole("button", { name: "查看 Build 的 Node" }));
    expect(await screen.findByText("执行步骤 · Node (2)")).toBeTruthy();
    expect(screen.getByText("Shell Script")).toBeTruthy();
    expect(screen.getByText("Publish")).toBeTruthy();
    const nodeList = screen.getByLabelText("Node 执行步骤");
    expect(nodeList.querySelectorAll('[data-node-connector="true"]')).toHaveLength(1);
    const connector = nodeList.querySelector('[data-node-connector="true"]');
    expect(connector).toBeTruthy();
    expect(connector?.className).toContain("bg-warning/60");
    expect(mocks.getJenkinsStageNodes).toHaveBeenCalledWith("a", "Job A", 42, "2");
    expect(within(panel).getByText("Deploy")).toBeTruthy();
    expect(within(panel).getByText("已跳过")).toBeTruthy();
    expect(mocks.getJenkinsBuildStages).toHaveBeenCalledWith("a", "Job A", 42);
    expect(nodeList.closest('[aria-label="Jenkins Pipeline 阶段"]')).toBeNull();
    expect(nodeList.parentElement?.parentElement?.className).toContain("fixed");

    fireEvent.click(within(panel).getByRole("button", { name: "收起 Pipeline 阶段" }));
    expect(within(panel).getByRole("list", { name: "Pipeline Stage 概览" })).toBeTruthy();
    expect(within(panel).queryByText("执行步骤 · Node (2)")).toBeNull();
    expect(within(panel).queryByText("当前 2/3：Build")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "展开 Pipeline 阶段" }));
    expect(within(panel).queryByRole("list", { name: "Pipeline Stage 概览" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "查看 Build 的 Node" }));
    expect(await screen.findByRole("list", { name: "Node 执行步骤" })).toBeTruthy();
  });

  it("lazily loads Node details and keeps them cached through animated collapse and reopen", async () => {
    mocks.getJenkinsBuildStages.mockResolvedValue({
      available: true,
      stages: [{ id: "1", name: "Checkout", status: "SUCCESS", startTime: null, duration: 4_000, pauseDuration: 0 }],
    });
    const nodes: JenkinsStageNodes = {
      available: true,
      nodes: [{ id: "2", name: "Git checkout", status: "SUCCESS", startTime: null, duration: 3_000, pauseDuration: 0, error: null }],
    };
    mocks.getJenkinsStageNodes.mockResolvedValue(nodes);
    renderView();

    const panel = await screen.findByRole("region", { name: "Jenkins Pipeline 阶段" });
    fireEvent.click(within(panel).getByRole("button", { name: "展开 Pipeline 阶段" }));
    const open = await within(panel).findByRole("button", { name: "查看 Checkout 的 Node" });
    expect(mocks.getJenkinsStageNodes).not.toHaveBeenCalled();
    fireEvent.click(open);
    const nodeList = await screen.findByRole("list", { name: "Node 执行步骤" });
    expect(within(nodeList).getByText("Git checkout")).toBeTruthy();
    const disclosure = document.getElementById(open.getAttribute("aria-controls")!);
    expect(disclosure?.getAttribute("aria-hidden")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "收起 Checkout 的 Node" }));
    expect(disclosure?.getAttribute("aria-hidden")).toBe("true");
    expect(disclosure?.hasAttribute("inert")).toBe(true);
    expect(disclosure?.contains(nodeList)).toBe(true);
    expect(screen.queryByRole("list", { name: "Node 执行步骤" })).toBeNull();

    fireEvent.mouseEnter(open);
    expect(await screen.findByRole("list", { name: "Node 执行步骤" })).toBe(nodeList);
    fireEvent.mouseLeave(open);
    await waitFor(() => expect(disclosure?.getAttribute("aria-hidden")).toBe("true"));

    const refresh = deferred<JenkinsStageNodes>();
    mocks.getJenkinsStageNodes.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole("button", { name: "查看 Checkout 的 Node" }));
    expect(screen.getByRole("list", { name: "Node 执行步骤" })).toBe(nodeList);
    expect(screen.queryByText("正在读取执行步骤…")).toBeNull();
    expect(disclosure?.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(mocks.getJenkinsStageNodes).toHaveBeenCalledTimes(3));
    await act(async () => refresh.resolve({
      ...nodes,
      nodes: [...nodes.nodes, { ...nodes.nodes[0]!, id: "3", name: "Checkout done" }],
    }));
    expect(within(nodeList).getByText("Checkout done")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(disclosure?.getAttribute("aria-hidden")).toBe("true"));
  });

  it("distinguishes an unavailable Stage API from a pending stage request", async () => {
    mocks.getJenkinsBuildStages.mockResolvedValue({ available: false, stages: [] });
    renderView();

    const panel = await screen.findByRole("region", { name: "Jenkins Pipeline 阶段" });
    await waitFor(() => expect(within(panel).getByText("阶段数据不可用")).toBeTruthy());
    await waitFor(() => expect(panel.getAttribute("aria-busy")).toBe("false"));
    fireEvent.click(within(panel).getByRole("button", { name: "展开 Pipeline 阶段" }));
    expect(within(panel).getByText(/总耗时已由构建接口读取/)).toBeTruthy();
    expect(within(panel).getByText(/\/wfapi\/describe/)).toBeTruthy();
    expect(within(panel).queryByText("等待阶段数据")).toBeNull();
  });

  it("keeps Freestyle build details without requesting Pipeline stages", async () => {
    const freestyleJob = { ...jobFixture(), kind: "freestyle" };
    mocks.listJenkinsJobs.mockResolvedValue([freestyleJob]);
    mocks.getJenkinsJob.mockResolvedValue(freestyleJob);
    renderView();

    await waitFor(() => expect(mocks.getJenkinsBuild).toHaveBeenCalledWith("a", "Job A", 42));
    expect(await screen.findByText(/Freestyle · 无结构化 Stage/)).toBeTruthy();
    expect(mocks.getJenkinsBuildStages).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Jenkins Pipeline 阶段" })).toBeNull();
    expect(await screen.findByTestId("jenkins-log")).toBeTruthy();
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
      parameterFixture({ name: "DRY_RUN", type: "boolean", defaultValue: true }),
      parameterFixture({ name: "RETRIES", type: "number", defaultValue: 2 }),
      parameterFixture({ name: "SECRET", type: "password" }),
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

    expect(screen.getByRole("list", { name: "Jenkins 活动任务列表" })).toBeTruthy();
    expect(screen.getByText(/等待执行器/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "取消排队" }));
    await waitFor(() => expect(mocks.cancelJenkinsQueueItem).toHaveBeenCalledWith("a", 10));

    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    const triggerDialog = await screen.findByRole("dialog", { name: /运行/ });
    expect(triggerDialog.className).toContain("overflow-hidden");
    const parameterRegion = within(triggerDialog).getByRole("region", { name: "构建参数" });
    expect(parameterRegion.className).toContain("no-visible-scrollbar");
    expect(parameterRegion.className).toContain("overflow-x-hidden");
    expect(await screen.findByPlaceholderText("留空使用 Jenkins 默认值")).toBeTruthy();
    expect(mocks.getJenkinsJob).toHaveBeenCalledWith("a", "Job A", true);
    fireEvent.change(screen.getByLabelText(/RETRIES/), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "确认运行" }));
    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith("a", "Job A", {
      DRY_RUN: true,
      RETRIES: 3,
    }));
    expect(mocks.triggerJenkinsBuild.mock.calls[0]?.[2]).not.toHaveProperty("SECRET");
  });

  it("follows a submitted queue item to its new build instead of keeping the previous build selected", async () => {
    let submitted = false;
    const nextBuild: JenkinsBuild = {
      ...buildFixture(true),
      number: 43,
      displayName: "#43",
      fullDisplayName: "Job A #43",
      queueId: 10,
    };
    mocks.listJenkinsBuilds.mockImplementation(async () => (submitted ? [nextBuild, buildFixture()] : [buildFixture()]));
    mocks.getJenkinsBuild.mockImplementation(async (_id: string, _job: string, number: number) => (
      number === 43 ? nextBuild : buildFixture()
    ));
    mocks.triggerJenkinsBuild.mockImplementation(async () => {
      submitted = true;
      return { id: 10, url: "queue/10", location: "queue/10" };
    });
    renderView();

    await waitFor(() => expect(screen.getByRole("button", { name: /#42/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "运行" }));
    await screen.findByRole("dialog", { name: /运行/ });
    fireEvent.click(screen.getByRole("button", { name: "确认运行" }));

    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith("a", "Job A", {}));
    await waitFor(() => expect(mocks.getJenkinsBuild).toHaveBeenCalledWith("a", "Job A", 43));
    expect(screen.getByText("#43")).toBeTruthy();
  });

  it("loads Git parameter options on demand and submits the selected branch", async () => {
    const metadataJob = jobFixture("Job A", [
      parameterFixture({ name: "BRANCH", type: "choice", rawType: "GitParameterDefinition", description: "选择分支", defaultValue: "master" }),
    ]);
    const runnableJob = jobFixture("Job A", [
      { ...metadataJob.parameters[0]!, choices: ["master", "feature/api", "release"], optionsState: "ready" },
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([metadataJob]);
    mocks.getJenkinsJob.mockImplementation(async (_id: string, _job: string, includeOptions?: boolean) => (
      includeOptions ? runnableJob : metadataJob
    ));
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(runButton);
    const branchSelect = await screen.findByRole("combobox", { name: "参数 BRANCH" });
    expect(branchSelect.textContent).toContain("master");

    const user = userEvent.setup();
    await user.click(branchSelect);
    await user.click(await screen.findByRole("option", { name: "feature/api" }));
    await user.click(screen.getByRole("button", { name: "确认运行" }));

    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith("a", "Job A", {
      BRANCH: "feature/api",
    }));
    expect(mocks.getJenkinsJob).toHaveBeenCalledWith("a", "Job A", true);
    expect(mocks.getJenkinsJob.mock.calls.some((call) => call.length === 2)).toBe(true);
  });

  it("renders a FileSystem List single-select and submits only a returned option", async () => {
    const metadataJob = jobFixture("Job A", [
      parameterFixture({
        name: "ARTIFACT",
        type: "choice",
        rawType: "alex.jenkins.plugins.FileSystemListParameterDefinition",
      }),
    ]);
    const runnableJob = jobFixture("Job A", [
      {
        ...metadataJob.parameters[0]!,
        defaultValue: "artifact-a.zip",
        choices: ["artifact-a.zip", "artifact-b.zip"],
        optionsState: "ready",
      },
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([metadataJob]);
    mocks.getJenkinsJob.mockImplementation(async (_id: string, _job: string, includeOptions?: boolean) => (
      includeOptions ? runnableJob : metadataJob
    ));
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(runButton);
    const artifactSelect = await screen.findByRole("combobox", { name: "参数 ARTIFACT" });
    const user = userEvent.setup();
    await user.click(artifactSelect);
    await user.click(await screen.findByRole("option", { name: "artifact-b.zip" }));
    await user.click(screen.getByRole("button", { name: "确认运行" }));

    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith("a", "Job A", {
      ARTIFACT: "artifact-b.zip",
    }));
  });

  it("does not fall back to text input when a choice has no available options", async () => {
    const metadataJob = jobFixture("Job A", [
      parameterFixture({ name: "ARTIFACT", type: "choice" }),
    ]);
    const runnableJob = jobFixture("Job A", [
      { ...metadataJob.parameters[0]!, optionsState: "unavailable" },
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([metadataJob]);
    mocks.getJenkinsJob.mockImplementation(async (_id: string, _job: string, includeOptions?: boolean) => (
      includeOptions ? runnableJob : metadataJob
    ));
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(runButton);
    const dialog = await screen.findByRole("dialog", { name: /运行/ });
    expect(within(dialog).getByRole("alert").textContent).toContain("未能读取候选项");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect((within(dialog).getByRole("button", { name: "确认运行" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.triggerJenkinsBuild).not.toHaveBeenCalled();
  });

  it("requires an explicit password when Jenkins dynamic form parameters use classic submission", async () => {
    const metadataJob = jobFixture("Job A", [
      parameterFixture({ name: "ARTIFACT", type: "choice" }),
      parameterFixture({ name: "DEPLOY_PASSWORD", type: "password" }),
    ]);
    const runnableJob = jobFixture("Job A", [
      parameterFixture({
        name: "ARTIFACT",
        type: "choice",
        choices: ["artifact-a.zip"],
        defaultValue: "artifact-a.zip",
        optionsState: "ready",
      }),
      parameterFixture({ name: "DEPLOY_PASSWORD", type: "password" }),
    ]);
    runnableJob.requiresExplicitPassword = true;
    mocks.listJenkinsJobs.mockResolvedValue([metadataJob]);
    mocks.getJenkinsJob.mockImplementation(async (_id: string, _job: string, includeOptions?: boolean) => (
      includeOptions ? runnableJob : metadataJob
    ));
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(runButton);
    const dialog = await screen.findByRole("dialog", { name: /运行/ });
    const password = within(dialog).getByPlaceholderText("此动态参数任务必须填写") as HTMLInputElement;
    expect(password.required).toBe(true);
    expect(password.placeholder).toBe("此动态参数任务必须填写");
    const confirm = within(dialog).getByRole("button", { name: "确认运行" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await userEvent.type(password, "runtime-secret");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith("a", "Job A", {
      ARTIFACT: "artifact-a.zip",
      DEPLOY_PASSWORD: "runtime-secret",
    }));
  });

  it("shows separators but omits hidden and separator parameters from the payload", async () => {
    const parameterizedJob = jobFixture("Job A", [
      parameterFixture({ name: "GROUP", type: "separator", header: "发布选项" }),
      parameterFixture({ name: "INTERNAL_TOKEN", type: "hidden", defaultValue: "server-owned" }),
      parameterFixture({ name: "DRY_RUN", type: "boolean", defaultValue: true }),
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([parameterizedJob]);
    mocks.getJenkinsJob.mockResolvedValue(parameterizedJob);
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(runButton);
    const dialog = await screen.findByRole("dialog", { name: /运行/ });
    expect(within(dialog).getByRole("group", { name: "发布选项" })).toBeTruthy();
    expect(within(dialog).queryByText("INTERNAL_TOKEN")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认运行" }));

    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith("a", "Job A", {
      DRY_RUN: true,
    }));
  });

  it("selects and submits dynamically discovered multiple parameters", async () => {
    const user = userEvent.setup();
    const metadataJob = jobFixture("Job A", [
      parameterFixture({ name: "ARTIFACTS", type: "choice" }),
    ]);
    const runnableJob = jobFixture("Job A", [
      {
        ...metadataJob.parameters[0]!,
        choices: ["a.zip", "b.zip"],
        optionsState: "ready",
        multiple: true,
        defaultValue: ["a.zip"],
      },
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([metadataJob]);
    mocks.getJenkinsJob.mockImplementation(async (_id: string, _job: string, includeOptions?: boolean) => (
      includeOptions ? runnableJob : metadataJob
    ));
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    await user.click(runButton);
    const dialog = await screen.findByRole("dialog", { name: /运行/ });
    await user.click(within(dialog).getByRole("button", { name: /参数 ARTIFACTS/ }));
    expect(screen.getByRole("menuitemcheckbox", { name: "a.zip" }).getAttribute("data-state")).toBe("checked");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "b.zip" }));
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "确认运行" }));

    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith("a", "Job A", {
      ARTIFACTS: ["a.zip", "b.zip"],
    }));
  });

  it("falls back to the first Git option when Jenkins returns an unavailable default", async () => {
    const metadataJob = jobFixture("Job A", [
      parameterFixture({ name: "BRANCH", type: "choice", rawType: "GitParameterDefinition", description: "选择分支", defaultValue: "deleted" }),
    ]);
    const runnableJob = jobFixture("Job A", [
      { ...metadataJob.parameters[0]!, choices: ["", "main"], optionsState: "ready" },
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([metadataJob]);
    mocks.getJenkinsJob.mockImplementation(async (_id: string, _job: string, includeOptions?: boolean) => (
      includeOptions ? runnableJob : metadataJob
    ));
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(runButton);
    expect((await screen.findByRole("combobox", { name: "参数 BRANCH" })).textContent).toContain("（空值）");
    fireEvent.click(screen.getByRole("button", { name: "确认运行" }));

    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith("a", "Job A", {
      BRANCH: "",
    }));
  });

  it("ignores a stale parameter failure after switching Jenkins instances", async () => {
    const pending = deferred<JenkinsJob>();
    mocks.getJenkinsJob.mockImplementation(async (_id: string, job: string, includeOptions?: boolean) => (
      includeOptions ? pending.promise : jobFixture(job)
    ));
    const { onError } = renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(runButton);
    await waitFor(() => expect(mocks.getJenkinsJob).toHaveBeenCalledWith("a", "Job A", true));

    fireEvent.click(screen.getByText("Jenkins B").closest("button") as HTMLButtonElement);
    await waitFor(() => expect(screen.getAllByText("Job B").length).toBeGreaterThan(0));
    await act(async () => {
      pending.reject(new Error("stale parameter failure"));
      await Promise.resolve();
    });

    expect(onError.mock.calls.some(([title]) => title === "读取 Jenkins 构建参数失败")).toBe(false);
    expect(screen.queryByRole("dialog", { name: /运行/ })).toBeNull();
  });

  it("blocks local triggering when a Jenkins job requires a file parameter", async () => {
    const fileJob = jobFixture("Upload Job", [
      parameterFixture({ name: "PACKAGE", type: "file", description: "artifact" }),
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([fileJob]);
    mocks.getJenkinsJob.mockResolvedValue(fileJob);
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(true));
    expect(await screen.findByText(/文件上传参数 PACKAGE 暂不支持/)).toBeTruthy();
    fireEvent.click(runButton);
    expect(mocks.triggerJenkinsBuild).not.toHaveBeenCalled();
  });

  it("refreshes and submits reactive Active Choices parameters", async () => {
    const metadataJob = jobFixture("Reactive Job", [
      parameterFixture({ name: "ENV", type: "choice", choices: ["dev", "prod"], defaultValue: "dev" }),
      parameterFixture({ name: "MACHINE", type: "choice", rawType: "org.biouno.unochoice.CascadeChoiceParameter" }),
    ]);
    const preparedJob = jobFixture("Reactive Job", [
      metadataJob.parameters[0]!,
      parameterFixture({
        name: "MACHINE",
        type: "choice",
        rawType: "org.biouno.unochoice.CascadeChoiceParameter",
        choices: ["dev-a", "dev-b"],
        defaultValue: "dev-a",
        references: ["ENV"],
      }),
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([metadataJob]);
    mocks.getJenkinsJob.mockImplementation(async (_id: string, _job: string, includeOptions?: boolean) => (
      includeOptions ? preparedJob : metadataJob
    ));
    mocks.resolveJenkinsJobParameters.mockImplementation(async (_id: string, _job: string, parameters: Record<string, unknown>) => {
      const environment = String(parameters.ENV ?? "dev");
      return jobFixture("Reactive Job", [
        metadataJob.parameters[0]!,
        parameterFixture({
          name: "MACHINE",
          type: "choice",
          rawType: "org.biouno.unochoice.CascadeChoiceParameter",
          choices: [`${environment}-a`, `${environment}-b`],
          defaultValue: `${environment}-a`,
          references: ["ENV"],
        }),
      ]);
    });
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    const user = userEvent.setup();
    await user.click(runButton);
    await user.click(await screen.findByRole("combobox", { name: "参数 ENV" }));
    await user.click(await screen.findByRole("option", { name: "prod" }));
    await waitFor(() => expect(mocks.resolveJenkinsJobParameters).toHaveBeenLastCalledWith(
      "a",
      "Reactive Job",
      expect.objectContaining({ ENV: "prod" }),
    ));
    const machine = await screen.findByRole("combobox", { name: "参数 MACHINE" });
    await user.click(machine);
    await user.click(await screen.findByRole("option", { name: "prod-b" }));
    await user.click(screen.getByRole("button", { name: "确认运行" }));

    await waitFor(() => expect(mocks.triggerJenkinsBuild).toHaveBeenCalledWith(
      "a",
      "Reactive Job",
      { ENV: "prod", MACHINE: "prod-b" },
    ));
  });

  it("uses a generic unsupported message for non-reactive plugin controls", async () => {
    const radioJob = jobFixture("Radio Job", [
      parameterFixture({ name: "MODE", type: "unsupported", rawType: "PT_RADIO" }),
    ]);
    mocks.listJenkinsJobs.mockResolvedValue([radioJob]);
    mocks.getJenkinsJob.mockResolvedValue(radioJob);
    renderView();

    const runButton = await screen.findByRole("button", { name: "运行" });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(true));
    expect(await screen.findByText(/参数 MODE 的类型暂不支持/)).toBeTruthy();
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
    expect(screen.getByTestId("jenkins-log").getAttribute("data-append-text")).toBe("second");
    expect(screen.getByTestId("jenkins-log").getAttribute("data-append-revision")).toBe("2");
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
      expect(screen.queryByRole("region", { name: "Jenkins 活动任务" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "活动任务" }));
      expect(screen.queryByRole("region", { name: "Jenkins 实例与任务" })).toBeNull();
      expect(screen.getByRole("region", { name: "Jenkins 活动任务" })).toBeTruthy();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
    }
  });
});
