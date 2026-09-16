// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TaskCreateSheet } from "./TaskCreateSheet";
import { ensureProjectForPath } from "../lib/projects";
import {
  publishRepositoryFamilies,
  type RepositoryFamily,
} from "../lib/repositoryFamilies";
import { loadTaskWorkspaces } from "../lib/taskWorkspaces";
import { pathKey } from "../lib/paths";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

function family(path: string): RepositoryFamily {
  return {
    commonDir: `${path}/.git`,
    checkout: path,
    worktrees: [
      {
        path,
        head: "abc123",
        branch: "refs/heads/main",
        main: true,
        missing: false,
        locked: null,
        prunable: null,
      },
    ],
  };
}

const seeded = new Map<string, RepositoryFamily>();

function seed(path: string) {
  const fam = family(path);
  const project = ensureProjectForPath(path, fam);
  seeded.set(pathKey(path), fam);
  publishRepositoryFamilies(new Map(seeded));
  return project;
}

function option(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (button) =>
      button.querySelector("span.font-mono")?.textContent?.trim() === label,
  );
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  seeded.clear();
  publishRepositoryFamilies(new Map());
  vi.mocked(invoke).mockReset().mockImplementation(async (cmd, args) => {
    if (cmd === "git_repository_family") {
      const cwd = (args as { cwd: string }).cwd;
      const fam =
        seeded.get(pathKey(cwd)) ??
        [...seeded.values()].find((entry) =>
          entry.worktrees.some(
            (copy) => pathKey(copy.path) === pathKey(cwd),
          ),
        );
      if (!fam) throw new Error("not a repository");
      return fam;
    }
    if (cmd === "git_worktree_refs") {
      return [
        { name: "refs/heads/main", commit: "abc123" },
        { name: "refs/heads/topic", commit: "def4567890" },
        { name: "refs/remotes/origin/HEAD", commit: "abc123" },
      ];
    }
    throw new Error(`Unexpected ${cmd}`);
  });
});

afterEach(() => vi.unstubAllGlobals());

async function renderSheet(props: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const onCreated = vi.fn();
  await act(async () =>
    root.render(
      createElement(TaskCreateSheet, { onClose, onCreated, ...props }),
    ),
  );
  return { host, root, onClose, onCreated };
}

async function unmount(root: ReturnType<typeof createRoot>, host: HTMLElement) {
  await act(async () => root.unmount());
  host.remove();
}

it("owns project selection and resets repositories when it changes", async () => {
  seed("/tmp/app");
  seed("/tmp/lib");
  const { host, root } = await renderSheet();
  try {
    // No initial project — the picker inside the modal gates the repo list.
    expect(document.body.textContent).toContain(
      "Choose a project above to pick its repositories",
    );
    expect(document.querySelector('[aria-label="Select app"]')).toBeNull();

    await act(async () =>
      (document.querySelector('[aria-label="Task project"]') as HTMLElement)
        .click(),
    );
    await act(async () => option("app")!.click());
    expect(
      document.querySelector('[aria-label="Select app"]'),
    ).not.toBeNull();

    // A switch drops the previous project's selections and drafts — its
    // repository ids mean nothing under the new project.
    await act(async () =>
      (document.querySelector('[aria-label="Select app"]') as HTMLElement)
        .click(),
    );
    expect(document.body.textContent).toContain("New worktree");
    await act(async () =>
      (document.querySelector('[aria-label="Task project"]') as HTMLElement)
        .click(),
    );
    await act(async () => option("lib")!.click());
    expect(document.querySelector('[aria-label="Select app"]')).toBeNull();
    expect(
      document.querySelector('[aria-label="Select lib"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain("New worktree");
  } finally {
    await unmount(root, host);
  }
});

it("attaches an existing branch to a new worktree", async () => {
  const project = seed("/tmp/app");
  const { host, root, onCreated } = await renderSheet({
    projectId: project.id,
  });
  try {
    await act(async () =>
      setValue(
        document.querySelector('[aria-label="Task name"]') as HTMLInputElement,
        "Fix retry",
      ),
    );
    await act(async () =>
      (document.querySelector('[aria-label="Select app"]') as HTMLElement)
        .click(),
    );
    const mode = [...document.querySelectorAll('[role="radio"]')].find(
      (entry) => entry.textContent === "Existing branch",
    ) as HTMLElement;
    await act(async () => mode.click());
    // Refs resolve asynchronously — flush the loadRefs promise.
    await act(async () => {});
    await act(async () =>
      (
        document.querySelector(
          '[aria-label="Existing branch for app"]',
        ) as HTMLElement
      ).click(),
    );
    // `main` is checked out in the main worktree — only `topic` is offered.
    expect(option("main")).toBeUndefined();
    expect(option("origin/HEAD")).toBeUndefined();
    await act(async () => option("topic")!.click());
    const location = document.querySelector(
      '[aria-label="Location for app"]',
    ) as HTMLInputElement;
    expect(location.value).toBe("/tmp/app-topic");

    await act(async () =>
      (
        [...document.querySelectorAll("button")].find(
          (entry) => entry.textContent === "Create task",
        ) as HTMLElement
      ).click(),
    );
    const [task] = loadTaskWorkspaces();
    expect(task.name).toBe("Fix retry");
    expect(task.projectId).toBe(project.id);
    const [child] = task.children;
    expect(child.existingBranch).toBe("refs/heads/topic");
    expect(child.branch).toBe("topic");
    expect(child.baseCommit).toBe("def4567890");
    expect(child.baseRef).toBeUndefined();
    expect(child.workingCopy).toBe("/tmp/app-topic");
    expect(onCreated).toHaveBeenCalledWith(task.id);
  } finally {
    await unmount(root, host);
  }
});
