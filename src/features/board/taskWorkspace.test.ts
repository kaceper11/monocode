import { expect, it } from "vitest";
import {
  newTab,
  newFileTab,
  newEditorWorkspaceTab,
  splitPane,
} from "../workspace/model/layout";
import type { BoardTask } from "./boardStore";
import {
  taskTabWorkspace,
  taskWorkspaceTabs,
  taskWorkspaceTarget,
} from "./taskWorkspace";
import { scopedSessions } from "./sessionScope";
import type { SessionSummary } from "../sessions/data/sessionStore";

const task: BoardTask = {
  id: "task",
  title: "Delivery",
  createdAt: 1,
  links: [],
  primarySessionId: "wide",
  workstreams: [
    {
      id: "api",
      projectPath: "/repo",
      worktreePath: "/trees/api",
      branch: "api",
      base: "main",
      sessionIds: ["api-chat"],
    },
    {
      id: "web",
      projectPath: "/repo",
      worktreePath: "/trees/web",
      branch: "web",
      base: "main",
      sessionIds: ["web-chat"],
    },
  ],
};
const tabs = [
  newTab("wide"),
  newTab("api-chat"),
  newTab("web-chat"),
  newTab("adhoc"),
];
it("scopes same-repository lanes by membership and always retains shared conversations", () => {
  expect(
    taskWorkspaceTabs(tabs, [task], {
      taskId: task.id,
      workstreamId: "api",
    }).map((tab) => tab.focusedId),
  ).toEqual(["wide", "api-chat"]);
  expect(
    taskWorkspaceTabs(tabs, [task], { taskId: task.id }).map(
      (tab) => tab.focusedId,
    ),
  ).toEqual(["wide", "api-chat", "web-chat"]);
  const rows = ["wide", "api-chat", "web-chat", "adhoc"].map(
    (id) => ({ id, cwd: "/repo" }) as SessionSummary,
  );
  expect(
    scopedSessions(rows, [task], {
      kind: "task",
      taskId: task.id,
      workstreamId: "api",
    }).map((row) => row.id),
  ).toEqual(["wide", "api-chat"]);
});
it("preserves explicit file tab ownership without deriving permission from paths", () => {
  const file = newEditorWorkspaceTab(
    newFileTab("/trees/api/file.ts", "/trees/api"),
  );
  expect(taskTabWorkspace(file, [task])).toBeUndefined();
  const owned = {
    ...file,
    taskWorkspace: { taskId: task.id, workstreamId: "api" },
  };
  expect(
    taskWorkspaceTabs([owned], [task], {
      taskId: task.id,
      workstreamId: "api",
    }),
  ).toEqual([owned]);
  expect(
    taskWorkspaceTabs([owned], [task], {
      taskId: task.id,
      workstreamId: "web",
    }),
  ).toEqual([]);
  expect(
    taskTabWorkspace(owned, [{ ...task, archived: true }]),
  ).toBeUndefined();
  expect(taskTabWorkspace(owned, [{ ...task, workstreams: [] }])).toEqual({
    taskId: task.id,
  });
});
it("uses a lane tab before a shared tab, but honors an explicitly remembered shared tab", () => {
  const scope = { taskId: task.id, workstreamId: "api" };
  expect(taskWorkspaceTarget(tabs, [task], scope)?.focusedId).toBe("api-chat");
  expect(taskWorkspaceTarget(tabs, [task], scope, tabs[0].id)?.focusedId).toBe(
    "wide",
  );
  expect(taskWorkspaceTarget(tabs, [task], scope, tabs[2].id)?.focusedId).toBe(
    "api-chat",
  );
  expect(
    taskWorkspaceTarget(tabs, [task], { taskId: task.id })?.focusedId,
  ).toBe("wide");
});
it("keeps cross-lane split tabs shared and refuses ambiguous cross-task membership", () => {
  const mixed = {
    ...tabs[1],
    layout: splitPane(tabs[1].layout, "api-chat", "right", "web-chat"),
  };
  expect(taskTabWorkspace(mixed, [task])).toEqual({ taskId: task.id });
  const other = {
    ...task,
    id: "other",
    primarySessionId: "web-chat",
    workstreams: [],
  };
  expect(taskTabWorkspace(mixed, [task, other])).toBeUndefined();
});

it("detached conversations become ad hoc even when old presentation metadata remains", () => {
  expect(
    taskTabWorkspace(
      {
        ...newTab("detached"),
        taskWorkspace: { taskId: task.id, workstreamId: "api" },
      },
      [task],
    ),
  ).toBeUndefined();
});
