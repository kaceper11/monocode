// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
// @vitest-environment happy-dom
import {
  parseAzurePrLocation,
  azurePrUrl,
  findAzurePrs,
  readAzurePrSection,
} from "./azureRepos";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.clearAllMocks();
});

it("resolves explicit HTTPS/SSH locations without conflating organizations or projects", () => {
  const https = parseAzurePrLocation(
    "https://dev.azure.com/Team/Project%20A/_git/shared",
  );
  expect(https).toEqual({
    site: "https://dev.azure.com/team",
    project: "Project A",
    repository: "shared",
    number: 0,
  });
  expect(
    parseAzurePrLocation(
      "https://Team@dev.azure.com/Team/Project%20A/_git/shared",
    ),
  ).toEqual(https);
  expect(
    parseAzurePrLocation(
      "https://team.visualstudio.com/DefaultCollection/Project%20A/_git/shared",
    ),
  ).toEqual(https);
  expect(
    parseAzurePrLocation("git@ssh.dev.azure.com:v3/Team/Project%20A/shared"),
  ).toEqual(https);
  expect(
    parseAzurePrLocation(
      "ssh://git@ssh.dev.azure.com/v3/Team/Project%20A/shared",
    ),
  ).toEqual(https);
  expect(
    parseAzurePrLocation("https://dev.azure.com/Team/Project%20B/_git/shared"),
  ).not.toEqual(https);
  expect(
    parseAzurePrLocation("https://dev.azure.com/other/Project%20A/_git/shared"),
  ).not.toEqual(https);
  expect(
    parseAzurePrLocation("https://dev.azure.com/team/p/_git/r/pullrequest/13")
      .number,
  ).toBe(13);
  for (const url of [
    "https://dev.azure.com.evil.test/team/p/_git/r",
    "https://user:secret@dev.azure.com/team/p/_git/r",
    "https://dev.azure.com/team/p/_git/r?token=secret",
    "https://dev.azure.com/team/p/_git/r#fragment",
    "https://dev.azure.com/team/p/_git/r/pullrequest/0",
    "https://dev.azure.com/team/p/_git/r/pullrequest/999999999999",
    "https://dev.azure.com/team/p/_git/%2e%2e",
    "https://dev.azure.com/team/p/_git/a%2fb",
    "http://dev.azure.com/team/p/_git/r",
    "git@evil.test:v3/team/p/r",
  ])
    expect(() => parseAzurePrLocation(url), url).toThrow();
});

const association = {
  target: {
    site: "https://dev.azure.com/team",
    accountId: "account-a",
    project: "project-id",
    repository: "repo-id",
    number: 13,
  },
  account: "Ada",
  cwd: "wsl://Ubuntu/work/repo",
  branch: "feature",
  sourceSessionId: "session-a",
  revision: "source:target",
  projectName: "Project",
  repositoryName: "repo",
  pr: {
    pullRequestId: 13,
    title: "Review me",
    status: "active",
    sourceRefName: "refs/heads/feature",
    targetRefName: "refs/heads/main",
    reviewers: [],
  },
};

it("binds every read to an explicit account, repository, revision and requested page", async () => {
  await findAzurePrs(association.target, "feature", 50);
  expect(invoke).toHaveBeenCalledWith("azure_pr_list", {
    target: association.target,
    branch: "feature",
    skip: 50,
  });
  await readAzurePrSection(
    association.target,
    "source:target",
    "changes",
    100,
    3,
  );
  expect(invoke).toHaveBeenLastCalledWith("azure_pr_read", {
    target: association.target,
    section: "changes",
    expectedRevision: "source:target",
    skip: 100,
    iteration: 3,
  });
  expect(azurePrUrl(association.target)).toBe(
    "https://dev.azure.com/team/project-id/_git/repo-id/pullrequest/13",
  );
});
