// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { InboxItem } from "../inbox/model/githubTasks";
import { beforeEach, expect, it, vi } from "vitest";
import { EditTaskDialog, validateTaskEdit } from "./EditTaskDialog";
import { addTask, loadBoard, updateTask } from "./boardStore";
import { taskSessionCheckout } from "./taskSession";
import type { Session } from "../sessions/model/session";

vi.mock("./taskSession", async (original) => ({
  ...(await original<typeof import("./taskSession")>()),
  taskSessionCheckout: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (value: string) => value,
}));
const lane = {
  id: "lane",
  projectPath: "/repo",
  worktreePath: "/copy",
  branch: "feature",
  base: "main",
  sessionIds: ["session"],
};
const session = {
  id: "session",
  cwd: "/repo",
  worktreeCwd: "/copy",
  busy: false,
} as Session;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(taskSessionCheckout).mockReset().mockResolvedValue(lane);
});
const task = () => {
  addTask({ title: "Task", links: [], workstreams: [lane] });
  return loadBoard().tasks[0];
};

it("validates primary membership and the actual checkout before accepting staged edits", async () => {
  const original = task();
  await expect(
    validateTaskEdit(
      original,
      { ...original, title: "New title", primarySessionId: "session" },
      [session],
    ),
  ).resolves.toBeUndefined();
  vi.mocked(taskSessionCheckout).mockResolvedValue({
    ...lane,
    branch: "switched",
  });
  await expect(validateTaskEdit(original, original, [session])).rejects.toThrow(
    "does not match",
  );
  await expect(
    validateTaskEdit(
      original,
      { ...original, workstreams: [], primarySessionId: "session" },
      [session],
    ),
  ).rejects.toThrow("primary conversation");
});

it("refuses duplicate copy ownership, busy detaches, and edits after membership races", async () => {
  const original = task();
  await expect(
    validateTaskEdit(original, { ...original, workstreams: [] }, [
      { ...session, worktreePreparing: true },
    ]),
  ).rejects.toThrow("working agent");
  await expect(
    validateTaskEdit(
      original,
      { ...original, workstreams: [lane, { ...lane, id: "duplicate" }] },
      [session],
    ),
  ).rejects.toThrow("only one");
  vi.mocked(taskSessionCheckout).mockImplementationOnce(async () => {
    updateTask(original.id, { title: "Changed elsewhere" });
    return lane;
  });
  await expect(validateTaskEdit(original, original, [session])).rejects.toThrow(
    "membership changed",
  );
  expect(loadBoard().tasks[0].title).toBe("Changed elsewhere");
});

it("stages ticket selection and checkout edits in the same controls as task creation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const original = task();
  const item = {
    provider: "github",
    kind: "issue",
    number: 12,
    title: "Fix tests",
    url: "https://github.com/team/repo/issues/12",
    repo: "team/repo",
    projectPath: "/repo",
    state: "open",
    labels: [],
    assignees: [],
    updatedAt: "2026-10-01",
  } as InboxItem;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(EditTaskDialog, {
          task: original,
          items: [item],
          sessions: [session, { ...session, id: "candidate", title: "Another conversation" }],
          recents: [],
          onClose: vi.fn(),
          onPrepareWorktree: vi.fn(),
        }),
      ),
    );
    expect(
      document.querySelector('[role="radiogroup"][aria-label="Working copy"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('input[aria-label="Search tickets"]'),
    ).not.toBeNull();
    const conversations = document.querySelector<HTMLDetailsElement>("details")!;
    expect(conversations.open).toBe(false);
    expect(conversations.textContent).toContain("Another conversation");
    expect(document.querySelector('[aria-label="Saved conversation · session"]')?.closest("details")).toBeNull();
    const ticket = document.querySelector<HTMLButtonElement>(
      '[role="group"][aria-label="Tickets"] button[role="checkbox"]',
    )!;
    await act(async () => ticket.click());
    expect(ticket.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).toContain("1 linked");
    expect(loadBoard().tasks[0].links).toEqual([]);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[title^="Unlink ticket:"]')!
        .click(),
    );
    expect(ticket.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("preserves task-wide conversations and blocks checkout changes while they are working", async () => {
  const original = task();
  updateTask(original.id, {
    primarySessionId: "lead",
    taskSessionIds: ["extra"],
    workstreams: [
      lane,
      {
        ...lane,
        id: "api",
        projectPath: "/api",
        worktreePath: "/api-copy",
        sessionIds: [],
      },
    ],
  });
  const current = loadBoard().tasks[0];
  const wide = { ...session, id: "extra" };
  const lead = { ...session, id: "lead" };
  await expect(
    validateTaskEdit(current, current, [session, lead, wide]),
  ).resolves.toBeUndefined();
  await expect(
    validateTaskEdit(
      current,
      {
        ...current,
        workstreams: [lane, { ...current.workstreams[1], branch: "changed" }],
      },
      [session, lead, { ...wide, busy: true }],
    ),
  ).rejects.toThrow("agent is working");
});
