import { publishRepositoryFamilies } from "./repositoryFamilies";
// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  ciRepair,
  commentsRepair,
  validateRepair,
  assertRepairOwner,
  reserveRepair,
  repairRecords,
  updateRepair,
  type RepairDelivery,
} from "./repair";
import { newSession } from "./session";
import type { CiSource, CiRun, CiJob, CiLog } from "./azurePipelines";
import type { AzurePrAssociation, AzurePrThread } from "./azureRepos";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./harness/registry", () => ({ isLiveHarness: () => true }));
const source: CiSource = {
  target: {
    site: "https://dev.azure.com/org",
    accountId: "account",
    project: "project",
    definition: 7,
    repositoryId: "team/repo",
    repositoryType: "GitHub",
    repositoryUrl: "https://github.com/team/repo",
  },
  cwd: "wsl://Ubuntu/work/repo",
  branch: "feature",
  remote: "https://github.com/team/repo",
  session: "owner",
  projectName: "Project",
  definitionName: "Tests",
};
const head = {
  cwd: source.cwd,
  branch: source.branch,
  commit: "head",
  remote: source.remote,
};
const run: CiRun = {
  id: 8,
  number: "8",
  revision: "run-attempt-2",
  result: "failed",
  status: "completed",
  branch: "refs/heads/feature",
  commit: "head",
  match: "exact",
  queuedAt: "now",
};
const job: CiJob = {
  id: "task",
  name: "Test",
  type: "Task",
  attempt: 2,
  logId: 9,
  state: "completed",
  result: "failed",
};
const log: CiLog = {
  text: "Expected 1, got 2",
  startLine: 1,
  endLine: 2,
  lineCount: 3,
  attempt: 2,
  logId: 9,
  recordId: "task",
  bounded: true,
};
const owner = {
  ...newSession("codex", source.cwd),
  id: "owner",
  providerSessionId: "provider-1",
};
const delivery = (): RepairDelivery => ({
  id: crypto.randomUUID(),
  ...ciRepair(source, head, run, job, log),
  owner: {
    id: owner.id,
    harness: owner.harness,
    model: owner.model,
    cwd: head.cwd,
    runtimeMode: owner.runtimeMode,
    providerSessionId: owner.providerSessionId,
  },
});
beforeEach(() => {
  publishRepositoryFamilies(new Map());
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) =>
      command === "azure_ci_context"
        ? { ...head, remotes: [{ name: "origin", url: head.remote }] }
        : log,
    );
});
it("rechecks commit, selected run/log/attempt and rejects changed evidence", async () => {
  const draft = delivery();
  await validateRepair(draft.evidence, draft.context);
  expect(invoke).toHaveBeenLastCalledWith("azure_ci_read", {
    input: expect.objectContaining({
      runId: 8,
      revision: "run-attempt-2",
      recordId: "task",
      attempt: 2,
      logId: 9,
      startLine: 1,
      head,
    }),
  });
  vi.mocked(invoke).mockResolvedValueOnce({
    ...head,
    commit: "new",
    remotes: [{ url: head.remote }],
  });
  await expect(validateRepair(draft.evidence, draft.context)).rejects.toThrow(
    "Checkout changed",
  );
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "azure_ci_context"
      ? { ...head, remotes: [{ url: head.remote }] }
      : { ...log, text: "Changed failure" },
  );
  await expect(validateRepair(draft.evidence, draft.context)).rejects.toThrow(
    "Log evidence changed",
  );
});
it("rejects a different checkout, owner, provider identity, or an existing draft", () => {
  const draft = delivery();
  expect(() => assertRepairOwner(draft, owner)).not.toThrow();
  for (const changed of [
    { ...owner, id: "focused-other" },
    { ...owner, worktreeCwd: "/other" },
    { ...owner, providerSessionId: "provider-2" },
    { ...owner, composerSeed: "unsent draft" },
    undefined,
  ])
    expect(() => assertRepairOwner(draft, changed)).toThrow();
  expect(() =>
    ciRepair(source, head, { ...run, match: "old-commit" }, job, log),
  ).toThrow();
});
it("rejects duplicate, overlapping and uncertain repairs until explicit reconciliation", () => {
  const draft = delivery();
  reserveRepair(draft);
  expect(() =>
    reserveRepair({ ...delivery(), owner: { ...draft.owner, id: "another" } }),
  ).toThrow("already exists");
  updateRepair(draft.id, "uncertain", "Interrupted");
  expect(() => reserveRepair(delivery())).toThrow("already exists");
  updateRepair(draft.id, "released", "User checked conversation");
  const next = delivery();
  reserveRepair(next);
  expect(repairRecords().find((row) => row.id === next.id)?.session).toBe(
    "owner",
  );
  updateRepair(next.id, "blocked", "Not dispatched");
});
it("verifies selected unresolved comments as well as PR revision", async () => {
  const association: AzurePrAssociation = {
    cwd: source.cwd,
    branch: "feature",
    sourceSessionId: "owner",
    target: {
      site: source.target.site,
      accountId: "account",
      project: "project-id",
      repository: "repo-id",
      number: 9,
    },
    account: "Ada",
    projectName: "Project",
    repositoryName: "Repo",
    revision: "pr-head-target",
    pr: {
      pullRequestId: 9,
      title: "Work",
      status: "active",
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      lastMergeSourceCommit: { commitId: "head" },
      reviewers: [],
    },
  };
  const threads: AzurePrThread[] = [
    {
      id: 1,
      status: "active",
      comments: [{ id: 3, content: "Handle failure" }, { id: 4, content: "Keep retry behavior" }],
    },
    { id: 2, status: "fixed", comments: [] },
  ];
  let changed = false;
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command === "azure_ci_context"
      ? {
          ...head,
          remotes: [{ url: "https://dev.azure.com/org/project/_git/repo" }],
        }
      : (args as { section: string }).section === "summary"
        ? { pr: association.pr, revision: association.revision }
        : {
            items: changed ? [{ ...threads[0], status: "fixed" }] : threads,
            revision: association.revision,
            nextSkip: null,
          },
  );
  const draft = await commentsRepair(association, threads, 50);
  expect(draft.context.entries).toHaveLength(2);
  expect(draft.context.entries[0].text).toContain("Handle failure");
  expect(draft.context.entries[0].text).not.toContain("Keep retry behavior");
  const one = await commentsRepair(association, threads, 50, () => true, 4);
  expect(one.context.entries).toHaveLength(1);
  expect(one.context.entries[0].text).toContain("Keep retry behavior");
  expect(one.context.entries[0].text).not.toContain("Handle failure");
  await validateRepair(draft.evidence, draft.context);
  expect(invoke).toHaveBeenLastCalledWith(
    "azure_pr_read",
    expect.objectContaining({
      section: "threads",
      skip: 50,
      expectedRevision: "pr-head-target",
    }),
  );
  changed = true;
  await expect(validateRepair(draft.evidence, draft.context)).rejects.toThrow(
    "Selected comments changed",
  );
});

it("does not reserve a second scope while its destination is being checked", () => {
  const draft = delivery();
  draft.evidence.scope = "another-pipeline";
  expect(() => reserveRepair(draft, true)).toThrow(
    "Another repair is checking",
  );
  expect(repairRecords().some((row) => row.id === draft.id)).toBe(false);
});

it("rejects GitLab evidence when the MR head or discussions moved", async () => {
  const { gitlabCommentsRepair } = await import("./repair");
  const { clearGitlabCache } = await import("./gitlab");
  clearGitlabCache();
  const mr = {
    number: 7,
    title: "Improve login",
    url: "https://gitlab.example.com/acme/web/-/merge_requests/7",
    state: "open",
    headSha: "head",
    headRefName: "feature",
    baseRefName: "main",
    mergeStatus: "discussions_not_resolved",
    blockingDiscussionsResolved: false,
    approvalsRequired: 0,
    approvalsLeft: 0,
    approved: false,
    draft: false,
    pipeline: null,
  };
  const discussion = {
    id: "10",
    kind: "review",
    author: "reviewer",
    body: "Fix this",
    createdAt: "2024-01-01T00:00:00Z",
    url: "",
    state: "",
    path: "src/file.ts",
    line: 12,
    resolved: false,
    resolvable: true,
    threadId: "deadbeef01",
    replies: [],
  };
  let moved = false;
  let changed = false;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "azure_ci_context")
      return {
        cwd: "/work/web",
        branch: "feature",
        commit: "head",
        remotes: [{ name: "origin", url: "https://gitlab.example.com/acme/web" }],
      };
    if (command === "gitlab_repo") return "acme/web";
    if (command === "gitlab_mr_state")
      return { ...mr, headSha: moved ? "new-head" : "head" };
    if (command === "gitlab_mr_discussions")
      return {
        comments: [
          changed
            ? { ...discussion, body: "Edited comment" }
            : discussion,
        ],
        truncated: false,
      };
    throw new Error(`Unexpected ${command}`);
  });
  const draft = await gitlabCommentsRepair({
    cwd: "/work/web",
    repo: "acme/web",
    number: 7,
    comments: [discussion],
  });
  expect(draft.evidence.scope).toBe("gitlab-mr:acme/web#7");
  await validateRepair(draft.evidence, draft.context);
  moved = true;
  await expect(validateRepair(draft.evidence, draft.context)).rejects.toThrow(
    "MR head moved",
  );
  moved = false;
  changed = true;
  await expect(validateRepair(draft.evidence, draft.context)).rejects.toThrow(
    "Selected discussions changed",
  );
});

it("prepares comments in a verified PR checkout without retargeting the source conversation", async () => {
  const association: AzurePrAssociation = { cwd: "/work/story", branch: "main", sourceSessionId: "owner", target: { site: "https://dev.azure.com/org", accountId: "account", project: "p", repository: "r", number: 9 }, account: "Ada", projectName: "Project", repositoryName: "Repo", revision: "rev", pr: { pullRequestId: 9, title: "Work", status: "active", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main", lastMergeSourceCommit: {commitId:"head"}, reviewers: [] } };
  const threads: AzurePrThread[] = [{id:1,status:"active",comments:[{id:2,content:"Fix this"}]}];
  localStorage.setItem("monocode.recentProjects", JSON.stringify([{path:"/work/repo",openedAt:1}]));
  const remote = "https://dev.azure.com/org/project/_git/repo";
  let existing = true;
  let cancelled = false;
  vi.mocked(invoke).mockImplementation(async (command, raw) => {
    const args = raw as Record<string, string>;
    if (command === "azure_ci_context") return { cwd: args.cwd, branch: args.cwd === "/work/story" || (!existing && args.cwd === "/work/repo") ? "main" : "feature", commit: "head", remotes:[{name:"origin",url:args.cwd === "/work/story" ? "https://github.com/team/story" : remote}] };
    if (command === "azure_pr_prepare_checkout") return "/work/repo-pr-9";
    throw new Error(`Unexpected ${command}`);
  });
  const reused = await commentsRepair(association, threads, 0);
  expect(reused.evidence.head.cwd).toBe("/work/repo");
  expect(reused.evidence.kind === "comments" && reused.evidence.association.sourceSessionId).toBeUndefined();
  expect(association.cwd).toBe("/work/story");
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "azure_pr_prepare_checkout")).toBe(false);
  existing = false;
  const created = await commentsRepair(association, threads, 0, () => !cancelled);
  expect(created.evidence.head.cwd).toBe("/work/repo-pr-9");
  expect(invoke).toHaveBeenCalledWith("azure_pr_prepare_checkout", { cwd:"/work/story", target: association.target, expectedRevision: "rev", requestId: expect.any(String) });
  cancelled = true;
  vi.mocked(invoke).mockClear();
  await expect(commentsRepair(association, threads, 0, () => !cancelled)).rejects.toThrow("cancelled");
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "azure_pr_prepare_checkout")).toBe(false);
});
