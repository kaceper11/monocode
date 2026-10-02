// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TaskDeliveryPanel, orderedCheckNodes } from "./TaskDeliveryPanel";
import { addTask, loadBoard, updateTask } from "./boardStore";
import {
  groupedDeliveryChecks,
  commentEvidence,
  evidenceFingerprint,
  loadComments,
  probeDelivery,
  snapshotIdentity,
  type DeliverySnapshot,
  type ReviewComment,
} from "./delivery";
import { replyDraftKey, replyScope } from "./replyDrafts";
import type { Session } from "../sessions/model/session";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (value: string) => value,
}));
vi.mock("./delivery", async (original) => ({
  ...(await original<typeof import("./delivery")>()),
  loadComments: vi.fn(),
  probeDelivery: vi.fn(),
}));
vi.mock("../source-control/model/worktrees", () => ({
  listWorktrees: vi.fn(async () => ({
    worktrees: [
      { path: "/copy", branch: "feature", head: "head", missing: false },
    ],
  })),
}));
vi.mock("../inbox/ui/InboxComments", () => ({
  InboxComments: ({ thread }: { thread: { comments: ReviewComment[] } }) =>
    createElement("p", {}, thread.comments[0].body),
}));
const lane = {
  id: "lane",
  projectPath: "/repo",
  worktreePath: "/copy",
  branch: "feature",
  base: "main",
};
const source = {
  provider: "github" as const,
  repo: "a/b",
  host: "github.com",
  account: "1",
};
const snapshot: DeliverySnapshot = {
  source,
  pr: {
    number: 1,
    title: "Fix",
    url: "https://github.com/a/b/pull/1",
    state: "open",
  },
  checks: [
    {
      id: "job",
      source,
      sha: "head",
      jobId: 1,
      name: "Tests",
      state: "failure",
      bucket: "fail",
      url: "",
    },
  ],
  headSha: "head",
  localHead: "head",
};
const comment: ReviewComment = {
  id: "comment",
  threadId: "thread",
  body: "Validate the remote",
  author: "reviewer",
  createdAt: "",
  state: "",
  url: "",
  path: "",
  line: null,
  resolved: false,
  kind: "inline",
  replies: [],
};
let root: Root, host: HTMLDivElement;
const handoff = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.clearAllMocks();
  addTask({ title: "Task", links: [], workstreams: [lane] });
  vi.mocked(probeDelivery).mockResolvedValue(snapshot);
  vi.mocked(loadComments).mockResolvedValue({
    comments: [comment],
    truncated: false,
  } as Awaited<ReturnType<typeof loadComments>>);
  vi.mocked(invoke).mockResolvedValue({
    nodes: [{ id: "step", name: "Run tests", kind: "step", state: "fail" }],
    annotations: [],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async (
  tab: "pr" | "checks",
  sessions: Session[] = [],
  onSend = vi.fn(async () => true),
  onSpawn = vi.fn(async () => ({
    sessionId: "draft-session",
    worktreePath: "/copy",
  })),
  ws = lane,
) =>
  act(async () =>
    root.render(
      createElement(TaskDeliveryPanel, {
        task: loadBoard().tasks[0],
        ws,
        status: {
          delivery: snapshot,
          pr: snapshot.pr,
          checks: snapshot.checks,
        },
        tab,
        sessions,
        onHandoff: handoff,
        onSend,
        onSpawn,
        onSources: vi.fn(),
        onOpenSession: vi.fn(),
      }),
    ),
  );
const click = async (label: string) =>
  act(async () => {
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) =>
        button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label,
    );
    expect(button, label).toBeDefined();
    button!.click();
  });

it("loads native details only on expansion, keeps comments out of Checks, and scopes repairs", async () => {
  await render("checks");
  expect(loadComments).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  await click("Tests details");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("task_delivery_details", {
    cwd: "/copy",
    check: snapshot.checks[0],
  });
  expect(host.textContent).toContain("Run tests");
  await click("Fix");
  expect(handoff).toHaveBeenCalledWith("ci", ["job"]);
  await render("pr");
  await click("Address this");
  expect(handoff).toHaveBeenCalledWith("comments", ["comment:thread"]);
});

it("previews replies without overwriting existing drafts and refuses a changed revision", async () => {
  const task = loadBoard().tasks[0],
    scope = replyScope(snapshot),
    key = replyDraftKey(scope, "thread");
  updateTask(task.id, {
    replyDrafts: { [key]: "My edited draft" },
    replyRequest: {
      id: "request",
      sessionId: "draft-session",
      scope,
      identity: snapshotIdentity(snapshot),
      fingerprint: evidenceFingerprint([commentEvidence(comment)]),
      threadIds: ["thread"],
    },
  });
  const sessions = [
    {
      id: "draft-session",
      blocks: [
        {
          role: "assistant",
          text: JSON.stringify({
            requestId: "request",
            replies: [{ threadId: "thread", body: "Agent draft" }],
          }),
        },
      ],
    },
  ] as Session[];
  await render("pr", sessions);
  await click("Import replies from session");
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("My edited draft");
  const choice = document.querySelector<HTMLInputElement>(
    'input[aria-label="Replace existing draft · thread"]',
  )!;
  expect(choice.checked).toBe(false);
  await act(async () => choice.click());
  vi.mocked(probeDelivery).mockResolvedValue({
    ...snapshot,
    headSha: "changed",
  });
  await click("Import selected drafts");
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("My edited draft");
  expect(document.body.textContent).toContain("Provider or revision changed");
  vi.mocked(probeDelivery).mockResolvedValue(snapshot);
  updateTask(task.id, { replyDrafts: { [key]: "Changed in another editor" } });
  await click("Import selected drafts");
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe(
    "Changed in another editor",
  );
  expect(document.body.textContent).toContain("changed after preview");
  await click("Cancel");
  await render("pr", sessions);
  await click("Import replies from session");
  await act(async () =>
    document
      .querySelector<HTMLInputElement>(
        'input[aria-label="Replace existing draft · thread"]',
      )!
      .click(),
  );
  await click("Import selected drafts");
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("Agent draft");
});

it("refuses import when the lane or its binding changed under the preview", async () => {
  const task = loadBoard().tasks[0],
    scope = replyScope(snapshot);
  updateTask(task.id, {
    // An existing draft forces the conflict-preview path — direct import only
    // fires when no reply would overwrite user text.
    replyDrafts: { [replyDraftKey(scope, "thread")]: "Kept draft" },
    replyRequest: {
      id: "request",
      sessionId: "draft-session",
      scope,
      identity: snapshotIdentity(snapshot),
      fingerprint: evidenceFingerprint([commentEvidence(comment)]),
      threadIds: ["thread"],
    },
  });
  const sessions = [
    {
      id: "draft-session",
      blocks: [
        {
          role: "assistant",
          text: JSON.stringify({
            requestId: "request",
            replies: [{ threadId: "thread", body: "Agent draft" }],
          }),
        },
      ],
    },
  ] as Session[];
  await render("pr", sessions);
  await act(async () => {});
  // A conflicting existing draft routes the auto-import into the preview.
  expect(document.body.textContent).toContain("Agent draft");
  await act(async () =>
    document
      .querySelector<HTMLInputElement>(
        'input[aria-label="Replace existing draft · thread"]',
      )!
      .click(),
  );
  // The lane was deleted (or rebound) while the preview sat open — a stale
  // prop must not pass verification.
  updateTask(task.id, (current) => ({
    ...current,
    workstreams: current.workstreams.filter((entry) => entry.id !== lane.id),
  }));
  await click("Import selected drafts");
  expect(
    loadBoard().tasks[0].replyDrafts?.[replyDraftKey(scope, "thread")],
  ).toBe("Kept draft");
  expect(document.body.textContent).toContain("Task or reply request changed");
});

it("drafts replies inline: spawns a new agent, records the request and auto-opens the review", async () => {
  const send = vi.fn(async () => true);
  const spawn = vi.fn(async () => ({
    sessionId: "draft-session",
    worktreePath: "/copy",
  }));
  await render("pr", [], send, spawn);
  await click("Draft reply");
  // The composer stays inside the panel — a session picker, no navigation.
  const agentPicker = [...document.querySelectorAll("button")].find(
    (button) =>
      button.getAttribute("aria-label")?.startsWith("Drafting agent:"),
  );
  expect(agentPicker?.textContent).toContain("New agent · configured default");
  await click("Draft replies");
  expect(spawn).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
  const [sessionId, prompt] = send.mock.calls[0];
  expect(sessionId).toBe("draft-session");
  expect(prompt).toContain('"thread"');
  expect(prompt).toContain(
    "Do not change code, post replies, or resolve threads",
  );
  const task = loadBoard().tasks[0];
  expect(task.replyRequest?.sessionId).toBe("draft-session");
  expect(task.replyRequest?.threadIds).toEqual(["thread"]);
  expect(handoff).not.toHaveBeenCalled();
  // The session completes — the bundle parses against this request and lands
  // straight in the draft editors (no review step when nothing is replaced).
  await render(
    "pr",
    [
      {
        id: "draft-session",
        title: "Agent",
        blocks: [
          {
            role: "assistant",
            text: JSON.stringify({
              requestId: task.replyRequest!.id,
              replies: [{ threadId: "thread", body: "Agent draft" }],
            }),
          },
        ],
      },
    ] as Session[],
    send,
    spawn,
  );
  await act(async () => {});
  expect(
    loadBoard().tasks[0].replyDrafts?.[
      replyDraftKey(replyScope(snapshot), "thread")
    ],
  ).toBe("Agent draft");
  expect(document.body.textContent).toContain("Replies imported");
  expect(document.body.textContent).not.toContain("Review reply drafts");
});

it("sends the draft request to a chosen existing lane session instead of spawning", async () => {
  const laneSession = {
    id: "lane-session",
    title: "Lane agent",
    harness: "devin",
    worktreeCwd: "/copy",
    branch: "feature",
  } as Session;
  const send = vi.fn(async () => true);
  const spawn = vi.fn();
  await render(
    "pr",
    [laneSession],
    send,
    spawn,
    { ...lane, sessionIds: ["lane-session"] },
  );
  await click("Draft reply");
  await act(async () => {});
  // Open the agent picker and choose the lane-bound session.
  await act(async () => {
    [...document.querySelectorAll("button")]
      .find((button) =>
        button.getAttribute("aria-label")?.startsWith("Drafting agent:"),
      )!
      .click();
  });
  await act(async () => {
    [...document.querySelectorAll("button[role='option']")]
      .find((button) => button.textContent?.includes("Lane agent"))!
      .click();
  });
  await click("Draft replies");
  expect(spawn).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0]).toBe("lane-session");
  expect(loadBoard().tasks[0].replyRequest?.sessionId).toBe("lane-session");
});

it("re-import after a remount is a no-op and a discarded draft stays discarded", async () => {
  const send = vi.fn(async () => true);
  const spawn = vi.fn(async () => ({
    sessionId: "draft-session",
    worktreePath: "/copy",
  }));
  await render("pr", [], send, spawn);
  await click("Draft reply");
  await click("Draft replies");
  const requestId = loadBoard().tasks[0].replyRequest!.id;
  const drafting = [
    {
      id: "draft-session",
      title: "Agent",
      blocks: [
        {
          role: "assistant",
          text: JSON.stringify({
            requestId,
            replies: [{ threadId: "thread", body: "Agent draft" }],
          }),
        },
      ],
    },
  ] as Session[];
  const key = replyDraftKey(replyScope(snapshot), "thread");
  await render("pr", drafting, send, spawn);
  await act(async () => {});
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("Agent draft");
  // Remount — the watcher re-sees the bundle but identical drafts must not
  // reopen the review modal.
  act(() => root.unmount());
  root = createRoot(host);
  await render("pr", drafting, send, spawn);
  await act(async () => {});
  expect(document.body.textContent).not.toContain("Review reply drafts");
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("Agent draft");
  // Discard leaves a tombstone — a further remount must not resurrect it.
  await act(async () =>
    host.querySelector("details")!.querySelector("summary")!.click(),
  );
  await click("Discard draft");
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("");
  act(() => root.unmount());
  root = createRoot(host);
  await render("pr", drafting, send, spawn);
  await act(async () => {});
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("");
  expect(document.body.textContent).not.toContain("Review reply drafts");
});

it("commits reply drafts on blur, not per keystroke, and stays open when cleared", async () => {
  const task = loadBoard().tasks[0];
  const scope = replyScope(snapshot);
  const key = replyDraftKey(scope, "thread");
  await render("pr");
  const details = host.querySelector<HTMLDetailsElement>("details")!;
  expect(details.open).toBe(false);
  await act(async () => details.querySelector("summary")!.click());
  expect(details.open).toBe(true);
  const textarea = host.querySelector("textarea")!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(textarea, "Typed reply");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Typing alone must not serialize the board — commit happens on blur.
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBeUndefined();
  await act(async () => {
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("Typed reply");
  // Re-render delivers the persisted draft as the new prop, like the
  // board-subscribed parent does.
  await render("pr");
  // Clearing the text commits "" but never collapses the editor mid-edit.
  await act(async () => {
    setValue.call(textarea, "");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("");
  expect(details.open).toBe(true);
  // Discard leaves a "" tombstone — auto-import treats it as declined rather
  // than resurrecting the draft on the next bundle.
  await click("Discard draft");
  expect(loadBoard().tasks[0].replyDrafts?.[key]).toBe("");
  expect(task.id).toBe(loadBoard().tasks[0].id);
});

it("groups runs by provider identity, preserves matrix jobs and avoids repeated GitLab jobs", () => {
  const job = snapshot.checks[0];
  const gl = { ...source, provider: "gitlab" as const };
  const pipeline = {
    ...job,
    source: gl,
    id: "pipeline:7",
    runId: 7,
    jobId: undefined,
    name: "Pipeline #7",
  };
  const checks = [
    { ...job, id: "linux", runId: 7 },
    { ...job, id: "windows", runId: 7 },
    pipeline,
    { ...job, source: gl, id: "gl-job", runId: 7 },
    { ...job, source: gl, id: "gl-job", runId: 7 },
  ];
  const groups = groupedDeliveryChecks(checks);
  expect(groups).toHaveLength(2);
  expect(groups[0].checks.map((check) => check.id)).toEqual([
    "linux",
    "windows",
  ]);
  expect(groups[1].parent?.id).toBe("pipeline:7");
  expect(groups[1].checks.map((check) => check.id)).toEqual(["gl-job"]);
});
it("orders timeline children under their parents, removes repeated IDs and survives cycles", () => {
  const node = {
    kind: "step",
    name: "Tests",
    state: "fail",
    startedAt: "",
    completedAt: "",
  };
  expect(
    orderedCheckNodes([
      { ...node, id: "step", parentId: "job" },
      { ...node, id: "stage" },
      { ...node, id: "job", parentId: "stage" },
      { ...node, id: "step", parentId: "job" },
      { ...node, id: "cycle", parentId: "cycle" },
    ]).map((node) => node.id),
  ).toEqual(["stage", "job", "step", "cycle"]);
});
