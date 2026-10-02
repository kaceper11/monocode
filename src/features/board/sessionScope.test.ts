// @vitest-environment happy-dom
import { expect, it, beforeEach } from "vitest";
import {
  projectSessionSummaries,
  scopedSessions,
  sessionScopeLabel,
} from "./sessionScope";
import { addTask, loadBoard, updateTask } from "./boardStore";
import { newSession } from "../sessions/model/session";
import type { SessionSummary } from "../sessions/data/sessionStore";
const summary = (id: string, cwd: string): SessionSummary => ({
  id,
  cwd,
  harness: "codex",
  model: "",
  runtimeMode: "supervised",
  title: id,
  createdAt: 1,
  updatedAt: 1,
});
beforeEach(() => localStorage.clear());
it("derives task-wide, repository and ad hoc scope without inferring membership from paths", () => {
  const id = addTask({
    title: "Checkout",
    links: [],
    primarySessionId: "primary",
    workstreams: [
      {
        id: "api",
        projectPath: "/api",
        worktreePath: "/api-task",
        branch: "feature",
        base: "main",
        sessionIds: ["repo"],
      },
    ],
  })!;
  updateTask(id, { taskSessionIds: ["extra", "primary", "extra"] });
  const rows = [
    summary("primary", "/api"),
    summary("extra", "/web"),
    summary("repo", "/api"),
    summary("adhoc", "/api"),
  ];
  const tasks = loadBoard().tasks;
  expect(tasks[0].taskSessionIds).toEqual(["extra", "primary"]);
  expect(
    scopedSessions(rows, tasks, { kind: "task", taskId: id }).map(
      (row) => row.id,
    ),
  ).toEqual(["primary", "extra", "repo"]);
  expect(
    scopedSessions(rows, tasks, { kind: "adhoc" }).map((row) => row.id),
  ).toEqual(["adhoc"]);
  expect(scopedSessions(rows, tasks, { kind: "all" })).toEqual(rows);
  expect(sessionScopeLabel(tasks, rows[1])).toBe("Checkout · All repositories");
  expect(sessionScopeLabel(tasks, rows[2], false)).toBe("api · feature");
  expect(sessionScopeLabel(tasks, rows[3])).toBe("Ad hoc · api");
});
it("combines closed history and live sessions across project repositories once", () => {
  const live = {
    ...newSession("codex", "/web"),
    blocks: [{ role: "user" }],
  } as ReturnType<typeof newSession>;
  const outside = newSession("codex", "/outside");
  const rows = projectSessionSummaries(
    [
      summary("closed", "/api"),
      summary("closed", "/api"),
      summary("other", "/outside"),
    ],
    [live, outside],
    ["/api", "/web"],
  );
  expect(rows.map((row) => row.id)).toEqual([live.id, "closed"]);
});
it("excludes orchestration workers and blank sessions, then sorts pinned-first by recency", () => {
  const worker = { ...newSession("codex", "/api"), orchestrationLeadId: "lead" };
  const blank = newSession("codex", "/api");
  const busy = { ...newSession("codex", "/api"), busy: true };
  const live = {
    ...newSession("codex", "/api"),
    blocks: [{ role: "user" }],
  } as ReturnType<typeof newSession>;
  const rows = projectSessionSummaries(
    [
      { ...summary("persisted-worker", "/api") },
      { ...summary("old", "/api"), updatedAt: 10 },
      { ...summary("new", "/api"), updatedAt: 20 },
      { ...summary("pin", "/api"), updatedAt: 1, pinned: true },
      // A finished run's worker rows linger in history — still hidden.
      {
        ...summary("lead", "/api"),
        orchestration: {
          tasks: [{ sessionId: "persisted-worker" }],
        } as never,
      },
    ],
    [worker, blank, busy, live],
    ["/api"],
  );
  const ids = rows.map((row) => row.id);
  // Pinned first, then recency — live rows get `Date.now()` timestamps.
  expect(ids[0]).toBe("pin");
  expect(ids.indexOf("new")).toBeLessThan(ids.indexOf("old"));
  expect(ids).toEqual(
    expect.arrayContaining([live.id, busy.id, "lead"]),
  );
  expect(ids).not.toContain("persisted-worker");
  expect(ids).not.toContain(worker.id);
  expect(ids).not.toContain(blank.id);
});

it("labels ambiguous task associations instead of choosing one", () => {
  addTask({
    title: "A",
    links: [],
    primarySessionId: "shared",
    workstreams: [],
  });
  addTask({
    title: "B",
    links: [],
    primarySessionId: "shared",
    workstreams: [],
  });
  expect(sessionScopeLabel(loadBoard().tasks, summary("shared", "/api"))).toBe(
    "Conflicting task membership",
  );
});

it("flags a session bound to two lanes of the same task", () => {
  addTask({
    title: "A",
    links: [],
    workstreams: [
      {
        id: "a",
        projectPath: "/api",
        worktreePath: "/api-a",
        branch: "a",
        base: "main",
        sessionIds: ["shared"],
      },
      {
        id: "b",
        projectPath: "/api",
        worktreePath: "/api-b",
        branch: "b",
        base: "main",
        sessionIds: ["shared"],
      },
    ],
  });
  expect(sessionScopeLabel(loadBoard().tasks, summary("shared", "/api"))).toBe(
    "Conflicting task membership",
  );
});
