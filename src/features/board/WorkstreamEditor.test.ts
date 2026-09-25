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
  useProjectWorktrees: () => ({
    data: {
      worktrees: [
        // The lane's own bound copy is live — the common case must not
        // disable the branch picker.
        { path: "/dirty-worktree", branch: "main", missing: false },
        { path: "/existing-copy", branch: "existing", missing: false },
      ],
    },
    refresh,
  }),
}));
let root: Root;
let host: HTMLDivElement;
let taskId: string;
const prepare = vi.fn(async () => "/new-worktree");
const patch = vi.fn();
const close = vi.fn();
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
async function render(row = lane, lanes = [row]) {
  await act(async () => root.render(createElement(WorkstreamEditor, {
    anchor: host,
    row: { ...row, sessions: [] } as unknown as ComponentProps<typeof WorkstreamEditor>["row"],
    lanes: lanes as ComponentProps<typeof WorkstreamEditor>["lanes"],
    busy: false, onPatch: patch, onPrepareWorktree: prepare,
    onRemoveWorktree: vi.fn(), onClose: close,
  })));
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text)!;
}
function option(text: string | ((t: string) => boolean)) {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(b =>
    typeof text === "string" ? b.textContent === text : !!b.textContent && text(b.textContent))!;
}
async function pickBranch(name = "existing", from = "main") {
  await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="Branch: ${from}"]`)!.click());
  await act(async () => option(name).click());
}
it("stages an existing branch and prepares a separate worktree without switching the dirty copy", async () => {
  await render(); await pickBranch();
  expect(prepare).not.toHaveBeenCalled(); expect(gitTaskBranch).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
  await act(async () => button("New worktree").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "existing", base: "main" });
  expect(gitTaskBranch).not.toHaveBeenCalled();
  expect(patch).toHaveBeenCalledWith({ branch: "existing", worktreePath: "/new-worktree", prUrl: undefined });
  expect(close).toHaveBeenCalled();
});
it("keeps the dirty-checkout error for in-place switching and permits creating separately afterwards", async () => {
  vi.mocked(gitTaskBranch).mockRejectedValueOnce("Commit or stash working copy changes before changing or updating its branch.");
  await render(); await pickBranch();
  await act(async () => button("Switch in place").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Commit or stash");
  expect(patch).not.toHaveBeenCalled();
  await act(async () => button("New worktree").click());
  expect(prepare).toHaveBeenCalledOnce();
});
it("uses the exact remote ref when preparing a remote-only branch", async () => {
  await render(); await pickBranch("origin/remote-only");
  await act(async () => button("New worktree").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "remote-only", base: "refs/remotes/origin/remote-only" });
});
it("offers an existing worktree before attaching it", async () => {
  vi.mocked(worktreeOnBranch).mockResolvedValue({ path: "/existing-copy" } as Awaited<ReturnType<typeof worktreeOnBranch>>);
  await render(); await pickBranch();
  await act(async () => button("New worktree").click());
  expect(prepare).not.toHaveBeenCalled();
  await act(async () => button("Use it").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "existing", base: "main", worktreePath: "/existing-copy" });
});
it("rejects a competing task claim that arrives after selection", async () => {
  await render(); await pickBranch();
  addTask({ title: "Owner", links: [], workstreams: [{ ...lane, id: "other", branch: "existing" }] });
  await act(async () => button("New worktree").click());
  expect(prepare).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("already tracks existing");
});
it("leaves the lane unchanged when preparation fails or another edit wins the race", async () => {
  prepare.mockRejectedValueOnce(new Error("Cannot prepare"));
  await render(); await pickBranch();
  await act(async () => button("New worktree").click());
  expect(patch).not.toHaveBeenCalled(); expect(loadBoard().tasks[0].workstreams[0]).toMatchObject(lane);
  prepare.mockImplementationOnce(async () => {
    updateTask(taskId, { workstreams: [{ ...lane, branch: "changed" }] });
    return "/kept-worktree";
  });
  await act(async () => button("New worktree").click());
  expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Working copy kept at /kept-worktree");
});

it("creates a named worktree from a chosen starting branch without changing the PR base", async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Worktree:"]')!.click());
  await act(async () => option("Create new worktree").click());
  expect(button("Create worktree").disabled).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Branch:"]')!.click());
  const input = document.querySelector<HTMLInputElement>('[aria-label="Pick or type a branch…"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "new-feature");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button('New branch "new-feature"').click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Base branch: main"]')!.click());
  await act(async () => option("existing").click());
  expect(patch).not.toHaveBeenCalled();
  await act(async () => button("Create worktree").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "new-feature", base: "existing" });
  expect(patch).toHaveBeenCalledWith({ branch: "new-feature", worktreePath: "/new-worktree", prUrl: undefined });
  expect(gitTaskBranch).not.toHaveBeenCalled();
});

it("validates a staged working copy before attaching it and clears the previous PR", async () => {
  prepare.mockRejectedValueOnce(new Error("Worktree is on changed, expected existing"));
  await render();
  const selectCopy = async () => {
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Worktree:"]')!.click());
    await act(async () => option(t => t.startsWith("existing —")).click());
  };
  await selectCopy();
  expect(prepare).not.toHaveBeenCalled();
  await act(async () => button("Attach working copy").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "existing", base: "main", worktreePath: "/existing-copy" });
  expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Worktree is on changed");
  prepare.mockResolvedValueOnce("/existing-copy");
  await selectCopy();
  await act(async () => button("Attach working copy").click());
  expect(patch).toHaveBeenCalledWith({ branch: "existing", worktreePath: "/existing-copy", prUrl: undefined });
  expect(gitTaskBranch).not.toHaveBeenCalled();
});

it("does not leak a create-mode base into a later branch retarget", async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Worktree:"]')!.click());
  await act(async () => option("Create new worktree").click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Base branch:"]')!.click());
  await act(async () => option("existing").click());
  // Back to the bound copy — the create-mode base is dropped.
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Worktree:"]')!.click());
  await act(async () => option(t => t.startsWith("main —")).click());
  await pickBranch();
  await act(async () => button("New worktree").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "existing", base: "main" });
});

it("detaches the bound copy without touching its branch", async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Worktree:"]')!.click());
  await act(async () => option("No working copy").click());
  await act(async () => button("Detach working copy").click());
  expect(prepare).not.toHaveBeenCalled();
  expect(patch).toHaveBeenCalledWith({ worktreePath: undefined });
  expect(close).toHaveBeenCalled();
});

it("detaches and retargets in one patch when a branch is staged too", async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Worktree:"]')!.click());
  await act(async () => option("No working copy").click());
  await pickBranch();
  await act(async () => button("Detach working copy").click());
  expect(patch).toHaveBeenCalledWith({
    worktreePath: undefined,
    branch: "existing",
    prUrl: undefined,
  });
  expect(prepare).not.toHaveBeenCalled();
});

it("pins the probed PR when detaching without a retarget", async () => {
  await render({ ...lane, pr: { url: "https://x/pr/1" } } as typeof lane);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Worktree:"]')!.click());
  await act(async () => option("No working copy").click());
  await act(async () => button("Detach working copy").click());
  expect(patch).toHaveBeenCalledWith({
    worktreePath: undefined,
    prUrl: "https://x/pr/1",
  });
});

it("retargets a copyless lane with Save branch and no git IO", async () => {
  const copyless = { id: "lane2", projectPath: "/repo", branch: "old-branch", base: "main" };
  updateTask(taskId, { workstreams: [lane, copyless] });
  await render({ ...copyless, prUrl: "old-pr" } as typeof lane, [lane, copyless]);
  await pickBranch("existing", "old-branch");
  await act(async () => button("Save branch").click());
  expect(prepare).not.toHaveBeenCalled();
  expect(gitTaskBranch).not.toHaveBeenCalled();
  expect(patch).toHaveBeenCalledWith({ branch: "existing", prUrl: undefined });
});

it("refuses to detach when the lane changed while the editor was open", async () => {
  await render();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Worktree:"]')!.click());
  await act(async () => option("No working copy").click());
  updateTask(taskId, { workstreams: [{ ...lane, worktreePath: "/other" }] });
  await act(async () => button("Detach working copy").click());
  expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Reopen the editor");
});
