// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AgentHandoffDialog } from "./AgentHandoffDialog";
import {
  probeDelivery,
  checkEvidence,
  loadComments,
  type DeliverySnapshot,
} from "./delivery";
import { listWorktrees } from "../source-control/model/worktrees";
import type { Session } from "../sessions/model/session";
import type { TaskWorkstream } from "./boardStore";
vi.mock("./delivery", async (original) => ({
  ...(await original<typeof import("./delivery")>()),
  probeDelivery: vi.fn(),
  checkEvidence: vi.fn(),
  loadComments: vi.fn(),
}));
vi.mock("../source-control/model/worktrees", () => ({
  listWorktrees: vi.fn(),
}));
vi.mock("../sessions/data/sessionStore", () => ({
  getSession: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (v: string) => v,
}));
const lane: TaskWorkstream = {
  id: "lane",
  projectPath: "/repo",
  worktreePath: "/repo-wt",
  branch: "feature",
  base: "main",
  sessionIds: ["wrong", "right"],
};
const session = (id: string, cwd: string) =>
  ({ id, cwd, branch: "feature", title: id, harness: "codex" }) as Session;
const snapshot: DeliverySnapshot = {
  pr: {
    number: 1,
    title: "Fix",
    url: "https://github.com/a/b/pull/1",
    state: "open",
  },
  source: { provider: "github", repo: "a/b", host: "github.com", account: "1" },
  headSha: "head",
  localHead: "head",
  checks: [
    {
      id: "job",
      name: "tests",
      state: "failure",
      bucket: "fail",
      url: "https://github.com/a/b/actions/runs/1",
      sha: "head",
      source: {
        provider: "github",
        repo: "a/b",
        host: "github.com",
        account: "1",
      },
      jobId: 1,
    },
  ],
};
let root: Root, host: HTMLDivElement;
const send = vi.fn(),
  close = vi.fn(),
  spawn = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  send.mockReset().mockResolvedValue(true);
  close.mockReset();
  spawn
    .mockReset()
    .mockResolvedValue({ sessionId: "new", worktreePath: "/repo-wt" });
  vi.mocked(probeDelivery).mockReset().mockResolvedValue(snapshot);
  vi.mocked(listWorktrees)
    .mockReset()
    .mockResolvedValue({
      defaultRoot: "/",
      worktrees: [
        {
          path: "/repo-wt",
          branch: "feature",
          head: "head",
          missing: false,
          isMain: false,
          locked: false,
          prunable: false,
          dirty: false,
          unpushed: 0,
          sessionIds: [],
        },
      ],
    });
  vi.mocked(checkEvidence).mockReset().mockResolvedValue({
    id: "job",
    title: "tests",
    body: "Failure details",
    url: "https://github.com/a/b/actions/runs/1",
    selected: true,
  });
  vi.mocked(loadComments).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(workstream = lane, kind: "ci" | "comments" = "ci") {
  await act(async () =>
    root.render(
      createElement(AgentHandoffDialog, {
        workstreams: [workstream],
        kind,
        sessions: [session("wrong", "/other-wt"), session("right", "/repo-wt")],
        onSend: send,
        onSpawn: spawn,
        onClose: close,
      }),
    ),
  );
}
function button(name: string) {
  const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === name,
  );
  expect(el, name).toBeDefined();
  return el!;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
it("targets the matching worktree and preserves review on rejection", async () => {
  send.mockResolvedValue(false);
  await render();
  const picker = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Agent destination:"]',
  )!;
  expect(picker.textContent).toContain("right · codex");
  await act(async () => picker.click());
  expect(
    [...document.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim(),
    ),
  ).toEqual(["right · codex", "New agent · configured default"]);
  await click("right · codex");
  await click("Send to agent");
  expect(send).toHaveBeenCalledWith(
    "right",
    expect.stringContaining("Failure details"),
    { cwd: "/repo-wt", branch: "feature", head: "head" },
  );
  expect(close).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("did not accept");
  expect(
    document.querySelector<HTMLTextAreaElement>("textarea")!.value,
  ).toContain("Investigate");
});
it("blocks dispatch when provider evidence changes", async () => {
  await render();
  vi.mocked(probeDelivery).mockResolvedValue({
    ...snapshot,
    headSha: "new-head",
  });
  await click("Send to agent");
  expect(send).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Refresh and review again");
});
it("blocks changed worktree heads and missing worktrees", async () => {
  await render();
  vi.mocked(listWorktrees).mockResolvedValue({
    defaultRoot: "/",
    worktrees: [],
  });
  await click("Send to agent");
  expect(send).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Working copy changed");
});
it("submits once on double-click and reuses a new session after rejection", async () => {
  let release!: (accepted: boolean) => void;
  send
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    )
    .mockResolvedValueOnce(true);
  await render({ ...lane, sessionIds: [] });
  await act(async () => {
    button("Send to agent").click();
    button("Send to agent").click();
  });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => release(false));
  await click("Send to agent");
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});
it("revalidates selected comments before sending", async () => {
  const comment = {
    id: "comment",
    author: "reviewer",
    body: "Please validate this",
    url: "https://github.com/a/b/pull/1#comment",
    path: "src/a.ts",
    line: 2,
    resolved: false,
    kind: "review",
    replies: [],
  };
  vi.mocked(loadComments).mockResolvedValue({
    comments: [comment],
    truncated: false,
    reviewDecision: "",
    baseRefName: "main",
    headRefName: "feature",
  } as Awaited<ReturnType<typeof loadComments>>);
  await render(lane, "comments");
  vi.mocked(loadComments).mockResolvedValue({
    comments: [{ ...comment, resolved: true }],
    truncated: false,
    reviewDecision: "",
    baseRefName: "main",
    headRefName: "feature",
  } as Awaited<ReturnType<typeof loadComments>>);
  await click("Send to agent");
  expect(send).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Selected comments changed");
});
