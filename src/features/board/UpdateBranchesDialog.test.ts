// @vitest-environment happy-dom
import { addTask, loadBoard, updateTask } from "./boardStore";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateBranchesDialog } from "./UpdateBranchesDialog";
vi.mock("../source-control/hooks/useProjectBranches", () => ({
  useProjectBranches: () => ({
    current: "feature",
    branches: [{ name: "main" }, { name: "release", remote: "upstream" }],
  }),
}));
const host = document.createElement("div");
document.body.append(host);
let root = createRoot(host);
const rows = [
  {
    id: "api",
    projectPath: "/api",
    worktreePath: "/copy",
    branch: "feature",
    base: "old-base",
  },
];
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
});
it("defaults to repository HEAD and stages an explicitly qualified source before merging", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  addTask({ title: "Task", links: [], workstreams: rows });
  const onSubmit = vi.fn();
  await act(async () =>
    root.render(
      createElement(UpdateBranchesDialog, { rows, onSubmit, onClose: vi.fn() }),
    ),
  );
  const merge = () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Fetch & merge",
    )!;
  await act(async () => merge().click());
  expect(onSubmit).toHaveBeenLastCalledWith({ api: "HEAD" });
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label^="Merge into feature from:"]',
      )!
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent === "upstream/release")!
      .click(),
  );
  expect(onSubmit).toHaveBeenCalledTimes(1);
  await act(async () => merge().click());
  expect(onSubmit).toHaveBeenLastCalledWith({
    api: "refs/remotes/upstream/release",
  });
});

it("refuses a changed checkout after the source branch was reviewed", async () => {
  localStorage.clear();
  addTask({ title: "Task", links: [], workstreams: rows });
  const onSubmit = vi.fn();
  await act(async () =>
    root.render(
      createElement(UpdateBranchesDialog, { rows, onSubmit, onClose: vi.fn() }),
    ),
  );
  updateTask(loadBoard().tasks[0].id, {
    workstreams: [{ ...rows[0], branch: "other" }],
  });
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Fetch & merge")!
      .click(),
  );
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "checkout changed",
  );
});
