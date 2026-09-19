import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { inboxProvider, inboxSessionDescription } from "./inboxProvider";
import type { InboxItem } from "./githubTasks";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const item: InboxItem = {
  provider: "azure",
  account: "account-a",
  kind: "pr",
  number: 7,
  title: "Review",
  url: "https://dev.azure.com/team/Product/_git/repo/pullrequest/7",
  repo: "repo",
  projectPath: "",
  state: "open",
  updatedAt: "",
  labels: [],
  assignees: [],
  draft: false,
};
it("starts GitHub sessions without a checkout lookup and keeps supplied descriptions", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("No local repository"));
  for (const provider of [undefined, "github"] as const) {
    const github = { ...item, provider, kind: "issue" as const, projectPath: "" };
    expect(await inboxSessionDescription(github)).toBeUndefined();
    expect(await inboxSessionDescription(github, "Description")).toBe("Description");
  }
  expect(await inboxSessionDescription(item, "")).toBe("");
  expect(invoke).not.toHaveBeenCalled();
});
it("keeps upstream Ask behavior for unsupported or incomplete work items", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("Unexpected detail lookup"));
  expect(await inboxSessionDescription({ ...item, provider: "linear", id: undefined })).toBeUndefined();
  expect(await inboxSessionDescription({ ...item, provider: "gitlab", kind: "ci" })).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
});
it("binds Azure summary, discussion, diff and comment writes to one displayed revision and account", async () => {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === "azure_pr_read" && args?.section === "summary")
      return {
        pr: {
          description: "Description",
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
        },
        revision: "rev-a",
      };
    if (cmd === "azure_pr_read" && args?.section === "threads")
      return {
        items: [
          {
            id: 31,
            status: "active",
            comments: [
              { id: 1, content: "First" },
              { id: 2, content: "Reply" },
            ],
            threadContext: { filePath: "a.ts", rightFileStart: { line: 8 } },
          },
        ],
        nextSkip: 50,
      };
    if (cmd === "azure_pr_read" && args?.section === "diff")
      return { items: [], nextSkip: null, revision: "rev-a" };
    return { revision: "rev-a" };
  });
  const provider = inboxProvider(item);
  const [details, thread] = await Promise.all([
    provider.details(),
    provider.thread(),
  ]);
  expect(details.headRefName).toBe("feature");
  expect(thread.truncated).toBe(true);
  expect(thread.comments[0]).toMatchObject({
    threadId: "31",
    path: "a.ts",
    line: 8,
    replies: [{ body: "Reply" }],
  });
  await provider.diff!(false);
  await provider.comment!("Follow up", { id: "31:1", threadId: "31" });
  expect(invoke).toHaveBeenCalledWith("azure_pr_thread_comment", {
    target: {
      site: "https://dev.azure.com/team",
      accountId: "account-a",
      project: "Product",
      repository: "repo",
      number: 7,
    },
    expectedRevision: "rev-a",
    threadId: 31,
    body: "Follow up",
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([cmd, args]) => cmd === "azure_pr_read" && args?.section === "summary",
      ),
  ).toHaveLength(1);
});
it("does not offer unsupported ticket writes or route a Jira read to GitHub", async () => {
  vi.mocked(invoke).mockResolvedValue({
    fields: {
      description: "Jira description",
      creator: { displayName: "Ada" },
    },
  });
  const provider = inboxProvider({
    ...item,
    provider: "jira",
    kind: "jira",
    site: "https://team.atlassian.net",
    id: "42",
    url: "https://team.atlassian.net/browse/ENG-42",
  });
  expect(provider.comment).toBeUndefined();
  expect((await provider.details()).body).toBe("Jira description");
  expect(invoke).toHaveBeenCalledWith("jira_issue_content", {
    site: "https://team.atlassian.net",
    id: "42",
    accountId: "account-a",
    comments: false,
  });
});
it("reads standalone Azure CI jobs and bounded logs using the displayed run and account", async () => {
  const delivery = {
    kind: "ci" as const,
    accountId: "account-a",
    project: "project-a",
    repository: "repo-a",
    definition: 8,
    branch: "refs/heads/main",
    commit: "commit-a",
    author: "Ada",
  };
  const target = {
    site: "https://dev.azure.com/team",
    accountId: "account-a",
    project: "project-a",
    definition: 8,
    repositoryId: "repo-a",
    repositoryType: "GitHub",
    repositoryUrl: "",
  };
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === "azure_ci_inbox_summary")
      return {
        ...item,
        delivery,
        evidence: { target, run: { id: 7, revision: "run-a" } },
      };
    if (
      cmd === "azure_ci_read" &&
      (args?.input as { section: string }).section === "jobs"
    )
      return {
        items: [
          {
            id: "job-a",
            name: "Tests",
            state: "completed",
            result: "failed",
            attempt: 2,
            logId: 9,
          },
        ],
        nextSkip: null,
      };
    return {
      text: "failed test",
      startLine: 500,
      endLine: 599,
      lineCount: 600,
      attempt: 2,
    };
  });
  const provider = inboxProvider({
    ...item,
    kind: "ci",
    site: target.site,
    delivery,
  });
  const page = await provider.checks!();
  expect(page.items[0]).toMatchObject({ name: "Tests", status: "Failed" });
  expect(await page.items[0].log!()).toContain("Lines 501–600 of 600");
  expect(invoke).toHaveBeenLastCalledWith("azure_ci_read", {
    input: {
      target,
      head: null,
      runId: 7,
      revision: "run-a",
      section: "log",
      recordId: "job-a",
      attempt: 2,
      logId: 9,
    },
  });
});
it("rejects a changed CI repository before reading jobs", async () => {
  const delivery = {
    kind: "ci" as const,
    accountId: "a",
    project: "p",
    repository: "old",
    definition: 8,
    branch: "main",
    commit: "commit",
    author: "",
  };
  vi.mocked(invoke).mockResolvedValue({
    ...item,
    delivery: { ...delivery, repository: "other" },
  });
  const provider = inboxProvider({
    ...item,
    kind: "ci",
    site: "https://dev.azure.com/team",
    delivery,
  });
  await expect(provider.checks!()).rejects.toThrow("Pipeline identity changed");
  expect(invoke).toHaveBeenCalledTimes(1);
});
