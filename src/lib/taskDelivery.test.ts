// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  childDelivery,
  EMPTY_DELIVERY,
  taskStatusSegments,
  type TaskChildDelivery,
} from "./taskDelivery";
import type { TaskChild, TaskWorkspace } from "./taskWorkspaces";

function child(over: Partial<TaskChild> = {}): TaskChild {
  return {
    id: "c1",
    repositoryId: "r1",
    attemptId: "primary",
    workingCopy: "/repo/a",
    branch: "feat/x",
    sessionIds: [],
    launch: { state: "ready" },
    ...over,
  };
}

function task(
  children: TaskChild[],
  over: Partial<TaskWorkspace> = {},
): TaskWorkspace {
  return {
    id: "t1",
    projectId: "p1",
    name: "Task",
    attempts: [{ id: "primary", createdAt: 1 }],
    children,
    sessionIds: ["s1"],
    createdAt: 1,
    ...over,
  };
}

const azureTarget = (number = 42) => ({
  site: "https://dev.azure.com/org",
  accountId: "acc1",
  project: "proj",
  repository: "repo",
  number,
});

function saveAzurePr(row: {
  cwd?: string;
  branch?: string;
  session?: string;
  status?: string;
  sourceRefName?: string;
  votes?: number[];
  number?: number;
}) {
  const number = row.number ?? 40 + Math.floor(Math.random() * 1000);
  const association = {
    target: azureTarget(number),
    revision: "rev1",
    account: "me@example.com",
    projectName: "proj",
    repositoryName: "repo",
    cwd: row.cwd ?? "/repo/a",
    branch: row.branch ?? "feat/x",
    ...(row.session ? { sourceSessionId: row.session } : {}),
    pr: {
      pullRequestId: number,
      title: "Some PR",
      status: row.status ?? "active",
      sourceRefName: row.sourceRefName ?? "refs/heads/feat/x",
      targetRefName: "refs/heads/main",
      reviewers: (row.votes ?? []).map((vote, i) => ({
        id: `u${i}`,
        displayName: `User ${i}`,
        vote,
      })),
    },
  };
  const key = "monocode.azurePrAssociations.v1";
  const rows = JSON.parse(localStorage.getItem(key) ?? "[]");
  localStorage.setItem(key, JSON.stringify([...rows, association]));
}

const ciTarget = {
  site: "https://dev.azure.com/org",
  accountId: "acc1",
  project: "proj",
  definition: 7,
  repositoryId: "r1",
  repositoryType: "TfsGit",
  repositoryUrl: "https://dev.azure.com/org/proj/_git/repo",
};

function saveCi(row: {
  cwd?: string;
  branch?: string;
  session?: string;
  status?: string;
  result?: string | null;
  match?: string;
  runBranch?: string;
  definition?: number;
}) {
  const source = {
    target: { ...ciTarget, definition: row.definition ?? 7 },
    definitionName: `build-${row.definition ?? 7}`,
    projectName: "proj",
    remote: "origin",
    cwd: row.cwd ?? "/repo/a",
    branch: row.branch ?? "feat/x",
    ...(row.session ? { session: row.session } : {}),
    last: {
      commit: "abc",
      checkedAt: 1,
      run: {
        id: 100 + Math.floor(Math.random() * 1000),
        number: "20240101.1",
        status: row.status ?? "completed",
        result: row.result === undefined ? "succeeded" : row.result,
        branch: row.runBranch ?? "refs/heads/feat/x",
        commit: "abc",
        queuedAt: "2024-01-01T00:00:00Z",
        revision: "abc",
        match: row.match ?? "exact",
      },
    },
  };
  const key = "monocode.azureCiSources.v1";
  const rows = JSON.parse(localStorage.getItem(key) ?? "[]");
  localStorage.setItem(key, JSON.stringify([...rows, source]));
}

beforeEach(() => localStorage.clear());

describe("childDelivery", () => {
  it("is empty for a child without a working copy", () => {
    saveAzurePr({});
    saveCi({ result: "failed" });
    const c = child({ workingCopy: undefined });
    expect(childDelivery(task([c]), c, ["feat/x"])).toEqual(EMPTY_DELIVERY);
  });

  it("is empty when no branch is known", () => {
    saveAzurePr({});
    saveCi({ result: "failed" });
    const c = child({ branch: undefined });
    expect(childDelivery(task([c]), c, [])).toEqual(EMPTY_DELIVERY);
    expect(childDelivery(task([c]), c, [null, undefined])).toEqual(
      EMPTY_DELIVERY,
    );
  });

  it("counts an active Azure PR on a known branch", () => {
    saveAzurePr({});
    const c = child();
    const delivery = childDelivery(task([c]), c, ["feat/x"]);
    expect(delivery).toEqual({ ...EMPTY_DELIVERY, prs: 1 });
  });

  it("matches a PR whose saved branch moved but source ref still names the branch", () => {
    saveAzurePr({ branch: "old-name" });
    const c = child();
    expect(childDelivery(task([c]), c, ["feat/x"]).prs).toBe(1);
    expect(childDelivery(task([c]), c, ["other"]).prs).toBe(0);
  });

  it("ignores PRs on other branches, other checkouts and closed PRs", () => {
    saveAzurePr({
      branch: "elsewhere",
      sourceRefName: "refs/heads/elsewhere",
    });
    saveAzurePr({ cwd: "/repo/other" });
    saveAzurePr({ status: "completed" });
    const c = child();
    expect(childDelivery(task([c]), c, ["feat/x"]).prs).toBe(0);
  });

  it("scopes links to the task's sessions but keeps unassigned links", () => {
    saveAzurePr({ session: "s1" }); // the task session
    saveAzurePr({ session: "other-task-session" });
    saveAzurePr({}); // no session — ambiguous, kept
    const c = child();
    expect(childDelivery(task([c]), c, ["feat/x"]).prs).toBe(2);
  });

  it("matches links saved under an equivalent but unnormalized path", () => {
    saveAzurePr({ cwd: "/repo/a/" });
    saveCi({ cwd: "/repo/a/", result: "failed" });
    const c = child({ workingCopy: "/repo/a" });
    const delivery = childDelivery(task([c]), c, ["feat/x"]);
    expect(delivery.prs).toBe(1);
    expect(delivery.ciFailing).toBe(true);
  });

  it("counts links saved under a child session", () => {
    saveAzurePr({ session: "child-session" });
    const c = child({ sessionIds: ["child-session"] });
    expect(childDelivery(task([c]), c, ["feat/x"]).prs).toBe(1);
  });

  it("flags a reviewer vote below zero as needing attention", () => {
    saveAzurePr({ votes: [10, -5] });
    const c = child();
    expect(
      childDelivery(task([c]), c, ["feat/x"]).prNeedsAttention,
    ).toBe(true);
  });

  it("does not flag approvals or neutral votes", () => {
    saveAzurePr({ votes: [10, 5, 0] });
    const c = child();
    const delivery = childDelivery(task([c]), c, ["feat/x"]);
    expect(delivery.prs).toBe(1);
    expect(delivery.prNeedsAttention).toBe(false);
  });

  it("counts an open cached GitHub PR but not a closed one", () => {
    const c = child();
    const open = { number: 5, title: "t", url: "u", state: "open" };
    const closed = { ...open, state: "closed" };
    expect(childDelivery(task([c]), c, ["feat/x"], open).prs).toBe(1);
    expect(childDelivery(task([c]), c, ["feat/x"], closed).prs).toBe(0);
    expect(childDelivery(task([c]), c, ["feat/x"], null).prs).toBe(0);
  });

  it("flags a failed verified CI run", () => {
    saveCi({ result: "failed" });
    const c = child();
    const delivery = childDelivery(task([c]), c, ["feat/x"]);
    expect(delivery.ci).toBe(1);
    expect(delivery.ciFailing).toBe(true);
    expect(delivery.ciRunning).toBe(false);
  });

  it("flags queued and running verified runs", () => {
    saveCi({ status: "inProgress", result: null });
    saveCi({ status: "notStarted", result: null, definition: 8 });
    const c = child();
    const delivery = childDelivery(task([c]), c, ["feat/x"]);
    expect(delivery.ci).toBe(2);
    expect(delivery.ciRunning).toBe(true);
    expect(delivery.ciFailing).toBe(false);
  });

  it("counts stale or unverified runs as linked but not failing", () => {
    saveCi({ result: "failed", match: "old-commit" });
    saveCi({ result: "failed", match: "unverified", definition: 8 });
    saveCi({
      branch: "other",
      runBranch: "refs/heads/other",
      result: "failed",
    });
    const c = child();
    const delivery = childDelivery(task([c]), c, ["feat/x"]);
    // old-commit + unverified rows still link; the other-branch row does not.
    expect(delivery.ci).toBe(2);
    expect(delivery.ciFailing).toBe(false);
  });

  it("matches a CI source whose recorded branch moved but run branch names it", () => {
    saveCi({ branch: "old-name", result: "failed" });
    const c = child();
    expect(childDelivery(task([c]), c, ["feat/x"]).ciFailing).toBe(true);
  });

  it("counts a link saved under several matching scopes only once", () => {
    // The same PR/pipeline re-saved from an unassigned context and again
    // inside a task session is one link, not two.
    saveAzurePr({ number: 42 });
    saveAzurePr({ number: 42, session: "s1" });
    saveCi({ result: "failed" });
    saveCi({ result: "succeeded", session: "s1" });
    const c = child();
    const delivery = childDelivery(task([c]), c, ["feat/x"]);
    expect(delivery.prs).toBe(1);
    expect(delivery.ci).toBe(1);
    expect(delivery.ciFailing).toBe(true);
  });
});

describe("taskStatusSegments", () => {
  const noDelivery = new Map<string, TaskChildDelivery>();

  it("is empty for an idle ready task", () => {
    const t = task([child()]);
    expect(
      taskStatusSegments(t, {
        busySessionIds: new Set(),
        needsInputIds: new Set(),
        delivery: noDelivery,
      }),
    ).toEqual([]);
  });

  it("reports sessions needing input first", () => {
    const t = task([child()], { sessionIds: ["s1", "s2"] });
    expect(
      taskStatusSegments(t, { needsInputIds: new Set(["s1", "s2"]) }),
    ).toEqual(["2 need input"]);
  });

  it("reports busy sessions as working", () => {
    const c = child({ sessionIds: ["cs1"] });
    const t = task([c], { sessionIds: ["s1"] });
    expect(
      taskStatusSegments(t, { busySessionIds: new Set(["s1", "cs1"]) }),
    ).toEqual(["2 working"]);
    expect(
      taskStatusSegments(t, { busySessionIds: new Set(["s1"]) }),
    ).toEqual(["1 working"]);
  });

  it("reports failed child launches", () => {
    const t = task([
      child({ id: "c1", launch: { state: "failed", error: "x" } }),
      child({ id: "c2" }),
    ]);
    expect(taskStatusSegments(t)).toEqual(["1 failed"]);
  });

  it("reports children still to prepare", () => {
    const t = task([
      child({ id: "c1", workingCopy: undefined, launch: { state: "pending" } }),
      child({ id: "c2", workingCopy: undefined, launch: { state: "pending" } }),
    ]);
    expect(taskStatusSegments(t)).toEqual(["2 to prepare"]);
  });

  it("aggregates delivery attention across children", () => {
    const c1 = child({ id: "c1" });
    const c2 = child({ id: "c2", workingCopy: "/repo/b" });
    const delivery = new Map<string, TaskChildDelivery>([
      ["c1", { ...EMPTY_DELIVERY, ciFailing: true, ci: 1 }],
      ["c2", { ...EMPTY_DELIVERY, prNeedsAttention: true, prs: 1 }],
    ]);
    expect(taskStatusSegments(task([c1, c2]), { delivery })).toEqual([
      "CI failing",
      "PR needs review",
    ]);
  });

  it("shows CI running only when no agent is working", () => {
    const c = child();
    const delivery = new Map([
      ["c1", { ...EMPTY_DELIVERY, ciRunning: true, ci: 1 }],
    ]);
    expect(
      taskStatusSegments(task([c]), { delivery, busySessionIds: new Set() }),
    ).toEqual(["CI running"]);
    expect(
      taskStatusSegments(task([c]), {
        delivery,
        busySessionIds: new Set(["s1"]),
      }),
    ).toEqual(["1 working"]);
  });

  it("drops the working segment on request for rows with their own badge", () => {
    const t = task([child()], { sessionIds: ["s1"] });
    const busy = new Set(["s1"]);
    expect(taskStatusSegments(t, { busySessionIds: busy })).toEqual([
      "1 working",
    ]);
    expect(
      taskStatusSegments(t, { busySessionIds: busy, dropWorking: true }),
    ).toEqual([]);
  });

  it("reports children whose launch is still preparing", () => {
    const t = task([
      child({ id: "c1", launch: { state: "working" } }),
      child({ id: "c2" }),
    ]);
    expect(taskStatusSegments(t)).toEqual(["1 preparing"]);
  });

  it("combines segments in actionable order", () => {
    const c1 = child({
      id: "c1",
      launch: { state: "failed" },
      sessionIds: ["cs1"],
    });
    const c2 = child({ id: "c2", workingCopy: "/repo/b" });
    const delivery = new Map<string, TaskChildDelivery>([
      ["c2", { ...EMPTY_DELIVERY, ciFailing: true, ci: 2 }],
    ]);
    const t = task([c1, c2], { sessionIds: ["s1"] });
    expect(
      taskStatusSegments(t, {
        busySessionIds: new Set(["s1"]),
        needsInputIds: new Set(["cs1"]),
        delivery,
      }),
    ).toEqual(["1 needs input", "CI failing", "1 failed", "1 working"]);
  });
});
