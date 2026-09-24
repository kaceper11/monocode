// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { WorkstreamEditor } from "./TaskDetailsPanel";
import { addTask, loadBoard, updateTask } from "./boardStore";
import { gitTaskBranch } from "../../platform/tauri/fs";
import { worktreeOnBranch } from "./taskOps";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => path }));
vi.mock("../../app/shell/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("../../platform/tauri/fs", async original => ({
  ...await original<typeof import("../../platform/tauri/fs")>(), gitTaskBranch: vi.fn(),
}));
vi.mock("./taskOps", async original => ({
  ...await original<typeof import("./taskOps")>(), worktreeOnBranch: vi.fn(async () => null),
}));
vi.mock("../source-control/hooks/useProjectBranches", async original => ({
  ...await original<typeof import("../source-control/hooks/useProjectBranches")>(),
  useProjectBranchesState: () => ({ settled: true, branches: { current: "main", detached: false, branches: [
    { name: "main", remote: null }, { name: "existing", remote: null }, { name: "remote-only", remote: "origin" },
  ] } }),
}));
const refresh = vi.fn();
vi.mock("../source-control/hooks/useProjectWorktrees", () => ({
  useProjectWorktrees: () => ({ data: { worktrees: [{ path: "/existing-copy", branch: "existing", missing: false }] }, refresh }),
}));
let root: Root;
let host: HTMLDivElement;
let taskId: string;
const prepare = vi.fn(async () => "/new-worktree");
const patch = vi.fn();
const lane = { id: "lane", projectPath: "/repo", branch: "main", base: "main", worktreePath: "/dirty-worktree", prUrl: "old-pr" };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  prepare.mockResolvedValue("/new-worktree");
  vi.mocked(worktreeOnBranch).mockResolvedValue(null);
  taskId = addTask({ title: "Task", links: [], workstreams: [lane] })!;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => root.render(createElement(WorkstreamEditor, {
    anchor: host, row: { ...lane, sessions: [] } as unknown as ComponentProps<typeof WorkstreamEditor>["row"],
    lanes: [lane], busy: false, onPatch: patch, onPrepareWorktree: prepare,
    onRemoveWorktree: vi.fn(), onClose: vi.fn(),
  })));
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
}
async function pickBranch(name = "existing") {
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Branch: main"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(b => b.textContent === name)!.click());
}
it("stages an existing branch and prepares a separate worktree without switching the dirty copy", async () => {
  await render(); await pickBranch();
  expect(prepare).not.toHaveBeenCalled(); expect(gitTaskBranch).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
  await act(async () => button("Create separate worktree").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "existing", base: "main" });
  expect(gitTaskBranch).not.toHaveBeenCalled();
  expect(patch).toHaveBeenCalledWith({ branch: "existing", worktreePath: "/new-worktree", prUrl: undefined });
});
it("keeps the dirty-checkout error for in-place switching and permits creating separately afterwards", async () => {
  vi.mocked(gitTaskBranch).mockRejectedValueOnce("Commit or stash working copy changes before changing or updating its branch.");
  await render(); await pickBranch();
  await act(async () => button("Switch current worktree").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Commit or stash");
  expect(patch).not.toHaveBeenCalled();
  await act(async () => button("Create separate worktree").click());
  expect(prepare).toHaveBeenCalledOnce();
});
it("uses the exact remote ref when preparing a remote-only branch", async () => {
  await render(); await pickBranch("origin/remote-only");
  await act(async () => button("Create separate worktree").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "remote-only", base: "refs/remotes/origin/remote-only" });
});
it("offers an existing worktree before attaching it", async () => {
  vi.mocked(worktreeOnBranch).mockResolvedValue({ path: "/existing-copy" } as Awaited<ReturnType<typeof worktreeOnBranch>>);
  await render(); await pickBranch();
  await act(async () => button("Create separate worktree").click());
  expect(prepare).not.toHaveBeenCalled();
  await act(async () => button("Use it").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "existing", base: "main", worktreePath: "/existing-copy" });
});
it("rejects a competing task claim that arrives after selection", async () => {
  await render(); await pickBranch();
  addTask({ title: "Owner", links: [], workstreams: [{ ...lane, id: "other", branch: "existing" }] });
  await act(async () => button("Create separate worktree").click());
  expect(prepare).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("already tracks existing");
});
it("leaves the lane unchanged when preparation fails or another edit wins the race", async () => {
  prepare.mockRejectedValueOnce(new Error("Cannot prepare"));
  await render(); await pickBranch();
  await act(async () => button("Create separate worktree").click());
  expect(patch).not.toHaveBeenCalled(); expect(loadBoard().tasks[0].workstreams[0]).toMatchObject(lane);
  prepare.mockImplementationOnce(async () => {
    updateTask(taskId, { workstreams: [{ ...lane, branch: "changed" }] });
    return "/kept-worktree";
  });
  await act(async () => button("Create separate worktree").click());
  expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Working copy kept at /kept-worktree");
});

it("creates a named worktree from a chosen starting branch without changing the PR base", async () => {
  await render();
  await act(async () => button("Create new worktree").click());
  expect(button("Create separate worktree").disabled).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Branch:"]')!.click());
  const input = document.querySelector<HTMLInputElement>('[aria-label="Pick or type a branch…"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "new-feature");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button('New branch "new-feature"').click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Start from branch: main"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(b => b.textContent === "existing")!.click());
  expect(patch).not.toHaveBeenCalled();
  await act(async () => button("Create separate worktree").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "new-feature", base: "existing" });
  expect(patch).toHaveBeenCalledWith({ branch: "new-feature", worktreePath: "/new-worktree", prUrl: undefined });
  expect(gitTaskBranch).not.toHaveBeenCalled();
});

it("validates a directly selected working copy before attaching and clears the previous PR", async () => {
  prepare.mockRejectedValueOnce(new Error("Worktree is on changed, expected existing"));
  await render();
  const selectCopy = async () => {
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Worktree:"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(b => b.textContent?.startsWith("existing —"))!.click());
  };
  await selectCopy();
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "existing", base: "main", worktreePath: "/existing-copy" });
  expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Worktree is on changed");
  prepare.mockResolvedValueOnce("/existing-copy");
  await selectCopy();
  expect(patch).toHaveBeenCalledWith({ branch: "existing", worktreePath: "/existing-copy", prUrl: undefined });
  expect(gitTaskBranch).not.toHaveBeenCalled();
});
