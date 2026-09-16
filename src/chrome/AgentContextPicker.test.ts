// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentContextPicker } from "./AgentContextPicker";
import { contextFromText, contextFromTickets } from "../lib/agentContext";
import type { Session } from "../lib/session";
import type { TaskWorkspace } from "../lib/taskWorkspaces";

async function mockTasks(tasks: Partial<TaskWorkspace>[]) {
  return vi
    .spyOn(await import("../lib/taskWorkspaces"), "loadTaskWorkspaces")
    .mockReturnValue(tasks as TaskWorkspace[]);
}

const ticket = {
  provider: "github",
  kind: "issue",
  number: 8,
  title: "Link tickets",
  state: "open",
  repo: "a/b",
  url: "https://github.com/a/b/issues/8",
  labels: [],
} as import("../lib/githubTasks").InboxItem;

const submit = () =>
  [...document.querySelectorAll("button")].find((button) =>
    ["Send to task", "Create task…"].includes(button.textContent ?? ""),
  )!;

it("retains the task destination after failure and sends once it succeeds", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const tasks = await mockTasks([
    { id: "t1", name: "Fix the flake", archived: false, sessionIds: [], children: [] },
  ]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const request = {
    context: contextFromText("Selection", "Only selected text", "/a message-2"),
    sourceSessionId: "a",
    cwd: "/a",
  };
  const onPrepare = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error("Task launch failed");
    })
    .mockReturnValue("task-session");
  const onClose = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(AgentContextPicker, {
          request,
          sessions: [
            { id: "a", harness: "codex", cwd: "/a", title: "Source" },
          ] as Session[],
          onPrepare,
          onClose,
        }),
      ),
    );
    await act(async () =>
      (
        document.querySelector(
          'button[data-destination="task:t1"]',
        ) as HTMLElement
      ).click(),
    );
    await act(async () => submit().click());
    expect(document.body.textContent).toContain("Task launch failed");
    expect(
      document
        .querySelector('button[data-destination="task:t1"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => {
      submit().click();
      submit().click();
    });
    expect(onPrepare).toHaveBeenCalledTimes(2);
    expect(onPrepare).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ entries: request.context.entries }),
      }),
      { kind: "task", taskId: "t1" },
      expect.any(AbortSignal),
    );
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    tasks.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("sends tickets to a new task by default", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onPrepare = vi.fn().mockReturnValue("task-session");
  const onClose = vi.fn();
  const tickets = [
    ticket,
    { ...ticket, number: 13, url: "https://github.com/a/b/issues/13" },
  ];
  try {
    await act(async () =>
      root.render(
        createElement(AgentContextPicker, {
          request: {
            context: contextFromTickets(tickets),
            inboxItems: tickets,
            cwd: "/a",
          },
          sessions: [],
          onPrepare,
          onClose,
        }),
      ),
    );
    expect(
      document
        .querySelector('[data-destination="new-task"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => submit().click());
    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(onPrepare).toHaveBeenLastCalledWith(
      expect.anything(),
      { kind: "new-task" },
      expect.any(AbortSignal),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("asks for a task when no task owns the source session", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const tasks = await mockTasks([
    { id: "t1", name: "Fix the flake", archived: false, sessionIds: [], children: [] },
  ]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onPrepare = vi.fn().mockReturnValue("task-session");
  try {
    await act(async () =>
      root.render(
        createElement(AgentContextPicker, {
          request: {
            context: contextFromText("PR review", "selected thread", "Azure PR #13"),
            cwd: "/project",
          },
          sessions: [],
          onPrepare,
          onClose: vi.fn(),
        }),
      ),
    );
    // No default — an unrelated task must be chosen deliberately.
    expect(document.body.textContent).toContain("Choose a task.");
    expect(submit().disabled).toBe(true);
    await act(async () =>
      (
        document.querySelector(
          'button[data-destination="new-task"]',
        ) as HTMLElement
      ).click(),
    );
    expect(submit().disabled).toBe(false);
    expect(submit().textContent).toBe("Create task…");
    await act(async () => submit().click());
    expect(onPrepare).toHaveBeenCalledWith(
      expect.anything(),
      { kind: "new-task" },
      expect.any(AbortSignal),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    tasks.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("preselects the task claiming the repair's evidence checkout", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const tasks = await mockTasks([
    {
      id: "t-match",
      name: "Repo task",
      archived: false,
      sessionIds: [],
      children: [
        {
          id: "c1",
          workingCopy: "/repo",
          sessionIds: [],
          launch: { state: "ready" },
        },
      ],
    },
    { id: "t-other", name: "Other", archived: false, sessionIds: [], children: [] },
  ]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const context = contextFromText("Failure", "Run 8, attempt 2", "Azure account/repo/run");
  context.instruction = "Fix selected failure";
  const request: import("../lib/agentContext").AgentContextRequest = {
    context,
    cwd: "/repo",
    sourceSessionId: "owner",
    repair: {
      kind: "ci",
      scope: "pipeline-7",
      run: { id: 8, revision: "run-8" },
      job: { name: "Tests" },
      log: { attempt: 2 },
      source: {
        target: {
          accountId: "account",
          repositoryType: "GitHub",
          repositoryId: "team/repo",
        },
      },
      head: {
        cwd: "/repo",
        branch: "feature",
        commit: "abc",
        remote: "https://github.com/team/repo",
      },
    } as import("../lib/repair").RepairEvidence,
  };
  const onPrepare = vi.fn().mockResolvedValue("task-session");
  const onClose = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(AgentContextPicker, {
          request,
          sessions: [],
          onPrepare,
          onClose,
        }),
      ),
    );
    // The evidence-owning task is preselected and first; the other task
    // shows why it is a weaker destination.
    expect(
      document
        .querySelector('[data-destination="task:t-match"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.body.textContent).toContain("Send to · Repo task");
    expect(
      document.querySelector('[data-destination="task:t-other"]')
        ?.textContent,
    ).toContain("No matching checkout");
    // Selection and instruction gate the send.
    const check = document.body.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => check.click());
    expect(submit().disabled).toBe(true);
    await act(async () => check.click());
    await act(async () => {
      submit().click();
      submit().click();
    });
    expect(onPrepare).toHaveBeenCalledOnce();
    expect(onPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          instruction: "Fix selected failure",
        }),
      }),
      { kind: "task", taskId: "t-match" },
      expect.any(AbortSignal),
    );
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    tasks.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("keeps a stale repair draft visible but prevents another send until evidence is refreshed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const tasks = await mockTasks([
    {
      id: "t1",
      name: "Repo task",
      archived: false,
      sessionIds: [],
      children: [
        {
          id: "c1",
          workingCopy: "/repo",
          sessionIds: [],
          launch: { state: "ready" },
        },
      ],
    },
  ]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const context = contextFromText("Failure", "Selected log", "Azure");
  context.instruction = "Fix failure";
  const request = {
    context,
    cwd: "/repo",
    sourceSessionId: "owner",
    repair: {
      kind: "ci",
      scope: "ci",
      run: { id: 8, revision: "run-8" },
      job: { name: "Tests" },
      log: { attempt: 2 },
      source: {
        target: {
          accountId: "a",
          repositoryId: "repo",
          repositoryType: "GitHub",
        },
      },
      head: {
        cwd: "/repo",
        branch: "feature",
        commit: "head",
        remote: "https://github.com/a/b",
      },
    },
  } as import("../lib/agentContext").AgentContextRequest;
  const onPrepare = vi
    .fn()
    .mockRejectedValue(new Error("Run changed. Refresh evidence."));
  const onRefreshEvidence = vi.fn();
  const onClose = vi.fn();
  request.onRefreshEvidence = onRefreshEvidence;
  try {
    await act(async () =>
      root.render(
        createElement(AgentContextPicker, {
          request,
          sessions: [],
          onPrepare,
          onClose,
        }),
      ),
    );
    await act(async () => submit().click());
    expect(submit().disabled).toBe(true);
    expect(document.body.textContent).toContain("Refresh evidence");
    await act(async () => submit().click());
    expect(onPrepare).toHaveBeenCalledOnce();
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Refresh evidence")!
        .click(),
    );
    expect(onRefreshEvidence).toHaveBeenCalledExactlyOnceWith("Fix failure");
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    tasks.mockRestore();
    vi.unstubAllGlobals();
  }
});
