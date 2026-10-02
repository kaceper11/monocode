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
const treeList = {
  // `null` models the worktree list still loading — isMain/dirty are unknown.
  current: [
    // The lane's own bound copy is live — the common case must not
    // disable the branch picker.
    { path: "/dirty-worktree", branch: "main", missing: false, dirty: null, isMain: false },
    { path: "/existing-copy", branch: "existing", missing: false, dirty: null, isMain: false },
  ] as
    | {
        path: string;
        branch: string | null;
        missing: boolean;
        dirty: boolean | null;
        isMain: boolean;
      }[]
    | null,
};
vi.mock("../source-control/hooks/useProjectWorktrees", () => ({
  useProjectWorktrees: () => ({
    data: treeList.current ? { worktrees: treeList.current } : undefined,
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
  treeList.current = [
    { path: "/dirty-worktree", branch: "main", missing: false, dirty: null, isMain: false },
    { path: "/existing-copy", branch: "existing", missing: false, dirty: null, isMain: false },
  ];
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
  await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="Checkout branch: ${from}"]`)!.click());
  await act(async () => option(name).click());
}
it("surfaces the backend's dirty-checkout refusal for in-place switching", async () => {
  vi.mocked(gitTaskBranch).mockRejectedValueOnce("Commit or stash working copy changes before changing or updating its branch.");
  await render(); await pickBranch();
  await act(async () => button("Switch to existing").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Commit or stash");
  expect(patch).not.toHaveBeenCalled();
});
it("rejects a competing task claim that arrives after selection", async () => {
  await render(); await pickBranch();
  addTask({ title: "Owner", links: [], workstreams: [{ ...lane, id: "other", branch: "existing" }] });
  await act(async () => button("Switch to existing").click());
  expect(gitTaskBranch).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("already tracks existing");
});
it("leaves the lane unchanged when a bind fails or another edit wins the race", async () => {
  vi.mocked(worktreeOnBranch).mockResolvedValue({ path: "/existing-copy" } as Awaited<ReturnType<typeof worktreeOnBranch>>);
  await render(); await pickBranch();
  await act(async () => button("Switch to existing").click());
  prepare.mockRejectedValueOnce(new Error("Cannot prepare"));
  await act(async () => button("Use it").click());
  expect(patch).not.toHaveBeenCalled(); expect(loadBoard().tasks[0].workstreams[0]).toMatchObject(lane);
  prepare.mockImplementationOnce(async () => {
    updateTask(taskId, { workstreams: [{ ...lane, branch: "changed" }] });
    return "/kept-worktree";
  });
  await act(async () => button("Use it").click());
  expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Working copy kept at /kept-worktree");
});
it("detaches the bound copy without touching its branch", async () => {
  await render();
  await act(async () => button("Detach worktree").click());
  expect(prepare).not.toHaveBeenCalled();
  expect(patch).toHaveBeenCalledWith({ worktreePath: undefined });
  expect(close).toHaveBeenCalled();
});
it("detaches and retargets in one patch when a branch is staged too", async () => {
  await render(); await pickBranch();
  await act(async () => button("Detach worktree").click());
  expect(patch).toHaveBeenCalledWith({
    worktreePath: undefined,
    branch: "existing",
    prUrl: undefined,
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(gitTaskBranch).not.toHaveBeenCalled();
});
it("pins the probed PR when detaching without a retarget", async () => {
  await render({ ...lane, pr: { url: "https://x/pr/1" } } as typeof lane);
  await act(async () => button("Detach worktree").click());
  expect(patch).toHaveBeenCalledWith({
    worktreePath: undefined,
    prUrl: "https://x/pr/1",
  });
});
it("refuses to detach when the lane changed while the editor was open", async () => {
  await render();
  updateTask(taskId, { workstreams: [{ ...lane, worktreePath: "/other" }] });
  await act(async () => button("Detach worktree").click());
  expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Reopen the editor");
});
it("warns about uncommitted changes instead of letting the switch fail", async () => {
  treeList.current[0] = { ...treeList.current[0], dirty: true };
  await render();
  await pickBranch();
  expect(button("Switch to existing").disabled).toBe(true);
  expect(document.body.textContent).toContain("Uncommitted changes");
  expect(gitTaskBranch).not.toHaveBeenCalled();
});
it("does not offer an in-place switch on the repository's main checkout", async () => {
  treeList.current[0] = { ...treeList.current[0], isMain: true };
  await render();
  await pickBranch();
  expect(button("Switch to existing").disabled).toBe(true);
  expect(document.body.textContent).toContain("main checkout");
  expect(gitTaskBranch).not.toHaveBeenCalled();
});
it("offers the copy that already has the staged branch instead of a doomed switch", async () => {
  vi.mocked(worktreeOnBranch).mockResolvedValue({ path: "/existing-copy" } as Awaited<ReturnType<typeof worktreeOnBranch>>);
  await render();
  await pickBranch();
  await act(async () => button("Switch to existing").click());
  // Git can't check a branch out twice — the existing copy is offered.
  expect(gitTaskBranch).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Worktree exists");
  prepare.mockResolvedValueOnce("/existing-copy");
  await act(async () => button("Use it").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "existing", base: "main", worktreePath: "/existing-copy" });
  expect(patch).toHaveBeenCalledWith({ branch: "existing", worktreePath: "/existing-copy", prUrl: undefined });
});
it("passes the remote-qualified base when binding the offered copy", async () => {
  vi.mocked(worktreeOnBranch).mockResolvedValue({ path: "/existing-copy" } as Awaited<ReturnType<typeof worktreeOnBranch>>);
  await render();
  await pickBranch("origin/remote-only");
  await act(async () => button("Switch to remote-only").click());
  await act(async () => button("Use it").click());
  expect(prepare).toHaveBeenCalledWith({ projectPath: "/repo", branch: "remote-only", base: "origin/remote-only", worktreePath: "/existing-copy" });
});
it("switches the bound copy in place and records the new branch", async () => {
  vi.mocked(gitTaskBranch).mockResolvedValueOnce("existing");
  await render();
  await pickBranch();
  await act(async () => button("Switch to existing").click());
  expect(gitTaskBranch).toHaveBeenCalledWith(
    "/dirty-worktree", "main", "existing", "main", "switch",
  );
  expect(patch).toHaveBeenCalledWith({ branch: "existing", prUrl: undefined });
  expect(prepare).not.toHaveBeenCalled();
});
it("keeps the switch unavailable while the worktree list is still loading", async () => {
  treeList.current = null;
  await render();
  await pickBranch();
  expect(button("Switch to existing").disabled).toBe(true);
  expect(document.body.textContent).toContain("isn't available yet");
  expect(gitTaskBranch).not.toHaveBeenCalled();
});
it("refuses to hand a switched lane to an agent that started mid-mutation", async () => {
  let release!: (value: string) => void;
  vi.mocked(gitTaskBranch).mockImplementationOnce(
    () => new Promise<string>((resolve) => { release = resolve; }),
  );
  await render();
  await pickBranch();
  await act(async () => { button("Switch to existing").click(); });
  // A session started working while the checkout was in flight.
  await act(async () =>
    root.render(createElement(WorkstreamEditor, {
      anchor: host,
      row: {
        ...lane,
        sessions: [{ id: "s1", busy: true }],
      } as unknown as ComponentProps<typeof WorkstreamEditor>["row"],
      lanes: [lane] as ComponentProps<typeof WorkstreamEditor>["lanes"],
      busy: false, onPatch: patch, onPrepareWorktree: prepare,
      onRemoveWorktree: vi.fn(), onClose: close,
    })),
  );
  await act(async () => { release("existing"); });
  expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("An agent is working");
});
it("drops the branch picker entirely when the bound copy is gone from disk", async () => {
  treeList.current = [
    { path: "/dirty-worktree", branch: "main", missing: true, dirty: null, isMain: false },
  ];
  await render();
  expect(document.querySelector('[aria-label^="Checkout branch"]')).toBeNull();
  expect(document.body.textContent).toContain("Nothing on disk to switch");
  // Detach stays available — it's how the dead binding gets dropped.
  await act(async () => button("Detach worktree").click());
  expect(patch).toHaveBeenCalledWith({ worktreePath: undefined });
});
it("refuses detach when a stale lane branch resolves to no name", async () => {
  // Legacy rows can carry `refs/remotes/x` — a single-segment suffix strips
  // to an empty branch, and the staged retarget must not patch it.
  await render({ ...lane, branch: "refs/remotes/x" });
  await act(async () => button("Detach worktree").click());
  expect(patch).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Pick a valid branch name");
});
