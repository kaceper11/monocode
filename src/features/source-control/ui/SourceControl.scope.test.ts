// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SourceControl } from "./SourceControl";
import { listWorktrees, type Worktrees } from "../model/worktrees";
vi.mock("../model/worktrees", () => ({ listWorktrees: vi.fn() }));
vi.mock("./GitChangesPanel", () => ({
  GitChangesPanel: ({ cwd }: { cwd: string }) =>
    createElement("p", { "data-git-cwd": cwd }, cwd),
}));
const host = document.createElement("div");
document.body.append(host);
let root = createRoot(host);
const repositories = [
  { id: "api", projectPath: "/api", cwd: "/api-fix", label: "API" },
  { id: "web", projectPath: "/web", cwd: "/web", label: "Web" },
  { id: "missing", projectPath: "/other", cwd: "/gone", label: "Gone" },
];
const props = {
  enabled: true,
  repositories,
  cwd: "/api-fix",
  selectedRepositoryId: "api",
  onSelectRepository: vi.fn(),
  onOpenFile: vi.fn(),
  onOpenAllChanges: vi.fn(),
  onOpenCommit: vi.fn(),
};
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  vi.clearAllMocks();
});
it("validates exact checkouts, disables missing ones, and scopes the panel to the chosen repo", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(listWorktrees).mockImplementation(
    async (cwd) =>
      ({
        defaultRoot: "/",
        worktrees: [
          { path: cwd === "/api" ? "/api-fix" : cwd, missing: false },
        ],
      }) as Worktrees,
  );
  await act(async () => root.render(createElement(SourceControl, props)));
  expect(
    host.querySelector("[data-git-cwd]")?.getAttribute("data-git-cwd"),
  ).toBe("/api-fix");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Git repository: API"]')!
      .click(),
  );
  const gone = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  ].find((button) => button.textContent?.includes("Gone"))!;
  expect(gone.disabled).toBe(true);
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent === "Web")!
      .click(),
  );
  expect(props.onSelectRepository).toHaveBeenCalledWith("web");
  await act(async () =>
    root.render(
      createElement(SourceControl, {
        ...props,
        selectedRepositoryId: "web",
        cwd: "/web",
      }),
    ),
  );
  expect(
    host.querySelector("[data-git-cwd]")?.getAttribute("data-git-cwd"),
  ).toBe("/web");
  await act(async () =>
    root.render(
      createElement(SourceControl, {
        ...props,
        selectedRepositoryId: "missing",
        cwd: "/gone",
      }),
    ),
  );
  expect(host.querySelector("[data-git-cwd]")).toBeNull();
  expect(host.textContent).toContain("checkout is unavailable");
});
it("does not inspect repository lists while the Git pane is disabled", async () => {
  await act(async () =>
    root.render(createElement(SourceControl, { ...props, enabled: false })),
  );
  expect(listWorktrees).not.toHaveBeenCalled();
});
