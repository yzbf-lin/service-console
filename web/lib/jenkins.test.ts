import { describe, expect, it } from "vitest";

import { formatJenkinsConsoleText, normalizeJenkinsBuildStages, normalizeJenkinsJob, resolveJenkinsBuildUrl } from "@/lib/jenkins";

describe("formatJenkinsConsoleText", () => {
  it("highlights Jenkins structure and result lines while preserving existing ANSI", () => {
    expect(formatJenkinsConsoleText([
      "[Pipeline] stage",
      "ERROR deployment failed",
      "Finished: SUCCESS",
      "\u001b[35malready colored\u001b[0m",
    ].join("\n"))).toBe([
      "\u001b[36m[Pipeline] stage\u001b[0m",
      "\u001b[1;31mERROR deployment failed\u001b[0m",
      "\u001b[32mFinished: SUCCESS\u001b[0m",
      "\u001b[35malready colored\u001b[0m",
    ].join("\n"));
  });

  it("removes terminal control sequences that Jenkins logs must not execute", () => {
    expect(formatJenkinsConsoleText("safe\u001b]52;c;clipboard\u0007\u001b[2J"))
      .toBe("safe");
  });
});

describe("resolveJenkinsBuildUrl", () => {
  it("uses the configured origin and preserves the Jenkins Job URL suffix", () => {
    expect(resolveJenkinsBuildUrl(
      "https://jenkins.example.com:9443",
      "http://jenkins.internal:8080/job/folder/job/app/42/?view=plain#console",
    )).toBe("https://jenkins.example.com:9443/job/folder/job/app/42/?view=plain#console");
  });

  it("uses the configured context path without duplicating the API URL context", () => {
    expect(resolveJenkinsBuildUrl(
      "https://jenkins.example.com/jenkins/",
      "http://jenkins.internal:8080/old-context/job/app/42/",
    )).toBe("https://jenkins.example.com/jenkins/job/app/42/");

    expect(resolveJenkinsBuildUrl(
      "https://jenkins.example.com/jenkins",
      "http://jenkins.internal:8080/jenkins/job/app/42/",
    )).toBe("https://jenkins.example.com/jenkins/job/app/42/");
  });

  it.each([
    ["/job/app/42/?view=plain#console", "https://jenkins.example.com/jenkins/job/app/42/?view=plain#console"],
    ["job/app/42/", "https://jenkins.example.com/jenkins/job/app/42/"],
    ["/jenkins/job/app/42/", "https://jenkins.example.com/jenkins/job/app/42/"],
    ["//jenkins.internal:8080/job/app/42/", "https://jenkins.example.com/jenkins/job/app/42/"],
  ])("resolves relative build URL %s", (buildUrl, expected) => {
    expect(resolveJenkinsBuildUrl("https://jenkins.example.com/jenkins", buildUrl)).toBe(expected);
  });

  it("keeps non-standard relative paths under the configured context path", () => {
    expect(resolveJenkinsBuildUrl(
      "https://jenkins.example.com/jenkins",
      "build/42?view=plain#console",
    )).toBe("https://jenkins.example.com/jenkins/build/42?view=plain#console");
  });

  it.each([
    ["", "https://jenkins.example.com/job/app/42/"],
    ["jenkins.example.com/jenkins", "https://jenkins.example.com/job/app/42/"],
    ["ftp://jenkins.example.com/jenkins", "https://jenkins.example.com/job/app/42/"],
    ["https://jenkins.example.com", ""],
    ["https://jenkins.example.com", "http://[invalid"],
    ["https://jenkins.example.com", "javascript:alert(1)"],
    ["https://jenkins.example.com", "ftp://jenkins.internal/job/app/42/"],
  ])("rejects an invalid or unsafe URL pair (%s, %s)", (baseUrl, buildUrl) => {
    expect(resolveJenkinsBuildUrl(baseUrl, buildUrl)).toBeNull();
  });
});

describe("normalizeJenkinsJob", () => {
  it("preserves string-array defaults for multi-select parameters", () => {
    const job = normalizeJenkinsJob({
      name: "deploy",
      parameters: [
        {
          name: "GROUP",
          type: "choice",
          choices: ["server-a", "server-b"],
          default: ["server-a", "server-b", 3],
          multiple: true,
          options_state: "ready",
        },
      ],
    });

    expect(job.parameters[0]).toMatchObject({
      name: "GROUP",
      defaultValue: ["server-a", "server-b"],
      multiple: true,
    });
  });
});

describe("normalizeJenkinsBuildStages", () => {
  it("normalizes the controller stage envelope and timing fields", () => {
    expect(normalizeJenkinsBuildStages({
      stages: {
        available: true,
        stages: [{
          id: 7,
          name: "Deploy",
          status: "IN_PROGRESS",
          start_time: 1_700_000_000_000,
          duration: 12_500,
          pause_duration: 300,
          nodes: [{
            id: "8",
            name: "Shell Script",
            status: "IN_PROGRESS",
            start_time: 1_700_000_000_100,
            duration: 12_000,
            pause_duration: 0,
            error: null,
          }],
        }],
      },
    })).toEqual({
      available: true,
      stages: [{
        id: "7",
        name: "Deploy",
        status: "IN_PROGRESS",
        startTime: 1_700_000_000_000,
        duration: 12_500,
        pauseDuration: 300,
        nodes: [{
          id: "8",
          name: "Shell Script",
          status: "IN_PROGRESS",
          startTime: 1_700_000_000_100,
          duration: 12_000,
          pauseDuration: 0,
          error: null,
        }],
      }],
    });
  });
});
