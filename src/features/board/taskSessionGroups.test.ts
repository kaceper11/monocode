import { expect, it } from "vitest";
import {
  buildSessionList,
  sessionListNavigationIds,
  ungroupedSessions,
  type SessionFolder,
} from "../sessions/model/sessionFolders";
import type { SessionSummary } from "../sessions/data/sessionStore";
import {
  taskSessionFolders,
  withTaskSessionFolders,
} from "./taskSessionGroups";
import type { BoardTask } from "./boardStore";

const task: BoardTask = {
  id: "task:1",
  title: "Checkout",
  createdAt: 0,
  links: [],
  workstreams: [
    {
      id: "web",
      projectPath: "/web",
      worktreePath: "/web-task",
      branch: "feature",
      base: "main",
      sessionIds: ["web-session"],
    },
    {
      id: "api",
      projectPath: "/api",
      worktreePath: "/api-task",
      branch: "feature",
      base: "main",
      sessionIds: ["api-session"],
    },
  ],
};

it("derives task groups without changing saved folders and restores them after detaching", () => {
  const original: SessionFolder[] = [
    {
      id: "personal",
      name: "My folder",
      sessionIds: ["web-session", "loose"],
      collapsed: false,
    },
  ];
  const groups = taskSessionFolders([task], new Set());
  expect(groups[0]).toMatchObject({
    name: "Checkout",
    sessionIds: ["web-session", "api-session"],
    collapsed: false,
  });
  expect(withTaskSessionFolders(original, groups)[1].sessionIds).toEqual([
    "loose",
  ]);
  expect(original[0].sessionIds).toEqual(["web-session", "loose"]);
  expect(withTaskSessionFolders(original, [])).toEqual(original);
});

it("uses existing project filtering, reminders, collapse, and keyboard navigation", () => {
  const visible = [
    { id: "web-session", title: "Web", cwd: "/web" },
    { id: "loose", title: "Loose", cwd: "/web" },
  ] as SessionSummary[];
  const groups = taskSessionFolders([task], new Set(["task-group:task:1"]));
  const entries = buildSessionList(
    visible,
    groups,
    ungroupedSessions(visible, groups),
  );
  expect(sessionListNavigationIds(entries, false)).toEqual(["loose"]);
  expect(sessionListNavigationIds(entries, true)).toEqual([
    "web-session",
    "loose",
  ]);
  const reminders = buildSessionList(
    visible,
    groups,
    ungroupedSessions(visible, groups),
    false,
    { sessionIds: ["web-session"], collapsed: false },
  );
  expect(reminders.map((entry) => entry.kind)).toEqual([
    "reminders",
    "session",
  ]);
  expect(sessionListNavigationIds(reminders, false)).toEqual([
    "web-session",
    "loose",
  ]);
});

it("does not duplicate ambiguously linked sessions across groups", () => {
  expect(
    taskSessionFolders([task, { ...task, id: "task:2" }], new Set()),
  ).toEqual([]);
});

it("groups the primary conversation once and preserves older repository conversations", () => {
  const groups = taskSessionFolders(
    [{ ...task, primarySessionId: "web-session" }],
    new Set(),
  );
  expect(groups[0].sessionIds).toEqual(["web-session", "api-session"]);
  expect(
    taskSessionFolders(
      [{ ...task, primarySessionId: "lead", workstreams: [] }],
      new Set(),
    )[0].sessionIds,
  ).toEqual(["lead"]);
});
