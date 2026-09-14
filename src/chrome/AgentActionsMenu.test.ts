// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { newSession, type Session } from "../lib/session";
import { loadAgentActions } from "../lib/agentActions";
import type { GitDiffIndex } from "../lib/fs";
import { AgentActionsMenu } from "./AgentActionsMenu";
import type { ActionRun } from "./AgentActionSheet";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const cleanIndex: GitDiffIndex = {
  branch: "main",
  files: [],
  additions: 0,
  deletions: 0,
  remote: null,
  upstream: null,
  defaultBranch: "main",
  ahead: 0,
  behind: 0,
  aheadOfDefault: 0,
  opInProgress: false,
  op: "",
  conflicts: [],
  mergeHead: null,
  detached: false,
  localOnly: [],
};

function render(props: Partial<Parameters<typeof AgentActionsMenu>[0]> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onRun = vi.fn();
  const onRunNew = vi.fn();
  const session = newSession("codex", "/tmp/project");
  const run = () =>
    root.render(
      createElement(AgentActionsMenu, {
        session,
        workCwd: "/tmp/project",
        onRun,
        onRunNew,
        ...props,
      }),
    );
  return { host, root, onRun, onRunNew, session, run };
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuItems = () => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const buttonByText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim().includes(text),
  );

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(invoke).mockReset();
});

describe("AgentActionsMenu", () => {
  it("lists the seeded actions and opens the run sheet for one", async () => {
    const { host, root, run } = render();
    try {
      await act(async () => run());
      const trigger = host.querySelector<HTMLButtonElement>(
        'button[aria-label="Agent actions"]',
      )!;
      await act(async () => trigger.click());
      expect(menu()).not.toBeNull();
      const labels = menuItems().map((item) => item.textContent?.trim());
      expect(labels).toEqual(
        expect.arrayContaining([
          "Implement",
          "Review",
          "Test",
          "Edit actions…",
        ]),
      );
      await act(async () =>
        menuItems()
          .find((item) => item.textContent?.trim() === "Review")!
          .click(),
      );
      expect(menu()).toBeNull();
      const sheet = dialog()!;
      expect(sheet.textContent).toContain("Review");
      expect(
        sheet.querySelector<HTMLTextAreaElement>("#action-instructions")
          ?.value,
      ).toContain("Review the working tree changes");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("gathers context at run time and submits a stamped action run", async () => {
    vi.mocked(invoke).mockResolvedValue({
      ...cleanIndex,
      files: [
        {
          path: "/tmp/project/src/a.ts",
          relative: "src/a.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          staged: false,
          unstaged: true,
        },
      ],
      additions: 3,
      deletions: 1,
    });
    const { host, root, onRun, run } = render();
    try {
      await act(async () => run());
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Agent actions"]',
          )!
          .click(),
      );
      await act(async () =>
        menuItems()
          .find((item) => item.textContent?.trim() === "Review")!
          .click(),
      );
      await act(async () => buttonByText("Run")!.click());
      expect(onRun).toHaveBeenCalledOnce();
      const submitted: ActionRun = onRun.mock.calls[0]![0];
      expect(submitted.action.actionId).toBe("review");
      expect(submitted.action.name).toBe("Review");
      expect(submitted.action.revision).toMatch(/^[0-9a-f]{8}$/);
      expect(submitted.text).toContain("Action: Review");
      expect(submitted.text).toContain("src/a.ts");
      expect(submitted.text).toContain("reference material");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("does not submit when the sheet is closed while context gathers", async () => {
    // Hold the changes scan open so Cancel lands mid-gather — a late resolve
    // must not submit after the sheet is gone.
    let release!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    const { host, root, onRun, run } = render();
    try {
      await act(async () => run());
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Agent actions"]',
          )!
          .click(),
      );
      await act(async () =>
        menuItems()
          .find((item) => item.textContent?.trim() === "Review")!
          .click(),
      );
      await act(async () => buttonByText("Run")!.click());
      await act(async () => buttonByText("Cancel")!.click());
      expect(dialog()).toBeNull();
      await act(async () => release({ ...cleanIndex }));
      expect(onRun).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("runs in a new conversation even when the session already queued it", async () => {
    const queuedSession: Session = {
      ...newSession("codex", "/tmp/project"),
      queuedMessages: [
        {
          id: "q1",
          text: "Action: Implement",
          attachments: [],
          action: {
            actionId: "implement",
            name: "Implement",
            revision: "abcd1234",
          },
        },
      ],
    };
    const { host, root, onRun, onRunNew, run } = render({
      session: queuedSession,
    });
    try {
      await act(async () => run());
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Agent actions"]',
          )!
          .click(),
      );
      await act(async () =>
        menuItems()
          .find((item) => item.textContent?.trim() === "Implement")!
          .click(),
      );
      // The same-session run is guarded…
      const submit = dialog()!.querySelector<HTMLButtonElement>(
        "button.bg-content",
      )!;
      expect(submit.textContent).toContain("Queued");
      expect(submit.disabled).toBe(true);
      // …but a new conversation is a fresh session and stays runnable.
      const radio = [
        ...dialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ][1]!;
      await act(async () => radio.click());
      const start = buttonByText("Start session and run")!;
      expect(start.disabled).toBe(false);
      await act(async () => start.click());
      expect(onRun).not.toHaveBeenCalled();
      expect(onRunNew).toHaveBeenCalledOnce();
      const [runData, destination] = onRunNew.mock.calls[0]!;
      expect(runData.action.actionId).toBe("implement");
      expect(destination.cwd).toBe("/tmp/project");
      expect(destination.harness).toBe("codex");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("queues on a busy session and refuses a second identical queued run", async () => {
    const busy: Session = {
      ...newSession("codex", "/tmp/project"),
      busy: true,
    };
    const { host, root, onRun, run } = render({ session: busy });
    try {
      await act(async () => run());
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Agent actions"]',
          )!
          .click(),
      );
      await act(async () =>
        menuItems()
          .find((item) => item.textContent?.trim() === "Test")!
          .click(),
      );
      const queue = buttonByText("Queue")!;
      expect(queue.disabled).toBe(false);
      await act(async () => queue.click());
      expect(onRun).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("opens the manage sheet from the menu", async () => {
    const { host, root, run } = render();
    try {
      await act(async () => run());
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Agent actions"]',
          )!
          .click(),
      );
      await act(async () => buttonByText("Edit actions…")!.click());
      const sheet = dialog()!;
      expect(sheet.textContent).toContain("Saved prompts run on a task");
      expect(buttonByText("New action")).not.toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("keeps project-scoped actions out of another project's menu", async () => {
    loadAgentActions();
    localStorage.setItem(
      "monocode.agentActions.v1",
      JSON.stringify({
        seeded: true,
        actions: [
          {
            id: "implement",
            name: "Implement",
            instructions: "do it",
            context: [],
          },
          {
            id: "other-project",
            name: "Hidden",
            instructions: "nope",
            context: [],
            projectId: "other",
          },
        ],
      }),
    );
    const { host, root, run } = render({
      project: {
        id: "p1",
        repositories: [],
        sets: [],
        commands: [],
        commandGroups: [],
      },
    });
    try {
      await act(async () => run());
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Agent actions"]',
          )!
          .click(),
      );
      const labels = menuItems().map((item) => item.textContent?.trim());
      expect(labels).toContain("Implement");
      expect(labels).not.toContain("Hidden");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
