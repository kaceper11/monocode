// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewTaskDialog } from "./NewTaskDialog";
import { gitBranches } from "../../platform/tauri/fs";
import { saveSavedProject, selectSavedProject } from "../projects/model/savedProjects";

vi.mock("../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../platform/tauri/fs")>()),
  gitBranches: vi.fn(async () => ({ current: "main", branches: [] })),
}));
vi.mock("../source-control/hooks/useProjectBranches", async (original) => ({
  ...(await original<
    typeof import("../source-control/hooks/useProjectBranches")
  >()),
  useProjectBranchesState: () => ({
    branches: { current: "main", branches: [] },
  }),
}));
vi.mock("../source-control/hooks/useProjectWorktrees", () => ({
  useProjectWorktrees: (path: string) => ({ data: { worktrees: [{ path, branch: "main", isMain: true }], defaultRoot: "/" } }),
}));

let root: Root;
let host: HTMLDivElement;
let props: ComponentProps<typeof NewTaskDialog>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    items: [],
    recents: [],
    lanes: [],
    busy: false,
    error: "",
    initialTitle: "Checkout",
    initialProject: "/repo",
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async () =>
  act(async () => root.render(createElement(NewTaskDialog, props)));
const submit = async () =>
  act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

it("preserves the task draft when Escape closes project management", async () => {
  saveSavedProject({ id: "project", name: "Project", members: ["/repo"], presets: [] });
  selectSavedProject("project");
  await render();
  expect(document.querySelector('[aria-label="Save repository preset name"]')).toBeNull();
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  const manage = [...document.querySelectorAll('button')].find((button) => button.textContent === "Manage project & presets")!;
  await act(async () => manage.click());
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(2);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(props.onCancel).not.toHaveBeenCalled();
  expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
  expect(document.querySelector<HTMLInputElement>('form input')?.value).toBe("Checkout");
});

it("defaults Board creation to an agent session in the current project, even outside recents", async () => {
  await render();
  expect(
    document.querySelector<HTMLInputElement>('input[type="checkbox"]'),
  ).toBeNull();
  expect(document.body.textContent).toContain("Create & open agent");
  await submit();
  expect(props.onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Checkout",
      workstreams: [
        { projectPath: "/repo", worktreePath: "/repo", branch: "main", base: "HEAD" },
      ],
    }),
  );
});

it("allows task-only creation without Git IO when the last repository is removed", async () => {
  await render();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Remove repo"]')!
      .click(),
  );
  await submit();
  expect(props.onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ workstreams: [] }),
  );
  expect(gitBranches).not.toHaveBeenCalled();
});

it("adds a chosen repository directly and accepts an editable branch", async () => {
  props.initialProject = undefined;
  props.recents = [{ path: "/api", name: "api" }];
  await render();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="Add repository: Add repository…"]',
      )!
      .click(),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[role="option"]')!.click(),
  );
  expect(document.querySelector('[aria-label^="Git actions"]')).toBeNull();
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent?.includes("Create new worktree"))!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label^="Branch:"]')!.click());
  const input = document.querySelector<HTMLInputElement>('[aria-label="Pick or type a branch…"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "custom");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(button => button.textContent === 'New branch "custom"')!.click());
  await submit();
  expect(props.onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      workstreams: [{ projectPath: "/api", branch: "custom", base: "HEAD" }],
    }),
  );
});

it("creating from chat reuses its fixed checkout instead of offering a duplicate agent", async () => {
  props.fixedWorkstream = {
    projectPath: "/repo",
    worktreePath: "/existing",
    branch: "existing",
    base: "main",
  };
  await render();
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  expect(
    document.querySelector<HTMLButtonElement>('button[type="submit"]')
      ?.textContent,
  ).toContain("Create task");
  await submit();
  expect(props.onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ workstreams: [props.fixedWorkstream] }),
  );
  expect(gitBranches).not.toHaveBeenCalled();
});
