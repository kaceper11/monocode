// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  setWorktreeFocus,
  worktreeFocus,
  type WorktreeFocus,
} from "../model/worktreeFocus";
import { SidebarWorktreeSwitcher } from "./SidebarWorktreeSwitcher";

vi.mock("../hooks/useProjectWorktrees", () => ({
  useProjectWorktrees: () => ({
    data: {
      worktrees: [
        { path: "/picker", branch: "main", isMain: true },
        { path: "/picker-a", branch: "feature-a", isMain: false },
        { path: "/picker-b", branch: "feature-b", isMain: false },
      ],
    },
    refresh: async () => true,
  }),
}));
let root: Root;
let container: HTMLDivElement;
const select = vi.fn<(focus?: WorktreeFocus) => void>();
const render = async (pending = false, switchError?: string) => {
  await act(async () =>
    root.render(
      createElement(SidebarWorktreeSwitcher, {
        cwd: "/picker",
        onSelect: select,
        pending,
        switchError,
      }),
    ),
  );
};
const trigger = () =>
  container.querySelector<HTMLButtonElement>(
    '[aria-label="Switch working copy"]',
  )!;
const option = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    (button) => button.textContent?.includes(name),
  )!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setWorktreeFocus("/picker", undefined);
  select.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("requests a switch without publishing the destination and permits a newer selection", async () => {
  await render();
  await act(async () => trigger().click());
  await act(async () => option("feature-a").click());
  expect(select).toHaveBeenLastCalledWith({
    path: "/picker-a",
    branch: "feature-a",
  });
  expect(worktreeFocus("/picker")).toBeUndefined();
  await render(true);
  expect(trigger().getAttribute("aria-busy")).toBe("true");
  expect(trigger().textContent).toBe("Workspace");
  await act(async () => trigger().click());
  await act(async () => option("feature-b").click());
  expect(select).toHaveBeenLastCalledWith({
    path: "/picker-b",
    branch: "feature-b",
  });
  expect(worktreeFocus("/picker")).toBeUndefined();
});

it("shows a switch failure in the reopened picker", async () => {
  await render();
  await render(false, "Working copy no longer exists");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Working copy no longer exists",
  );
  expect(trigger().textContent).toBe("Workspace");
});

it("requests fallback from a deleted worktree once and does not retry while pending or failed", async () => {
  setWorktreeFocus("/picker", { path: "/deleted", branch: "gone" });
  await render();
  expect(select).toHaveBeenCalledExactlyOnceWith(undefined);
  await render(true);
  await render(false, "Could not switch working copy");
  expect(select).toHaveBeenCalledTimes(1);
  expect(worktreeFocus("/picker")?.path).toBe("/deleted");
});

it("offers task lanes independently of global worktree focus and shows activity with zero tabs", async () => {
  const pick = vi.fn();
  const task = {
    id: "task",
    title: "Ship checkout",
    createdAt: 1,
    links: [],
    workstreams: [
      {
        id: "api",
        projectPath: "/api",
        worktreePath: "/api-copy",
        branch: "feature",
        base: "main",
      },
      { id: "empty", projectPath: "/web", branch: "web", base: "main" },
    ],
  };
  setWorktreeFocus("/picker", { path: "/picker-b", branch: "feature-b" });
  await act(async () =>
    root.render(
      createElement(SidebarWorktreeSwitcher, {
        cwd: "/picker",
        onSelect: select,
        taskWorkspace: {
          task,
          tabStats: new Map([
            ["api", { tabs: 0, busy: false, needsInput: true }],
          ]),
          onSelect: pick,
        },
      }),
    ),
  );
  expect(select).not.toHaveBeenCalled();
  expect(trigger().textContent).toContain("Ship checkout · All repositories");
  await act(async () => trigger().click());
  expect(option("web · web").disabled).toBe(true);
  expect(option("api · feature").getAttribute("aria-selected")).toBe("false");
  expect(
    option("api · feature")
      .querySelector("[aria-label]")
      ?.getAttribute("aria-label"),
  ).toBe("0 open tabs, needs input");
  const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
  await act(async () =>
    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(option("api · feature"));
  await act(async () =>
    list.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(option("All repositories"));
  await act(async () => option("api · feature").click());
  expect(pick).toHaveBeenCalledExactlyOnceWith("api");
  expect(worktreeFocus("/picker")?.path).toBe("/picker-b");
});
