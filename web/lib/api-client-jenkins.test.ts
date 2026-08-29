import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "@/lib/api-client";
import type { JenkinsInstanceInput } from "@/lib/types";

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

const rawInstance = {
  id: "prod/id",
  name: "生产 Jenkins",
  base_url: "https://jenkins.example.com",
  username: "builder",
  ca_bundle: "C:\\certs\\ca.pem",
  enabled: true,
  request_timeout: 20,
  token_present: true,
  credential_error: null,
};

const input: JenkinsInstanceInput = {
  name: "生产 Jenkins",
  base_url: "https://jenkins.example.com",
  username: "builder",
  ca_bundle: "C:\\certs\\ca.pem",
  enabled: true,
  request_timeout: 20,
};

const rawBuild = {
  number: 42,
  url: "https://jenkins.example.com/job/folder/job/42/",
  display_name: "#42",
  full_display_name: "folder/job #42",
  building: true,
  result: null,
  status: "RUNNING",
  timestamp: 1_700_000_000_000,
  duration: 5_000,
  estimated_duration: 30_000,
  queue_id: 9,
  description: "deploy",
};

describe("Jenkins API client", () => {
  it("uses explicit instance ids for CRUD and never requires token echo", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    [
      { instances: [rawInstance] },
      { instance: rawInstance },
      { instance: { ...rawInstance, name: "生产 Jenkins 2" } },
      { connection: { ok: true, version: "2.492", url: rawInstance.base_url } },
      { deleted: rawInstance.id },
    ].forEach((payload) => fetchMock.mockResolvedValueOnce(json(payload)));
    const client = createApiClient({ fetch: fetchMock });

    await expect(client.listJenkinsInstances()).resolves.toEqual([expect.objectContaining({
      id: "prod/id",
      baseUrl: rawInstance.base_url,
      tokenPresent: true,
    })]);
    await client.createJenkinsInstance({ ...input, token: "secret" });
    await client.updateJenkinsInstance(rawInstance.id, { ...input, name: "生产 Jenkins 2" });
    await expect(client.testJenkinsInstance(rawInstance.id)).resolves.toMatchObject({ ok: true, version: "2.492" });
    await client.deleteJenkinsInstance(rawInstance.id);

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/api/jenkins/instances", undefined],
      ["/api/jenkins/instances", "POST"],
      ["/api/jenkins/instances/prod%2Fid", "PUT"],
      ["/api/jenkins/instances/prod%2Fid/test", "POST"],
      ["/api/jenkins/instances/prod%2Fid", "DELETE"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ token: "secret" });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).not.toHaveProperty("token");
  });

  it("normalizes parameter classes and covers Job, Build, Queue and progressive log operations", async () => {
    const rawJob = {
      name: "job",
      full_name: "folder/job",
      url: "https://jenkins.example.com/job/folder/job/",
      kind: "WorkflowJob",
      color: "blue_anime",
      status: "RUNNING",
      buildable: true,
      in_queue: false,
      description: "发布",
      requires_explicit_password: true,
      parameters: [
        { name: "DRY_RUN", type: "BooleanParameterDefinition", description: "dry", default: true, choices: null },
        { name: "RETRIES", type: "IntegerParameterDefinition", description: "times", default: 2, choices: null },
        { name: "ENV", type: "ChoiceParameterDefinition", description: "env", default: "test", choices: ["test", "prod"] },
        { name: "BRANCH", type: "choice", raw_type: "GitParameterDefinition", description: "branch", default: "master", choices: ["master", "feature/api"] },
        {
          name: "ARTIFACT",
          type: "file",
          raw_type: "alex.jenkins.plugins.FileSystemListParameterDefinition",
          description: "artifact",
          default: null,
          choices: null,
          options_state: "unavailable",
          multiple: false,
        },
        { name: "GROUP", type: "separator", description: "", default: null, choices: null, options_state: "not_applicable", multiple: false, header: "发布选项" },
        { name: "INTERNAL", type: "string", raw_type: "com.wangyin.parameter.WHideParameterDefinition", description: "", default: "hidden", choices: null },
      ],
      last_build: rawBuild,
    };
    const fetchMock = vi.fn<typeof fetch>();
    [
      { folder: "folder", jobs: [{ ...rawJob, last_build: { ...rawBuild, number: 0 } }] },
      { job: rawJob },
      { job: rawJob },
      { job: "folder/job", builds: [{ ...rawBuild, number: 0 }, rawBuild] },
      { build: rawBuild },
      { queue: { id: 10, url: "queue/10", location: "queue/10" } },
      { build: { job: "folder/job", number: 42, stopped: true } },
      { queue: [
        { id: 0, url: "queue/0", blocked: false, buildable: true, stuck: false, why: "invalid", task: { name: "invalid" }, executable: null },
        { id: 10, url: "queue/10", blocked: false, buildable: true, stuck: false, why: "waiting", task: { name: "job", full_name: "folder/job", url: "job", color: "blue" }, executable: null },
      ] },
      { queue: { id: 10, cancelled: true } },
      { log: { job: "folder/job", number: 42, offset: 128, next_offset: 256, text: "next", more: true, complete: false } },
    ].forEach((payload) => fetchMock.mockResolvedValueOnce(json(payload)));
    const client = createApiClient({ fetch: fetchMock });

    const listedJobs = await client.listJenkinsJobs(rawInstance.id, "folder", "deploy");
    expect(listedJobs[0]?.lastBuild).toBeNull();
    const job = await client.getJenkinsJob(rawInstance.id, "folder/job");
    expect(job.parameters.map((parameter) => parameter.type)).toEqual([
      "boolean",
      "number",
      "choice",
      "choice",
      "choice",
      "separator",
      "hidden",
    ]);
    expect(job.parameters[4]).toMatchObject({ optionsState: "unavailable", multiple: false });
    expect(job.parameters[5]).toMatchObject({ header: "发布选项", optionsState: "not_applicable" });
    expect(job.requiresExplicitPassword).toBe(true);
    const jobWithOptions = await client.getJenkinsJob(rawInstance.id, "folder/job", true);
    expect(jobWithOptions.parameters.find((parameter) => parameter.name === "BRANCH")?.choices).toEqual(["master", "feature/api"]);
    await expect(client.listJenkinsBuilds(rawInstance.id, "folder/job", 25)).resolves.toEqual([
      expect.objectContaining({ number: 42 }),
    ]);
    await client.getJenkinsBuild(rawInstance.id, "folder/job", 42);
    await client.triggerJenkinsBuild(rawInstance.id, "folder/job", { DRY_RUN: true });
    await client.stopJenkinsBuild(rawInstance.id, "folder/job", 42);
    await expect(client.listJenkinsQueue(rawInstance.id)).resolves.toEqual([
      expect.objectContaining({ id: 10 }),
    ]);
    await client.cancelJenkinsQueueItem(rawInstance.id, 10);
    await expect(client.getJenkinsBuildLog(rawInstance.id, "folder/job", 42, 128)).resolves.toMatchObject({
      offset: 128,
      nextOffset: 256,
      more: true,
    });

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/api/jenkins/instances/prod%2Fid/jobs?folder=folder&query=deploy", undefined],
      ["/api/jenkins/instances/prod%2Fid/job?job=folder%2Fjob", undefined],
      ["/api/jenkins/instances/prod%2Fid/job?job=folder%2Fjob&include_parameter_options=true", undefined],
      ["/api/jenkins/instances/prod%2Fid/builds?job=folder%2Fjob&limit=25", undefined],
      ["/api/jenkins/instances/prod%2Fid/builds/42?job=folder%2Fjob", undefined],
      ["/api/jenkins/instances/prod%2Fid/builds?job=folder%2Fjob", "POST"],
      ["/api/jenkins/instances/prod%2Fid/builds/42/stop?job=folder%2Fjob", "POST"],
      ["/api/jenkins/instances/prod%2Fid/queue", undefined],
      ["/api/jenkins/instances/prod%2Fid/queue/10/cancel", "POST"],
      ["/api/jenkins/instances/prod%2Fid/builds/42/log?job=folder%2Fjob&start=128", undefined],
    ]);
  });
});
