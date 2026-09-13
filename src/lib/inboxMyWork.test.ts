import { describe, expect, it } from "vitest";
import type { AttentionItem } from "./attention";
import type { CiSource } from "./azurePipelines";
import type { AzurePrAssociation, AzurePrTarget } from "./azureRepos";
import type { GitPr } from "./fs";
import type { InboxItem } from "./githubTasks";
import { inboxMyWorkForItems } from "./inboxMyWork";
import type { SessionSummary } from "./sessionStore";
import type { TaskPrDraft } from "./taskPrs";
import type { TaskChild, TaskWorkspace } from "./taskWorkspaces";

const item = (over: Partial<InboxItem>): InboxItem =>
  ({
    provider: "github",
    kind: "issue",
    number: 1,
    title: "Ticket",
    url: "https://github.com/acme/app/issues/1",
    repo: "acme/app",
    state: "open",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    projectPath: "/repo",
    ...over,
  }) as InboxItem;

const session = (over: Partial<SessionSummary>): SessionSummary =>
  ({
    id: "s1",
    cwd: "/repo",
    harness: "claude",
    model: "m",
    runtimeMode: "supervised",
    title: "Claude · work",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as SessionSummary;

const task = (over: Partial<TaskWorkspace>): TaskWorkspace =>
  ({
    id: "t1",
    projectId: "p1",
    name: "Deliver the thing",
    attempts: [{ id: "primary", createdAt: 0 }],
    children: [],
    createdAt: 0,
    ...over,
  }) as TaskWorkspace;

const child = (over: Partial<TaskChild>): TaskChild =>
  ({
    id: "c1",
    repositoryId: "r1",
    attemptId: "primary",
    sessionIds: [],
    launch: { state: "ready" },
    ...over,
  }) as TaskChild;

const AZURE_TARGET: AzurePrTarget = {
  site: "https://dev.azure.com/org",
  accountId: "acc1",
  project: "Proj",
  repository: "Repo",
  number: 7,
};

const azureAssoc = (over: Partial<AzurePrAssociation>): AzurePrAssociation => ({
  target: AZURE_TARGET,
  pr: {
    pullRequestId: 7,
    title: "Azure PR",
    status: "active",
    sourceRefName: "refs/heads/feat",
    targetRefName: "refs/heads/main",
    reviewers: [],
  },
  revision: "1",
  account: "me",
  projectName: "Proj",
  repositoryName: "Repo",
  cwd: "/wt",
  branch: "feat",
  sourceSessionId: "s-task",
  ...over,
});

const ciSource = (over: Partial<CiSource>): CiSource => ({
  target: {
    site: "https://dev.azure.com/org",
    accountId: "acc1",
    project: "Proj",
    definition: 5,
    repositoryId: "r",
    repositoryType: "TfsGit",
    repositoryUrl: "https://dev.azure.com/org/Proj/_git/Repo",
  },
  definitionName: "CI",
  projectName: "Proj",
  remote: "origin",
  cwd: "/wt",
  branch: "feat",
  session: "s-task",
  last: {
    run: {
      id: 10,
      number: "10",
      status: "completed",
      result: "failed",
      branch: "feat",
      commit: "abc",
      queuedAt: "",
      revision: "abc",
      match: "exact",
    },
    commit: "abc",
    checkedAt: 0,
  },
  ...over,
});

const githubPr = (over: Partial<GitPr>): GitPr => ({
  number: 5,
  title: "GitHub PR",
  url: "https://github.com/acme/app/pull/5",
  state: "open",
  ...over,
});

const attention = (over: Partial<AttentionItem>): AttentionItem => ({
  key: "a1",
  kind: "approval",
  title: "Approve a command",
  urgency: 0,
  at: 1,
  signature: "sig",
  ...over,
});

const githubTicket = item({});
const githubLink = {
  kind: "issue" as const,
  repo: "acme/app",
  number: 1,
  url: "https://github.com/acme/app/issues/1",
};

describe("inboxMyWorkForItems", () => {
  it("returns nothing for a ticket with no linked work", () => {
    const map = inboxMyWorkForItems([githubTicket], {
      sessions: [session({})],
    });
    expect(map.has(githubTicket)).toBe(false);
  });

  it("joins a linked session and its live state", () => {
    const linked = session({ linkedWorkItem: githubLink });
    const map = inboxMyWorkForItems([githubTicket], {
      sessions: [linked, session({ id: "other" })],
      busySessionIds: new Set(["s1"]),
      needsInputSessionIds: new Set(["nope"]),
    });
    const work = map.get(githubTicket)!;
    expect(work.hasWork).toBe(true);
    expect(work.sessions).toHaveLength(1);
    expect(work.sessions[0]).toMatchObject({
      sessionId: "s1",
      state: "working",
    });
    expect(map.get(githubTicket)?.prs).toHaveLength(0);
  });

  it("prefers waiting over working for the session dot", () => {
    const linked = session({ linkedWorkItem: githubLink });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked],
      busySessionIds: new Set(["s1"]),
      needsInputSessionIds: new Set(["s1"]),
    }).get(githubTicket)!;
    expect(work.sessions[0].state).toBe("waiting");
  });

  it("joins a Jira ticket through the session's provider binding", () => {
    const jira = item({
      provider: "jira",
      kind: "jira",
      repo: "",
      url: "https://team.atlassian.net/browse/J-1",
      identifier: "J-1",
    });
    const linked = session({
      linkedWorkItem: {
        provider: "jira",
        kind: "issue",
        repo: "",
        number: 1,
        url: "https://team.atlassian.net/browse/J-1",
      },
    });
    const work = inboxMyWorkForItems([jira], { sessions: [linked] }).get(jira)!;
    expect(work.sessions.map((row) => row.sessionId)).toEqual(["s1"]);
    // The same session does not leak onto a different Jira url.
    const other = item({ ...jira, url: "https://team.atlassian.net/browse/J-2" });
    expect(
      inboxMyWorkForItems([other], { sessions: [linked] }).has(other),
    ).toBe(false);
  });

  it("surfaces the session's open GitHub PR with a session-bound row", () => {
    const linked = session({ linkedWorkItem: githubLink });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked],
      branchForCwd: () => "feat",
      githubPrFor: () => githubPr({}),
    }).get(githubTicket)!;
    expect(work.prs).toHaveLength(1);
    expect(work.prs[0]).toMatchObject({
      provider: "github",
      repo: "acme/app",
      number: 5,
      url: "https://github.com/acme/app/pull/5",
      sessionId: "s1",
      head: "feat",
    });
  });

  it("does not surface closed GitHub PRs", () => {
    const linked = session({ linkedWorkItem: githubLink });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked],
      branchForCwd: () => "feat",
      githubPrFor: () => githubPr({ state: "closed" }),
    });
    expect(work.get(githubTicket)?.prs ?? []).toHaveLength(0);
  });

  it("joins task delivery through the task's ticket binding", () => {
    const azure = item({
      provider: "azure",
      kind: "azure",
      repo: "",
      url: "https://dev.azure.com/org/Proj/_workitems/edit/9",
      identifier: "AB#9",
    });
    const bound = task({
      ticket: {
        provider: "azure",
        kind: "issue",
        repo: "",
        number: 9,
        url: "https://dev.azure.com/org/Proj/_workitems/edit/9",
      },
      sessionIds: ["s-task"],
      children: [
        child({ workingCopy: "/wt", branch: "feat", repositoryId: "r1" }),
      ],
    });
    const work = inboxMyWorkForItems([azure], {
      sessions: [session({ id: "s-task", cwd: "/wt" })],
      tasks: [bound],
      stores: {
        prs: [azureAssoc({})],
        ci: [ciSource({})],
      },
      branchForCwd: () => "feat",
    }).get(azure)!;
    expect(work.prs).toHaveLength(1);
    expect(work.prs[0]).toMatchObject({
      provider: "azure",
      repo: "Proj/Repo",
      number: 7,
      state: "Active",
      head: "feat",
      sessionId: "s-task",
    });
    expect(work.ci).toHaveLength(1);
    expect(work.ci[0]).toMatchObject({
      provider: "azure",
      name: "CI",
      state: "Failed",
      failing: true,
      runNumber: "10",
    });
    expect(work.prs[0].ci).toMatchObject({ failing: true, count: 1 });
  });

  it("joins task delivery through a session's owning task even without a task ticket", () => {
    const linked = session({ id: "s-task", cwd: "/wt", linkedWorkItem: githubLink });
    const owned = task({
      sessionIds: ["s-task"],
      children: [child({ workingCopy: "/wt", branch: "feat" })],
    });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked],
      tasks: [owned],
      stores: { prs: [azureAssoc({})], ci: [] },
      branchForCwd: () => "feat",
    }).get(githubTicket)!;
    expect(work.prs).toHaveLength(1);
    expect(work.prs[0].provider).toBe("azure");
    expect(work.sessions[0].taskName).toBe("Deliver the thing");
  });

  it("keeps identical PR numbers in different repositories distinct", () => {
    const linked = session({ linkedWorkItem: githubLink });
    const second = session({ id: "s2", cwd: "/other", linkedWorkItem: githubLink });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked, second],
      tasks: [],
      branchForCwd: () => "feat",
      githubPrFor: (cwd) =>
        cwd === "/repo"
          ? githubPr({})
          : githubPr({ url: "https://github.com/acme/lib/pull/5" }),
    }).get(githubTicket)!;
    expect(work.prs).toHaveLength(2);
    expect(new Set(work.prs.map((pr) => pr.repo)).size).toBe(2);
  });

  it("keeps identical Azure PR numbers in different accounts distinct", () => {
    const linked = session({ linkedWorkItem: githubLink });
    const owned = task({
      sessionIds: ["s1"],
      children: [child({ workingCopy: "/repo", branch: "feat" })],
    });
    const otherAccount = azureAssoc({
      target: { ...AZURE_TARGET, accountId: "acc2" },
      sourceSessionId: undefined,
      cwd: "/repo",
    });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked],
      tasks: [owned],
      stores: {
        prs: [azureAssoc({ sourceSessionId: "s1", cwd: "/repo" }), otherAccount],
        ci: [],
      },
      branchForCwd: () => "feat",
    }).get(githubTicket)!;
    expect(work.prs).toHaveLength(2);
  });

  it("merges the same PR reached from a draft result and a saved association", () => {
    const linked = session({ id: "s-task", cwd: "/wt", linkedWorkItem: githubLink });
    const owned = task({
      sessionIds: ["s-task"],
      children: [child({ workingCopy: "/wt", branch: "feat" })],
    });
    const draft: TaskPrDraft = {
      target: "main",
      title: "Draft title",
      body: "",
      draft: false,
      provider: "azure",
      result: {
        provider: "azure",
        url: "https://dev.azure.com/org/Proj/_git/Repo/pullrequest/7",
        title: "Azure PR",
        number: 7,
        azureTarget: AZURE_TARGET,
      },
      updatedAt: 1,
    };
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked],
      tasks: [owned],
      prDrafts: { "t1:c1": draft },
      stores: { prs: [azureAssoc({})], ci: [] },
      branchForCwd: () => "feat",
    }).get(githubTicket)!;
    expect(work.prs).toHaveLength(1);
    expect(work.prs[0].azureTarget).toEqual(AZURE_TARGET);
  });

  it("binds attention rows to their owning ticket only", () => {
    const linked = session({ linkedWorkItem: githubLink });
    const unrelated = item({ number: 2, url: "https://github.com/acme/app/issues/2" });
    const rows = [
      attention({ key: "a1", sessionId: "s1" }),
      attention({ key: "a2", url: "https://github.com/acme/app/issues/1" }),
      attention({ key: "a3", sessionId: "other" }),
    ];
    const work = inboxMyWorkForItems([githubTicket, unrelated], {
      sessions: [linked],
      attention: rows,
    });
    expect(work.get(githubTicket)!.attention.map((row) => row.key)).toEqual([
      "a1",
      "a2",
    ]);
    expect(work.has(unrelated)).toBe(false);
  });

  it("marks a GitHub PR's checks failing from watcher attention without touching Azure rows", () => {
    const linked = session({ linkedWorkItem: githubLink });
    const owned = task({
      sessionIds: ["s1"],
      children: [child({ workingCopy: "/repo", branch: "feat" })],
    });
    const failing = attention({
      key: "ci1",
      kind: "ci-failure",
      sessionId: "s1",
      action: {
        kind: "github-ci-fix",
        cwd: "/repo",
        repo: "acme/app",
        number: 5,
        sessionId: "s1",
      },
    });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked],
      tasks: [owned],
      stores: { prs: [azureAssoc({ sourceSessionId: "s1", cwd: "/repo" })], ci: [] },
      branchForCwd: () => "feat",
      githubPrFor: () => githubPr({}),
      attention: [failing],
    }).get(githubTicket)!;
    const gh = work.prs.find((pr) => pr.provider === "github")!;
    const az = work.prs.find((pr) => pr.provider === "azure")!;
    expect(gh.ci?.failing).toBe(true);
    expect(az.ci?.failing ?? false).toBe(false);
  });
});
