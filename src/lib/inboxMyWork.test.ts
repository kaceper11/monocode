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

  it("lists the ticket-bound task as a task row with its delivery rollup", () => {
    const bound = task({
      ticket: {
        kind: "issue",
        repo: "acme/app",
        number: 1,
        url: "https://github.com/acme/app/issues/1",
      },
      sessionIds: ["s-task"],
      children: [child({ workingCopy: "/wt", branch: "feat" })],
    });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [
        session({ id: "s-task", cwd: "/wt", linkedWorkItem: githubLink }),
      ],
      tasks: [bound],
      stores: { prs: [azureAssoc({})], ci: [ciSource({})] },
      branchForCwd: () => "feat",
    }).get(githubTicket)!;
    expect(work.tasks).toHaveLength(1);
    expect(work.tasks[0]).toMatchObject({
      id: "t1",
      name: "Deliver the thing",
      sessions: 1,
    });
    expect(work.tasks[0].delivery).toMatchObject({
      prs: 1,
      ci: 1,
      ciFailing: true,
    });
    expect(work.sessions[0]).toMatchObject({
      taskId: "t1",
      coveredByTask: true,
    });
    expect(work.prs[0].coveredByTask).toBe(true);
  });

  it("counts unlinked sessions at task-owned checkouts like TaskDetails", () => {
    const bound = task({
      ticket: {
        kind: "issue",
        repo: "acme/app",
        number: 1,
        url: "https://github.com/acme/app/issues/1",
      },
      sessionIds: ["s-task"],
      children: [
        child({ workingCopy: "/wt", branch: "feat", baseRef: "main" }),
      ],
    });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [
        session({ id: "s-task", cwd: "/wt" }),
        // Rooted at the owned worktree but never recorded on the task —
        // TaskDetails sweeps it into its conversation list, so the row
        // count must include it too.
        session({ id: "s-extra", cwd: "/wt" }),
        session({ id: "s-elsewhere", cwd: "/other" }),
      ],
      tasks: [bound],
    }).get(githubTicket)!;
    expect(work.tasks[0].sessions).toBe(2);
  });

  it("does not count an unlinked session another task owns", () => {
    const bound = task({
      ticket: {
        kind: "issue",
        repo: "acme/app",
        number: 1,
        url: "https://github.com/acme/app/issues/1",
      },
      sessionIds: ["s-task"],
      children: [
        child({ workingCopy: "/wt", branch: "feat", baseRef: "main" }),
      ],
    });
    const other = task({ id: "t2", sessionIds: ["s-extra"] });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [
        session({ id: "s-task", cwd: "/wt" }),
        session({ id: "s-extra", cwd: "/wt" }),
      ],
      tasks: [bound, other],
    }).get(githubTicket)!;
    expect(work.tasks[0].sessions).toBe(1);
  });

  it("attaches a task through a related session it owns", () => {
    const linked = session({ id: "s-task", cwd: "/wt", linkedWorkItem: githubLink });
    const owned = task({ sessionIds: ["s-task"], children: [] });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked],
      tasks: [owned],
    }).get(githubTicket)!;
    expect(work.tasks.map((row) => row.id)).toEqual(["t1"]);
    // No children cover the session's checkout — the conversation keeps its
    // own row and delivery path instead of folding into the task.
    expect(work.sessions[0]).toMatchObject({ taskId: "t1" });
    expect(work.sessions[0].coveredByTask).toBeUndefined();
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
    expect(work.sessions[0]).toMatchObject({
      taskId: "t1",
      coveredByTask: true,
    });
  });

  it("keeps a task-owned session at an uncovered checkout visible", () => {
    // The task's children cover "/wt" but the session works from "/main" —
    // its saved links join under the session scope so it must not fold away.
    const linked = session({
      id: "s-task",
      cwd: "/main",
      branch: "feat",
      linkedWorkItem: githubLink,
    });
    const owned = task({
      sessionIds: ["s-task"],
      children: [child({ workingCopy: "/wt", branch: "feat" })],
    });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [linked],
      tasks: [owned],
      stores: {
        prs: [azureAssoc({ cwd: "/main", sourceSessionId: "s-task" })],
        ci: [],
      },
      branchForCwd: () => "feat",
    }).get(githubTicket)!;
    expect(work.sessions[0]).toMatchObject({ taskId: "t1" });
    expect(work.sessions[0].coveredByTask).toBeUndefined();
    expect(work.prs).toHaveLength(1);
    expect(work.prs[0].coveredByTask).toBeUndefined();
    expect(work.prs[0].sessionId).toBe("s-task");
  });

  it("folded task sessions don't spend conversation row slots", () => {
    const ownedSessions = Array.from({ length: 13 }, (_, i) =>
      session({
        id: `s-owned-${i}`,
        cwd: "/wt",
        linkedWorkItem: githubLink,
      }),
    );
    const loose = session({
      id: "s-loose",
      cwd: "/main",
      linkedWorkItem: githubLink,
    });
    const owned = task({
      sessionIds: ownedSessions.map((entry) => entry.id),
      children: [child({ workingCopy: "/wt" })],
    });
    const work = inboxMyWorkForItems([githubTicket], {
      sessions: [...ownedSessions, loose],
      tasks: [owned],
    }).get(githubTicket)!;
    // Thirteen folded rows plus the one rendered loose conversation — the
    // loose row survives because covered sessions don't consume the cap.
    expect(work.sessions).toHaveLength(14);
    expect(
      work.sessions.find((entry) => entry.sessionId === "s-loose"),
    ).toBeTruthy();
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
