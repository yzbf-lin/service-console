import { describe, expect, it } from "vitest";

import { resolveJenkinsBuildUrl } from "@/lib/jenkins";

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
