import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { inboxProvider, inboxSessionDescription } from "./inboxProvider";
import type { InboxItem } from "../../inbox/model/githubTasks.ts";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const item: InboxItem = {
  provider: "azuredevops",
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
  expect(await inboxSessionDescription({ ...item, provider: "gitlab", kind: "jira" })).toBeUndefined();
  expect(invoke).not.toHaveBeenCalled();
});
it("routes Azure DevOps details, discussion, diff and comments through the adapter", async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "azure_devops_work_item_details")
      return {
        body: "Description",
        author: "Ada",
        headRefName: "feature",
        baseRefName: "main",
      };
    if (cmd === "azure_devops_work_item_thread")
      return {
        comments: [
          {
            id: "1",
            kind: "comment",
            author: "Ada",
            body: "First",
            createdAt: "",
            url: "",
            state: "active",
            path: "a.ts",
            line: 8,
            resolved: false,
            threadId: "31",
            replies: [
              {
                id: "2",
                kind: "comment",
                author: "Bo",
                body: "Reply",
                createdAt: "",
                url: "",
                state: "active",
                path: "a.ts",
                line: 8,
                resolved: false,
                threadId: "31",
                replies: [],
              },
            ],
          },
        ],
        truncated: true,
        reviewDecision: "",
        baseRefName: "main",
        headRefName: "feature",
      };
    if (cmd === "azure_devops_mr_diff")
      return {
        additions: 0,
        deletions: 0,
        files: [],
        patch: "",
        truncated: false,
      };
    return "https://dev.azure.com/team/Product/_git/repo/pullrequest/7?discussionId=31";
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
  expect(invoke).toHaveBeenCalledWith("azure_devops_work_item_comment", {
    repo: "repo",
    kind: "pr",
    number: 7,
    body: "Follow up",
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "azure_devops_work_item_details"),
  ).toHaveLength(1);
});
it("routes Jira reads and comments to upstream Jira with selected identity", async () => {
  vi.mocked(invoke).mockResolvedValue({
    body: "Jira description", author: "Ada",
  });
  const provider = inboxProvider({
    ...item,
    provider: "jira",
    kind: "jira",
    account: "account-a",
    site: "https://team.atlassian.net",
    id: "42",
    identifier: "ENG-42",
    url: "https://team.atlassian.net/browse/ENG-42",
  });
  expect(provider.comment).toBeTypeOf("function");
  await provider.comment!("A Jira comment");
  expect(invoke).toHaveBeenCalledWith("jira_issue_comment", { key: "ENG-42", site: "https://team.atlassian.net", accountId: "account-a", body: "A Jira comment" });
  expect((await provider.details()).body).toBe("Jira description");
  expect(invoke).toHaveBeenCalledWith("jira_issue_details", {
    site: "https://team.atlassian.net",
    key: "ENG-42",
    accountId: "account-a",
  });
});
