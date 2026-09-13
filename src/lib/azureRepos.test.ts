// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  azurePrContext,
  discoverAzurePrs,
  loadAzurePrAssociations,
  azurePrUrl,
  findAzurePrs,
  loadAzurePrAssociation,
  parseAzurePrLocation,
  readAzurePrSection,
  saveAzurePrAssociation,
  type AzurePrAssociation,
} from "./azureRepos";
import { loadWatchers, removeWatcher } from "./watchers";

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

const association: AzurePrAssociation = {
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

it("isolates associations by exact checkout, branch and session and recovers malformed storage", () => {
  saveAzurePrAssociation(
    association,
    association.cwd,
    association.branch,
    association.sourceSessionId,
  );
  expect(
    loadAzurePrAssociation(association.cwd, "feature", "session-a")?.revision,
  ).toBe("source:target");
  expect(
    loadAzurePrAssociation("/work/repo", "feature", "session-a"),
  ).toBeNull();
  expect(
    loadAzurePrAssociation(association.cwd, "main", "session-a"),
  ).toBeNull();
  expect(
    loadAzurePrAssociation(association.cwd, "feature", "session-b"),
  ).toBeNull();
  for (let i = 0; i < 105; i++)
    saveAzurePrAssociation(
      { ...association, cwd: `/repo-${i}` },
      `/repo-${i}`,
      "feature",
      "session-a",
    );
  expect(
    JSON.parse(localStorage.getItem("monocode.azurePrAssociations.v1")!),
  ).toHaveLength(100);
  localStorage.setItem("monocode.azurePrAssociations.v1", "broken");
  expect(
    loadAzurePrAssociation(association.cwd, "feature", "session-a"),
  ).toBeNull();
  saveAzurePrAssociation(
    association,
    association.cwd,
    association.branch,
    association.sourceSessionId,
  );
  expect(
    loadAzurePrAssociation(association.cwd, "feature", "session-a"),
  ).not.toBeNull();
});

it("hands off only the chosen thread with account, checkout, session and Azure iteration context", () => {
  const result = azurePrContext(association, {
    id: 42,
    status: "active",
    threadContext: { filePath: "/file.ts", rightFileStart: { line: 12 } },
    pullRequestThreadContext: {
      iterationContext: {
        firstComparingIteration: 1,
        secondComparingIteration: 3,
      },
    },
    comments: [
      { id: 1, content: "Fix this", author: { displayName: "Reviewer" } },
      { id: 2, content: "Deleted", isDeleted: true },
    ],
  });
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].origin).toContain("account-a");
  expect(result.entries[0].origin).toContain("wsl://Ubuntu/work/repo");
  expect(result.entries[0].origin).toContain("session-a");
  expect(result.entries[0].text).toContain("source:target");
  expect(result.entries[0].text).toContain("1 → 3");
  expect(result.entries[0].text).toContain("right line 12");
  expect(result.entries[0].text).not.toContain("Deleted");
});

it("discovers multiple story PRs before branch matches, deduplicates identity, and isolates denied sources", async () => {
  vi.mocked(invoke).mockImplementation(async (command, raw) => {
    const args = raw as {
      provider?: string;
      target: typeof association.target;
    };
    if (command === "azure_pr_story_links") {
      if (args.provider === "jira") throw new Error("Jira denied access");
      return {
        links: [13, 14].map(
          (id) =>
            `https://dev.azure.com/team/project-id/_git/repo-id/pullrequest/${id}`,
        ),
        more: false,
      };
    }
    if (command === "azure_pr_remotes")
      return {
        items: [
          {
            name: "origin",
            url: "git@ssh.dev.azure.com:v3/team/project-id/repo-id",
          },
          {
            name: "other",
            url: "https://dev.azure.com/other/project/_git/repo",
          },
        ],
        more: false,
      };
    if (command === "azure_pr_list")
      return {
        target: args.target,
        projectName: "Project",
        repositoryName: "repo",
        nextSkip: args.target.number ? null : 50,
        items: (args.target.number ? [args.target.number] : [13, 15]).map(
          (number) => ({ ...association.pr, pullRequestId: number }),
        ),
      };
    throw new Error(command);
  });
  const result = await discoverAzurePrs(
    association.cwd,
    "feature",
    {
      connected: true,
      site: association.target.site,
      accountId: "account-a",
      account: "Ada",
      project: "Project",
    },
    {
      provider: "azure",
      kind: "issue",
      repo: "",
      number: 7,
      identifier: "Story 7",
      url: "https://dev.azure.com/team/project/_workitems/edit/7",
      additionalItems: [
        {
          provider: "jira",
          kind: "issue",
          repo: "",
          number: 0,
          identifier: "PROJ-8",
          url: "https://team.atlassian.net/browse/PROJ-8",
        },
      ],
    },
  );
  expect(
    result.groups.flatMap((group) => group.items.map((pr) => pr.pullRequestId)),
  ).toEqual([13, 14, 15]);
  expect(result.groups[0].origins).toEqual([
    "Story link · Story 7",
    "Branch feature · remote origin",
  ]);
  expect(result.groups[2].nextSkip).toBe(50);
  expect(result.errors.join(" ")).toContain("Jira denied access");
  expect(result.errors.join(" ")).toContain("https://dev.azure.com/other");
  expect(invoke).toHaveBeenCalledWith("azure_pr_remotes", {
    cwd: association.cwd,
    branch: "feature",
  });
  saveAzurePrAssociation(association, association.cwd, "feature", "session-a");
  const second = {
    ...association,
    target: { ...association.target, number: 14 },
    pr: { ...association.pr, pullRequestId: 14 },
  };
  saveAzurePrAssociation(second, association.cwd, "feature", "session-a");
  expect(
    loadAzurePrAssociations(association.cwd, "feature", "session-a").map(
      (row) => row.target.number,
    ),
  ).toEqual([14, 13]);
  saveAzurePrAssociation(
    null,
    association.cwd,
    "feature",
    "session-a",
    second.target,
  );
  expect(
    loadAzurePrAssociation(association.cwd, "feature", "session-a")?.target
      .number,
  ).toBe(13);
});

it("auto-watches a newly linked PR and lifts the watcher on unlink", () => {
  saveAzurePrAssociation(
    association,
    association.cwd,
    "feature",
    "session-a",
  );
  const watchers = loadWatchers();
  expect(watchers).toHaveLength(1);
  expect(watchers[0].auto).toBe(true);
  expect(watchers[0].source).toEqual({
    kind: "azure-pr",
    target: association.target,
    projectName: "Project",
    repositoryName: "repo",
    cwd: association.cwd,
    branch: "feature",
    sessionId: "session-a",
  });
  saveAzurePrAssociation(
    null,
    association.cwd,
    "feature",
    "session-a",
    association.target,
  );
  expect(loadWatchers()).toHaveLength(0);
});

it("does not resurrect a removed watcher on refresh; terminal status lifts it", () => {
  saveAzurePrAssociation(
    association,
    association.cwd,
    "feature",
    "session-a",
  );
  const watcher = loadWatchers()[0];
  removeWatcher(watcher.id);
  // A re-save of the same scope+target is a refresh — no resurrection.
  saveAzurePrAssociation(
    association,
    association.cwd,
    "feature",
    "session-a",
    association.target,
  );
  expect(loadWatchers()).toHaveLength(0);
  // Unlinked and re-linked later, then re-read as abandoned — it leaves.
  saveAzurePrAssociation(
    null,
    association.cwd,
    "feature",
    "session-a",
    association.target,
  );
  saveAzurePrAssociation(association, association.cwd, "feature", "session-a");
  expect(loadWatchers()).toHaveLength(1);
  saveAzurePrAssociation(
    { ...association, pr: { ...association.pr, status: "abandoned" } },
    association.cwd,
    "feature",
    "session-a",
    association.target,
  );
  expect(loadWatchers()).toHaveLength(0);
});

it("never auto-watches a link that is already terminal", () => {
  saveAzurePrAssociation(
    { ...association, pr: { ...association.pr, status: "completed" } },
    association.cwd,
    "feature",
    "session-a",
  );
  expect(loadWatchers()).toHaveLength(0);
});
