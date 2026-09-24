// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskGitActions } from "./TaskGitActions";
import { gitRefreshBranches, gitTaskBranch } from "../../platform/tauri/fs";

vi.mock("../../platform/tauri/fs", () => ({ gitRefreshBranches: vi.fn(), gitTaskBranch: vi.fn() }));
vi.mock("./taskOps", () => ({ shortError: (error: unknown) => String(error) }));
const host = document.createElement("div");
document.body.append(host);
let root = createRoot(host);
const target = { projectPath: "/repo", worktreePath: "/repo-wt", branch: "feature", base: "main" };
const button = (text: string) => [...document.querySelectorAll("button")].find(button => button.textContent === text)!;
const trigger = (all = false) => host.querySelector<HTMLButtonElement>(all ? '[aria-label="Actions for all repositories"]' : '[aria-label^="Git actions for"]')!;
const open = async (all = false) => act(async () => trigger(all).click());
afterEach(async () => { await act(async () => root.unmount()); root = createRoot(host); vi.clearAllMocks(); });

it("pulls each exact checkout, continues after failure and reports each result", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(gitTaskBranch).mockRejectedValueOnce(new Error("Branch diverged")).mockResolvedValueOnce("topic");
  await act(async () => root.render(createElement(TaskGitActions, { all: true, targets: [target, { ...target, projectPath: "/second", worktreePath: "/second-wt", branch: "topic" }] })));
  await open(true);
  await act(async () => button("Pull all").click());
  expect(gitTaskBranch).toHaveBeenNthCalledWith(1, "/repo-wt", "feature", "feature", "main", "update");
  expect(gitTaskBranch).toHaveBeenNthCalledWith(2, "/second-wt", "topic", "topic", "main", "update");
  expect(host.textContent).toContain("repo: Pull failed");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Branch diverged");
  expect(host.textContent).toContain("second: Pull completed");
});

it("deduplicates fetches and does not pull new or busy working copies", async () => {
  await act(async () => root.render(createElement(TaskGitActions, { all: true, targets: [target, { ...target, worktreePath: "/other-wt" }] })));
  await open(true);
  await act(async () => button("Fetch all").click());
  expect(gitRefreshBranches).toHaveBeenCalledExactlyOnceWith("/repo");
  await act(async () => root.render(createElement(TaskGitActions, { targets: [{ ...target, blocked: true }] })));
  await open();
  expect(button("Pull").disabled).toBe(true);
  await act(async () => root.render(createElement(TaskGitActions, { targets: [{ ...target, worktreePath: undefined }] })));
  expect(button("Pull").disabled).toBe(true);
  expect(gitTaskBranch).not.toHaveBeenCalled();
});

it("shares in-flight exclusion with per-row controls", async () => {
  let finish!: () => void;
  vi.mocked(gitRefreshBranches).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(createElement("div", null,
    createElement(TaskGitActions, { all: true, targets: [target] }),
    createElement(TaskGitActions, { targets: [target] }),
  )));
  await open(true);
  await act(async () => button("Fetch all").click());
  expect(trigger().disabled).toBe(true);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(async () => finish());
  expect(trigger().disabled).toBe(false);
  expect(gitRefreshBranches).toHaveBeenCalledOnce();
});

it("preserves multiline errors and lets the user dismiss feedback", async () => {
  const message = "Commit or stash working copy changes before updating.\nFiles: src/example.ts";
  vi.mocked(gitTaskBranch).mockRejectedValueOnce(new Error(message));
  await act(async () => root.render(createElement(TaskGitActions, { targets: [target] })));
  await open();
  await act(async () => button("Pull").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss message"]')!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
