// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionTaskControl } from "./SessionTaskControl";
import { addTask, loadBoard } from "./boardStore";
import { OPEN_TASK_EVENT, taskSessionPrompt } from "./taskSession";
import type { Session } from "../sessions/model/session";
import {
  listWorktrees,
  type Worktrees,
} from "../source-control/model/worktrees";

vi.mock("../source-control/model/worktrees", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../source-control/model/worktrees")
  >()),
  listWorktrees: vi.fn(),
}));

let root: Root;
let host: HTMLDivElement;
let session: Session;
const trees: Worktrees = {
  defaultRoot: "/",
  worktrees: [
    {
      path: "/repo-task",
      branch: "feature",
      head: "abc",
      isMain: false,
      missing: false,
      locked: false,
      prunable: false,
      dirty: false,
      unpushed: 0,
      sessionIds: [],
    },
  ],
};
const render = async () =>
  act(async () => root.render(createElement(SessionTaskControl, { session })));
const click = async (text: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === text ||
      element.getAttribute("aria-label") === text,
  );
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.mocked(listWorktrees).mockReset().mockResolvedValue(trees);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  session = {
    id: "s",
    cwd: "/repo",
    worktreeCwd: "/repo-task",
    harness: "codex",
    model: "test",
    title: "My task",
    modelSettings: {},
    runtimeMode: "supervised",
    blocks: [],
    busy: true,
  };
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("attaches a running session, opens task details, and detaches without changing the agent", async () => {
  let id = "";
  await act(async () => {
    id = addTask({ title: "Checkout", links: [], workstreams: [] })!;
  });
  const before = structuredClone(session);
  await click("Add to task");
  await click("Attach to Checkout");
  expect(loadBoard().tasks[0].workstreams[0].sessionIds).toEqual(["s"]);
  expect(taskSessionPrompt("next", "s", "/repo-task")).toContain("Checkout");
  const onOpen = vi.fn();
  window.addEventListener(OPEN_TASK_EVENT, onOpen);
  await click("Task context: Checkout");
  expect(document.body.textContent).toContain("This session");
  await click("Open on Board");
  expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toBe(id);
  window.removeEventListener(OPEN_TASK_EVENT, onOpen);
  await click("Task context: Checkout");
  await click("Detach");
  expect(loadBoard().tasks[0].workstreams[0].sessionIds ?? []).toEqual([]);
  expect(session).toEqual(before);
});

it("creates from the actual shared dialog using the current checkout and session", async () => {
  await click("Add to task");
  await click("New task from this session");
  expect(document.body.textContent).toContain(
    "Current working copy: /repo-task",
  );
  const form = document.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(loadBoard().tasks[0]).toMatchObject({
    title: "My task",
    workstreams: [
      { worktreePath: "/repo-task", branch: "feature", sessionIds: ["s"] },
    ],
  });
  expect(session.busy).toBe(true);
});

it("displays a Git failure without binding and rejects a checkout change during verification", async () => {
  await click("Add to task");
  vi.mocked(listWorktrees).mockRejectedValueOnce(new Error("WSL unavailable"));
  await click("New task from this session");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "WSL unavailable",
  );
  let resolve!: (value: Worktrees) => void;
  vi.mocked(listWorktrees).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await click("New task from this session");
  session = { ...session, worktreeCwd: "/other" };
  await render();
  await act(async () => resolve(trees));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "working copy changed",
  );
  expect(loadBoard().tasks).toEqual([]);
});
