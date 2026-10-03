// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";
import {
  newTab,
  type TaskWorkspace,
} from "../../features/workspace/model/layout";
import {
  newSession,
  sessionWorkCwd,
} from "../../features/sessions/model/session";
import type { BoardTask } from "../../features/board/boardStore";

const tasks: BoardTask[] = [
  {
    id: "task",
    title: "Task",
    createdAt: 1,
    links: [],
    primarySessionId: "wide",
    workstreams: [
      {
        id: "api",
        projectPath: "/api",
        branch: "api",
        base: "main",
        worktreePath: "/api-copy",
        sessionIds: ["api"],
      },
      {
        id: "web",
        projectPath: "remote://host/web",
        branch: "web",
        base: "main",
        worktreePath: "remote://host/web-copy",
        sessionIds: ["web"],
      },
    ],
  },
];
const sessions = ["wide", "api", "web", "adhoc"].map((id) => ({
  ...newSession("codex", id === "web" ? "remote://host/web" : "/api"),
  id,
  worktreeCwd: id === "web" ? "remote://host/web-copy" : "/api-copy",
  busy: id === "api",
}));
const tabs = sessions.map((session) => ({
  ...newTab(session.id),
  id: `tab-${session.id}`,
}));
const verify = vi.fn(async (_scope: TaskWorkspace) => {});
const open = vi.fn(
  async (_id: string, _isCurrent: () => boolean): Promise<string | undefined> =>
    undefined,
);
const create = vi.fn(
  async (_scope: TaskWorkspace, _isCurrent: () => boolean) => "created",
);
const move = vi.fn(async () => {});
const publish = vi.fn();
let root: Root, container: HTMLDivElement;
let navigation: ReturnType<typeof useWorkspaceNavigation>;
let active: string;
let selection: TaskWorkspace | undefined;
async function mount(visibleTabs = tabs) {
  function Harness() {
    const [activeTabId, setActive] = useState("tab-wide");
    const [scope, setScope] = useState<TaskWorkspace>();
    active = activeTabId;
    selection = scope;
    navigation = useWorkspaceNavigation({
      project: "/api",
      tabs: visibleTabs,
      sessions,
      activeTabId,
      pins: new Map(),
      tabWorkspace: () => "/api",
      moveSession: move,
      activateTab: setActive,
      createTab: () => "unused",
      task: {
        tasks,
        selection: scope,
        publish: (next) => {
          publish(next);
          setScope(next);
        },
        verify,
        openSession: open,
        createTab: create,
      },
    });
    return createElement("output", null, activeTabId);
  }
  await act(async () => root.render(createElement(Harness)));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  verify.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("switches between task repositories and shared chat without moving busy agents or host paths", async () => {
  await mount();
  await act(async () => navigation.selectTaskWorkspace("task", "api"));
  expect(active).toBe("tab-api");
  await act(async () => navigation.selectTaskWorkspace("task", "web"));
  expect(active).toBe("tab-web");
  expect(sessionWorkCwd(sessions[2])).toBe("remote://host/web-copy");
  await act(async () => navigation.selectTaskWorkspace("task"));
  expect(active).toBe("tab-wide");
  expect(move).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(sessions[1].busy).toBe(true);
});
it("ignores an older lane verification and applies only the latest choice", async () => {
  const waiting = deferred();
  verify.mockImplementationOnce(() => waiting.promise);
  await mount();
  await act(async () => navigation.selectTaskWorkspace("task", "api"));
  await act(async () => navigation.selectTaskWorkspace("task", "web"));
  await act(async () => waiting.resolve());
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ taskId: "task", workstreamId: "web" }),
  );
  expect(active).toBe("tab-web");
});
it("cancels a pending task switch when a specific conversation is opened", async () => {
  const waiting = deferred();
  verify.mockImplementationOnce(() => waiting.promise);
  await mount();
  await act(async () => navigation.selectTaskWorkspace("task", "api"));
  await act(async () => navigation.cancel());
  await act(async () => waiting.resolve());
  expect(active).toBe("tab-wide");
  expect(publish).not.toHaveBeenCalled();
});
it("exposes a missing or drifted checkout and falls back to the task-wide view without creating a chat", async () => {
  verify.mockRejectedValueOnce(
    new Error("Worktree is on main, expected api. Update its task binding."),
  );
  await mount();
  await act(async () => navigation.selectTaskWorkspace("task", "api"));
  expect(selection).toEqual({ taskId: "task" });
  expect(navigation.error?.message).toContain("expected api");
  expect(create).not.toHaveBeenCalled();
  expect(move).not.toHaveBeenCalled();
});
it("opens a saved lane conversation before creating a blank one", async () => {
  open.mockResolvedValueOnce("saved-tab");
  await mount(tabs.filter((tab) => tab.id !== "tab-api"));
  await act(async () => navigation.selectTaskWorkspace("task", "api"));
  expect(open).toHaveBeenCalledWith("api", expect.any(Function));
  expect(active).toBe("saved-tab");
  expect(create).not.toHaveBeenCalled();
});
it("creates exactly one blank conversation when the selected lane has no available conversation", async () => {
  open.mockResolvedValue(undefined);
  await mount(tabs.filter((tab) => tab.id !== "tab-api"));
  await act(async () => navigation.selectTaskWorkspace("task", "api"));
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ taskId: "task", workstreamId: "api" }),
    expect.any(Function),
  );
  expect(active).toBe("created");
  expect(move).not.toHaveBeenCalled();
});
