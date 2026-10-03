// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { WorkstreamEditor } from "./TaskDetailsPanel";
import { addTask, loadBoard } from "./boardStore";
import type { Worktree } from "../source-control/model/worktrees";
import type { Session } from "../sessions/model/session";
import type { TaskWorktreeActionHandler } from "./taskWorktrees";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock("../../app/shell/WindowControls", () => ({
  WindowControls: () => null,
}));
vi.mock("../source-control/hooks/useProjectBranches", async (original) => ({
  ...(await original<
    typeof import("../source-control/hooks/useProjectBranches")
  >()),
  useProjectBranchesState: () => ({
    settled: true,
    branches: {
      current: "feature",
      detached: false,
      branches: [
        { name: "feature", remote: null },
        { name: "other", remote: null },
        { name: "remote-only", remote: "origin" },
      ],
    },
  }),
}));
const refresh = vi.fn();
const copy: Worktree = {
  path: "/copy",
  branch: "feature",
  head: "abc",
  isMain: false,
  locked: false,
  missing: false,
  prunable: false,
  dirty: false,
  unpushed: 0,
  sessionIds: [],
};
let trees: Worktree[];
vi.mock("../source-control/hooks/useProjectWorktrees", () => ({
  useProjectWorktrees: () => ({
    data: { worktrees: trees, defaultRoot: "/copies" },
    refresh,
  }),
}));
let root: Root;
let host: HTMLDivElement;
const prepare = vi.fn(async () => "/other-copy");
const patch = vi.fn();
const close = vi.fn();
const execute = vi.fn<TaskWorktreeActionHandler>();
const lane = {
  id: "lane",
  projectPath: "/repo",
  branch: "feature",
  base: "main",
  worktreePath: "/copy",
  prUrl: "old-pr",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  vi.clearAllMocks();
  trees = [copy, { ...copy, path: "/other-copy", branch: "other" }];
  execute.mockResolvedValue({ tree: { ...copy, branch: "renamed" } });
  addTask({ title: "Task", links: [], workstreams: [lane] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(sessions: Session[] = [], busy = false, lanes = [lane]) {
  await act(async () =>
    root.render(
      createElement(WorkstreamEditor, {
        anchor: host,
        row: { ...lane, sessions } as unknown as ComponentProps<
          typeof WorkstreamEditor
        >["row"],
        lanes,
        busy,
        onPatch: patch,
        onPrepareWorktree: prepare,
        onTaskWorktreeAction: execute,
        sessions,
        onRemoveWorktree: vi.fn(),
        onClose: close,
      }),
    ),
  );
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  )!;
}
async function pickBranch(name: string) {
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="Checkout branch: feature"]',
      )!
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent === name)!
      .click(),
  );
}
async function changeInput(label: string, value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("uses the built-in searchable picker and stages branch actions until explicitly invoked", async () => {
  trees = [copy];
  await render();
  await pickBranch("other");
  expect(execute).not.toHaveBeenCalled();
  await act(async () => button("Switch to other").click());
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "switch",
      branch: "other",
      target: expect.objectContaining({ path: "/copy", branch: "feature" }),
    }),
  );
  expect(close).toHaveBeenCalled();
});
it("keeps main checkouts protected", async () => {
  trees = [{ ...copy, isMain: true }];
  await render();
  await act(async () => button("Rename branch").click());
  expect(
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Rename branch"]',
    )!.disabled,
  ).toBe(true);
  expect(button("Delete worktree…").disabled).toBe(true);
  expect(document.body.textContent).toContain("Use project controls");
});
it.each([true, null])(
  "blocks switching dirty or unknown copies: %s",
  async (dirty) => {
    trees = [{ ...copy, dirty }];
    await render();
    await pickBranch("other");
    expect(button("Switch to other").disabled).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  },
);
it("offers an occupied branch's existing copy and revalidates it through preparation", async () => {
  await render();
  await pickBranch("other");
  await act(async () => button("Use existing copy · /other-copy").click());
  expect(prepare).toHaveBeenCalledWith({
    projectPath: "/repo",
    branch: "other",
    base: "main",
    worktreePath: "/other-copy",
  });
  expect(patch).toHaveBeenCalledWith({
    branch: "other",
    worktreePath: "/other-copy",
    prUrl: undefined,
  });
  expect(execute).not.toHaveBeenCalled();
});
it("renames through the guarded explicit action while keeping its folder", async () => {
  await render();
  await act(async () => button("Rename branch").click());
  await changeInput("Rename branch", "feature/renamed");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[role="tabpanel"] button')!
      .click(),
  );
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "rename",
      branch: "feature/renamed",
      target: expect.objectContaining({ path: "/copy" }),
    }),
  );
});
it("uses the built-in consequence dialog and keeps conversations on deletion", async () => {
  await render();
  await act(async () => button("Delete worktree…").click());
  expect(execute).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "permanently deletes the working copy",
  );
  expect(document.body.textContent).toContain(
    "branch and its commits are kept",
  );
  expect(document.body.textContent).not.toContain(
    "Also delete associated sessions",
  );
  await act(async () => button("Delete worktree").click());
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "delete",
      target: expect.objectContaining({ path: "/copy" }),
    }),
  );
});
it("keeps failed operations reviewable and does not close the dialog", async () => {
  execute.mockRejectedValueOnce(new Error("Commit or stash changes first"));
  trees = [copy];
  await render();
  await pickBranch("other");
  await act(async () => button("Switch to other").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Commit or stash",
  );
  expect(close).not.toHaveBeenCalled();
});
it("shows detached and missing copies without allowing them to be bound", async () => {
  trees = [
    copy,
    { ...copy, path: "/gone", branch: "gone", missing: true },
    { ...copy, path: "/detached", branch: null },
  ];
  await render();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Choose working copy"]')!
      .click(),
  );
  const rows = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  ];
  expect(rows.find((row) => row.textContent?.includes("gone"))!.disabled).toBe(
    true,
  );
  expect(
    rows.find((row) => row.textContent?.includes("Detached"))!.disabled,
  ).toBe(true);
  expect(
    document.querySelector('input[aria-label="Search working copies"]'),
  ).not.toBeNull();
});
it("blocks management while agents work and explains the disabled actions", async () => {
  await render([], true);
  expect(button("Delete worktree…").disabled).toBe(true);
  expect(document.body.textContent).toContain("Wait for the working agents");
});
it("explicitly detaches a lane without deleting its worktree", async () => {
  await render();
  await act(async () => button("Detach from task").click());
  expect(loadBoard().tasks[0].workstreams[0].worktreePath).toBeUndefined();
  expect(loadBoard().tasks[0].workstreams[0].branch).toBe("feature");
  expect(execute).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

it("supports keyboard branch tabs and preserves the rename draft", async () => {
  await render();
  const switchTab = document.querySelector<HTMLButtonElement>(
    "#task-copy-switch-tab",
  )!;
  await act(async () =>
    switchTab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(
    document
      .querySelector("#task-copy-rename-tab")!
      .getAttribute("aria-selected"),
  ).toBe("true");
  await changeInput("Rename branch", "feature/draft");
  await act(async () =>
    document
      .querySelector("#task-copy-rename-tab")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
  );
  await act(async () =>
    switchTab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    ),
  );
  expect(
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Rename branch"]',
    )!.value,
  ).toBe("feature/draft");
  expect(execute).not.toHaveBeenCalled();
});
