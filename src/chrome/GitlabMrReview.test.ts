// @vitest-environment happy-dom
import { Activity, act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { GitlabMrReview } from "./GitlabMrReview";
import { clearGitlabCache } from "../lib/gitlab";
import { PREPARE_AGENT_CONTEXT } from "../lib/agentContext";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../surfaces/AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => createElement("p", {}, text),
}));

const mr = {
  number: 7,
  title: "Improve login",
  url: "https://gitlab.example.com/acme/web/-/merge_requests/7",
  state: "open",
  draft: false,
  repo: "acme/web",
  headSha: "head42",
  headRefName: "feature",
  baseRefName: "main",
  mergeStatus: "discussions_not_resolved",
  blockingDiscussionsResolved: false,
  approvalsRequired: 2,
  approvalsLeft: 1,
  approved: false,
  pipeline: {
    id: 77,
    sha: "head42",
    status: "failed",
    url: "https://gitlab.example.com/acme/web/-/pipelines/77",
  },
};
const discussions = {
  comments: [
    {
      id: "10",
      kind: "review",
      author: "reviewer",
      body: "Only this selected discussion",
      createdAt: "2024-01-01T00:00:00Z",
      url: "",
      state: "",
      path: "src/file.ts",
      line: 12,
      resolved: false,
      resolvable: true,
      threadId: "deadbeef01",
      replies: [
        {
          id: "11",
          kind: "review",
          author: "author",
          body: "Will fix",
          createdAt: "2024-01-01T01:00:00Z",
          url: "",
          state: "",
          path: "src/file.ts",
          line: 12,
          resolved: false,
          resolvable: true,
          threadId: "deadbeef01",
          replies: [],
        },
      ],
    },
    {
      id: "20",
      kind: "comment",
      author: "author",
      body: "General note",
      createdAt: "2024-01-01T02:00:00Z",
      url: "",
      state: "",
      path: "",
      line: null,
      resolved: false,
      resolvable: false,
      threadId: "cafe0002",
      replies: [],
    },
  ],
  truncated: false,
  reviewDecision: "",
  baseRefName: "main",
  headRefName: "feature",
};
const diff = {
  additions: 3,
  deletions: 1,
  files: [{ path: "src/file.ts", additions: 3, deletions: 1 }],
  patch:
    "diff --git a/src/file.ts b/src/file.ts\nindex 111..222 100644\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1,2 @@\n line\n+added\n",
  truncated: false,
};
let head = "head42";
let checkoutCommit = "head42";
let remoteRepo = "acme/web";

beforeEach(() => {
  head = "head42";
  checkoutCommit = "head42";
  remoteRepo = "acme/web";
  clearGitlabCache();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      if (command === "gitlab_repo") return remoteRepo;
      if (command === "gitlab_mr_state")
        return { ...mr, headSha: head, repo: remoteRepo };
      if (command === "gitlab_mr_diff") return diff;
      if (command === "gitlab_mr_discussions") return discussions;
      if (command === "gitlab_mr_discussion_reply")
        return "https://gitlab.example.com/acme/web/-/merge_requests/7#note_99";
      if (command === "gitlab_mr_discussion_resolve") return null;
      if (command === "azure_ci_context")
        return {
          cwd: args.cwd,
          branch: "feature",
          commit: checkoutCommit,
          remotes: [{ name: "origin", url: "https://gitlab.example.com/acme/web" }],
        };
      throw new Error(`Unexpected command ${command}`);
    });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === label,
  )!;
async function click(label: string) {
  await act(async () => button(label).click());
}
function ReviewNavigation(
  props: Omit<Parameters<typeof GitlabMrReview>[0], "onClose">,
) {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement("button", { onClick: () => setOpen(true) }, "Merge requests"),
    createElement(
      "button",
      { onClick: () => setOpen(false), "aria-label": "Files" },
      "Files",
    ),
    createElement(
      Activity,
      { mode: open ? "visible" : "hidden" },
      createElement(GitlabMrReview, {
        ...props,
        onClose: () => setOpen(false),
        onReveal: () => setOpen(true),
      }),
    ),
  );
}
async function setup(props?: Partial<Parameters<typeof GitlabMrReview>[0]>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ReviewNavigation, {
        cwd: "/work/repo",
        repo: "acme/web",
        number: 7,
        branch: "feature",
        sourceSessionId: "session-a",
        enabled: true,
        ...props,
      }),
    ),
  );
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}
async function expandThread() {
  await act(async () => {
    const details = [...document.querySelectorAll("details")].find((details) =>
      details.querySelector("summary")?.textContent?.includes("src/file.ts"),
    )!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}
async function typeReply(text: string) {
  const reply = document.querySelector(
    'textarea[aria-label="Reply to discussion"]',
  ) as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(reply, text);
    reply.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("renders MR state, pipeline, anchored discussions and replies", async () => {
  const cleanup = await setup();
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("!7 Improve login");
      }),
    );
    expect(document.body.textContent).toContain("1/2 approvals");
    expect(document.body.textContent).toContain("Blocking discussions unresolved");
    expect(document.body.textContent).toContain("Pipeline: failed");
    expect(document.body.textContent).toContain("src/file.ts:12 · Unresolved");
    await expandThread();
    expect(document.body.textContent).toContain("Only this selected discussion");
    expect(document.body.textContent).toContain("Will fix");
    await typeReply("Fixed in the next push");
    await click("Reply");
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([command, args]) =>
          command === "gitlab_mr_discussion_reply" &&
          (args as Record<string, unknown>).discussionId === "deadbeef01",
      ),
    ).toBe(true);
  } finally {
    await cleanup();
  }
});

it("resolves and unresolves a resolvable discussion", async () => {
  let resolved = false;
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command === "gitlab_mr_discussions"
      ? {
          ...discussions,
          comments: discussions.comments.map((comment) =>
            comment.threadId === "deadbeef01"
              ? { ...comment, resolved }
              : comment,
          ),
        }
      : original(command, args),
  );
  const cleanup = await setup();
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Unresolved");
      }),
    );
    await expandThread();
    await click("Resolve");
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([command, args]) =>
          command === "gitlab_mr_discussion_resolve" &&
          (args as Record<string, unknown>).discussionId === "deadbeef01" &&
          (args as Record<string, unknown>).resolved === true,
      ),
    ).toBe(true);
    resolved = true;
    await click("Refresh MR");
    await act(async () =>
      vi.waitFor(() => {
        expect(button("Unresolve")).toBeTruthy();
      }),
    );
    await expandThread();
    await click("Unresolve");
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([command, args]) =>
          command === "gitlab_mr_discussion_resolve" &&
          (args as Record<string, unknown>).resolved === false,
      ),
    ).toBe(true);
  } finally {
    await cleanup();
  }
});

it("surfaces a resolve failure instead of swallowing it", async () => {
  const cleanup = await setup();
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command === "gitlab_mr_discussion_resolve"
      ? Promise.reject(new Error("Not permitted"))
      : original(command, args),
  );
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Unresolved");
      }),
    );
    await expandThread();
    await click("Resolve");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Not permitted");
      }),
    );
  } finally {
    await cleanup();
  }
});

it("re-arms actions when a hidden tab is re-shown mid-request", async () => {
  let release: (value: unknown) => void = () => undefined;
  const gate = new Promise((resolve) => (release = resolve));
  const original = vi.mocked(invoke).getMockImplementation()!;
  const cleanup = await setup();
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Unresolved");
      }),
    );
    await expandThread();
    // Park the send flow on a state read it never finishes.
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "gitlab_mr_state" ? gate : original(command, args),
    );
    await act(async () => button("Send discussion to agent").click());
    await click("Files");
    await click("Merge requests");
    await act(async () => release(null));
    // Without the re-arm, pending stays true and every action stays disabled.
    await act(async () =>
      vi.waitFor(() => {
        expect(button("Refresh MR").disabled).toBe(false);
      }),
    );
  } finally {
    await cleanup();
  }
});

it("does not let a stale in-flight reply wipe state after a hide/re-show", async () => {
  let release: (value: unknown) => void = () => undefined;
  const gate = new Promise((resolve) => (release = resolve));
  const original = vi.mocked(invoke).getMockImplementation()!;
  const cleanup = await setup();
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Unresolved");
      }),
    );
    await expandThread();
    await typeReply("first draft");
    // Park the reply call while the tab hides and re-shows.
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "gitlab_mr_discussion_reply" ? gate : original(command, args),
    );
    await act(async () => button("Reply").click());
    await click("Files");
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Unresolved");
      }),
    );
    await expandThread();
    await typeReply("second draft");
    await act(async () => release("https://gitlab.example.com/x#note_1"));
    // The stale completion must not clear the new draft or leave the
    // thread stuck in a busy state.
    const reply = document.querySelector(
      'textarea[aria-label="Reply to discussion"]',
    ) as HTMLTextAreaElement;
    expect(reply.value).toBe("second draft");
    await act(async () =>
      vi.waitFor(() => {
        expect(button("Reply").disabled).toBe(false);
      }),
    );
  } finally {
    await cleanup();
  }
});

it("keeps the MR readable when discussions fail to load", async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command === "gitlab_mr_discussions"
      ? Promise.reject(new Error("Discussions unavailable"))
      : original(command, args),
  );
  const cleanup = await setup();
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("!7 Improve login");
      }),
    );
    expect(document.body.textContent).toContain("Discussions unavailable");
    expect(document.body.textContent).not.toContain("No review discussions.");
  } finally {
    await cleanup();
  }
});

it("resolves the project from the checkout when no repo is bound", async () => {
  const cleanup = await setup({ repo: "" });
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("!7 Improve login");
      }),
    );
    expect(document.body.textContent).toContain("acme/web");
  } finally {
    await cleanup();
  }
});

it("sends a discussion to the owning agent bound to project and MR head", async () => {
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Unresolved");
      }),
    );
    await expandThread();
    await click("Send discussion to agent");
    await act(async () =>
      vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(1)),
    );
    const request = (handoff.mock.calls[0][0] as CustomEvent).detail;
    expect(request.sourceSessionId).toBe("session-a");
    expect(request.repair.kind).toBe("gitlab-comments");
    expect(request.repair.repo).toBe("acme/web");
    expect(request.repair.number).toBe(7);
    expect(request.repair.head.commit).toBe("head42");
    expect(request.repair.head.cwd).toBe("/work/repo");
    expect(request.repair.comments).toHaveLength(1);
    expect(request.repair.comments[0].file).toBe("src/file.ts");
    expect(request.repair.comments[0].line).toBe(12);
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});

it("sends the failing pipeline bound to the MR head", async () => {
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain(
          "Send failing pipeline to agent",
        );
      }),
    );
    await click("Send failing pipeline to agent");
    await act(async () =>
      vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(1)),
    );
    const request = (handoff.mock.calls[0][0] as CustomEvent).detail;
    expect(request.repair.kind).toBe("gitlab-ci");
    expect(request.repair.pipeline.id).toBe(77);
    expect(request.repair.pipeline.status).toBe("failed");
    expect(request.repair.head.commit).toBe("head42");
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});

it("rejects dispatch when the MR head moved past the checkout", async () => {
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Unresolved");
      }),
    );
    await expandThread();
    // The MR head moved; the checkout stayed behind — evidence must not
    // dispatch for a revision the agent is not sitting on.
    head = "new-head";
    await click("Send discussion to agent");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("not at the MR head");
      }),
    );
    expect(handoff).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});

it("surfaces a reply failure instead of swallowing it", async () => {
  const cleanup = await setup();
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command === "gitlab_mr_discussion_reply"
      ? Promise.reject(new Error("GitLab denied"))
      : original(command, args),
  );
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Unresolved");
      }),
    );
    await expandThread();
    await typeReply("still failing");
    await click("Reply");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("GitLab denied");
      }),
    );
  } finally {
    await cleanup();
  }
});

it("rejects a checkout bound to a different project", async () => {
  remoteRepo = "other/fork";
  const cleanup = await setup({ cwd: "/work/fork" });
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("bound to acme/web");
      }),
    );
    // The surface read the state (state.repo is resolved fresh in the
    // backend) and refused it — no writes are possible from this view.
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([command]) => command === "gitlab_mr_discussion_reply",
      ),
    ).toBe(false);
  } finally {
    await cleanup();
  }
});

it("embeds without the surface header for inbox detail", async () => {
  const cleanup = await setup({ embedded: true, sourceSessionId: undefined });
  try {
    await click("Merge requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("src/file.ts:12");
      }),
    );
    expect(document.querySelector("h2")).toBeNull();
  } finally {
    await cleanup();
  }
});
