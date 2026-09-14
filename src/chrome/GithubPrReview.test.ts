// @vitest-environment happy-dom
import { Activity, act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { GithubPrReview } from "./GithubPrReview";
import { PREPARE_AGENT_CONTEXT } from "../lib/agentContext";
import { OPEN_PROJECT_PATH } from "../lib/recents";

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

const pr = {
  number: 42,
  title: "Fix scoped review",
  url: "https://github.com/acme/app/pull/42",
  state: "OPEN",
  headRefOid: "head42",
  headRefName: "feature",
  baseRefName: "main",
  mergeStateStatus: "CLEAN",
  reviewDecision: "CHANGES_REQUESTED",
  isDraft: false,
  checks: [
    {
      name: "build",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/acme/app/actions/runs/1",
      outputTitle: "failed step",
      outputText: "error output",
    },
    { name: "lint", status: "completed", conclusion: "success", url: "", outputTitle: "", outputText: "" },
  ],
};
const thread = {
  comments: [
    {
      id: "thread-comment-1",
      kind: "review_comment",
      author: "reviewer",
      body: "Only this selected review thread",
      createdAt: "2024-01-01T00:00:00Z",
      url: "",
      state: "",
      path: "src/file.ts",
      line: 12,
      resolved: false,
      threadId: "THREAD_1",
      replies: [
        {
          id: "thread-reply-1",
          kind: "review_comment",
          author: "author",
          body: "Will fix",
          createdAt: "2024-01-01T01:00:00Z",
          url: "",
          state: "",
          path: "src/file.ts",
          line: 12,
          resolved: false,
          threadId: "THREAD_1",
          replies: [],
        },
      ],
    },
    {
      id: "conversation-1",
      kind: "comment",
      author: "author",
      body: "General note",
      createdAt: "2024-01-01T02:00:00Z",
      url: "",
      state: "",
      path: "",
      line: null,
      resolved: false,
      threadId: "",
      replies: [],
    },
  ],
  truncated: false,
  reviewDecision: "CHANGES_REQUESTED",
  baseRefName: "main",
  headRefName: "feature",
};
const diff = {
  additions: 3,
  deletions: 1,
  files: [{ path: "src/file.ts", additions: 3, deletions: 1 }],
  patch: "diff --git a/src/file.ts b/src/file.ts\nindex 111..222 100644\n--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1,2 @@\n line\n+added\n",
  truncated: false,
};
let head = "head42";
let remoteRepo = "acme/app";
let checkouts: { cwd: string; branch: string; commit: string }[] = [];

beforeEach(() => {
  head = "head42";
  remoteRepo = "acme/app";
  checkouts = [];
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
      if (command === "git_github_repo") return remoteRepo;
      if (command === "git_github_pr_state")
        return { ...pr, headRefOid: head };
      if (command === "git_github_pr_diff") return diff;
      if (command === "git_github_work_item_thread") return thread;
      if (command === "git_github_work_item_comment")
        return "https://github.com/acme/app/pull/42#reply";
      if (command === "git_github_submit_review")
        return "https://github.com/acme/app/pull/42#pullrequestreview-7";
      if (command === "azure_ci_context")
        return {
          cwd: args.cwd,
          branch: "feature",
          commit: head,
          remotes: [{ name: "origin", url: "https://github.com/acme/app" }],
        };
      if (command === "github_pr_prepare_checkout") return "/work/app-pr-42";
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
  props: Omit<Parameters<typeof GithubPrReview>[0], "onClose">,
) {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement("button", { onClick: () => setOpen(true) }, "Pull requests"),
    createElement(
      "button",
      { onClick: () => setOpen(false), "aria-label": "Files" },
      "Files",
    ),
    createElement(
      Activity,
      { mode: open ? "visible" : "hidden" },
      createElement(GithubPrReview, {
        ...props,
        onClose: () => setOpen(false),
        onReveal: () => setOpen(true),
      }),
    ),
  );
}
async function setup(props?: Partial<Parameters<typeof GithubPrReview>[0]>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ReviewNavigation, {
        cwd: "/work/repo",
        repo: "acme/app",
        number: 42,
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

it("renders PR state, checks, anchored threads and replies inside a thread", async () => {
  const cleanup = await setup();
  try {
    await click("Pull requests");
    await act(async () => vi.waitFor(() => {
      expect(document.body.textContent).toContain("#42 Fix scoped review");
    }));
    expect(document.body.textContent).toContain("Changes requested");
    expect(document.body.textContent).toContain("1 failing");
    expect(document.body.textContent).toContain("src/file.ts:12 · Unresolved");
    await expandThread();
    expect(document.body.textContent).toContain("Only this selected review thread");
    expect(document.body.textContent).toContain("Will fix");
    const reply = document.querySelector(
      'textarea[aria-label="Reply to review thread"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(reply, "Fixed in the next push");
      reply.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Reply");
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([command, args]) =>
          command === "git_github_work_item_comment" &&
          (args as Record<string, unknown>).inReplyTo === "THREAD_1",
      ),
    ).toBe(true);
  } finally {
    await cleanup();
  }
});

it("sends a review thread to the owning agent bound to repo and PR head", async () => {
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    await click("Pull requests");
    await act(async () => vi.waitFor(() => {
      expect(document.body.textContent).toContain("Unresolved");
    }));
    await expandThread();
    await click("Send thread to agent");
    await act(async () => vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(1)));
    const request = (handoff.mock.calls[0][0] as CustomEvent).detail;
    expect(request.sourceSessionId).toBe("session-a");
    expect(request.repair.kind).toBe("github-comments");
    expect(request.repair.repo).toBe("acme/app");
    expect(request.repair.number).toBe(42);
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

it("sends failing checks bound to the PR head", async () => {
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    await click("Pull requests");
    await act(async () => vi.waitFor(() => {
      expect(document.body.textContent).toContain("Send failing checks to agent");
    }));
    await click("Send failing checks to agent");
    await act(async () => vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(1)));
    const request = (handoff.mock.calls[0][0] as CustomEvent).detail;
    expect(request.repair.kind).toBe("github-ci");
    expect(request.repair.checks.map((row: { name: string }) => row.name)).toEqual(["build"]);
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});

it("surfaces a reply failure instead of swallowing it", async () => {
  const cleanup = await setup();
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command === "git_github_work_item_comment"
      ? Promise.reject(new Error("GraphQL denied"))
      : original(command, args),
  );
  try {
    await click("Pull requests");
    await act(async () => vi.waitFor(() => {
      expect(document.body.textContent).toContain("Unresolved");
    }));
    await expandThread();
    const reply = document.querySelector(
      'textarea[aria-label="Reply to review thread"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(reply, "still failing");
      reply.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Reply");
    await act(async () => vi.waitFor(() => {
      expect(document.body.textContent).toContain("GraphQL denied");
    }));
  } finally {
    await cleanup();
  }
});

it("rejects a checkout bound to a different repository", async () => {
  remoteRepo = "other/fork";
  const cleanup = await setup({ cwd: "/work/fork" });
  try {
    await click("Pull requests");
    await act(async () => vi.waitFor(() => {
      expect(document.body.textContent).toContain("bound to acme/app");
    }));
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([command]) => command === "git_github_pr_state",
      ),
    ).toBe(false);
  } finally {
    await cleanup();
  }
});

it("prepares an isolated checkout bound to the PR head and opens it", async () => {
  const cleanup = await setup();
  const opened = vi.fn();
  window.addEventListener(OPEN_PROJECT_PATH, opened);
  try {
    await click("Pull requests");
    await act(async () => vi.waitFor(() => {
      expect(document.body.textContent).toContain("Open in worktree");
    }));
    await click("Open in worktree");
    await act(async () => vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1)));
    expect(
      vi.mocked(invoke).mock.calls.some(
        ([command, args]) =>
          command === "github_pr_prepare_checkout" &&
          (args as Record<string, unknown>).expectedRevision === "head42" &&
          (args as Record<string, unknown>).repo === "acme/app",
      ),
    ).toBe(true);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe("/work/app-pr-42");
  } finally {
    window.removeEventListener(OPEN_PROJECT_PATH, opened);
    await cleanup();
  }
});

it("embeds without the surface header for inbox detail", async () => {
  const cleanup = await setup({ embedded: true, sourceSessionId: undefined });
  try {
    await click("Pull requests");
    await act(async () => vi.waitFor(() => {
      expect(document.body.textContent).toContain("src/file.ts:12");
    }));
    expect(document.querySelector("h2")).toBeNull();
  } finally {
    await cleanup();
  }
});

async function typeText(selector: string, text: string) {
  const input = document.querySelector(selector) as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function addLineComment(label: string, text: string) {
  const gutter = document.querySelector(
    `[aria-label="${label}"]`,
  ) as HTMLButtonElement;
  expect(gutter).not.toBeNull();
  await act(async () => gutter.click());
  await typeText('[role="dialog"] textarea', text);
  await click("Add to review");
}

it("submits an inline review pinned to the viewed head", async () => {
  const cleanup = await setup();
  try {
    await click("Pull requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(
          document.querySelector('[aria-label="Submit a review"]'),
        ).not.toBeNull();
      }),
    );
    await addLineComment("Comment on line 2", "Nit inline");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain(
          "Review · 1 line comment",
        );
      }),
    );
    await click("Request changes");
    await act(async () =>
      vi.waitFor(() => {
        expect(
          vi.mocked(invoke).mock.calls.some(
            ([command, args]) =>
              command === "git_github_submit_review" &&
              (args as Record<string, unknown>).repo === "acme/app" &&
              (args as Record<string, unknown>).number === 42 &&
              (args as Record<string, unknown>).commitId === "head42" &&
              (args as Record<string, unknown>).event ===
                "REQUEST_CHANGES" &&
              JSON.stringify(
                (args as Record<string, unknown>).comments,
              ) ===
                JSON.stringify([
                  {
                    path: "src/file.ts",
                    line: 2,
                    side: "RIGHT",
                    body: "Nit inline",
                  },
                ]),
          ),
        ).toBe(true);
      }),
    );
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("Review submitted");
      }),
    );
  } finally {
    await cleanup();
  }
});

it("approves with a summary and no inline comments", async () => {
  const cleanup = await setup();
  try {
    await click("Pull requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(
          document.querySelector('[aria-label="Submit a review"]'),
        ).not.toBeNull();
      }),
    );
    await typeText('textarea[aria-label="Review summary"]', "LGTM");
    await click("Approve");
    await act(async () =>
      vi.waitFor(() => {
        expect(
          vi.mocked(invoke).mock.calls.some(
            ([command, args]) =>
              command === "git_github_submit_review" &&
              (args as Record<string, unknown>).event === "APPROVE" &&
              (args as Record<string, unknown>).body === "LGTM" &&
              JSON.stringify(
                (args as Record<string, unknown>).comments,
              ) === "[]",
          ),
        ).toBe(true);
      }),
    );
  } finally {
    await cleanup();
  }
});

it("drops pending line comments when the PR head moves", async () => {
  const cleanup = await setup();
  try {
    await click("Pull requests");
    await act(async () =>
      vi.waitFor(() => {
        expect(
          document.querySelector('[aria-label="Submit a review"]'),
        ).not.toBeNull();
      }),
    );
    await addLineComment("Comment on line 2", "Stale draft");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain("1 line comment");
      }),
    );
    head = "head43";
    await click("Refresh PR");
    await act(async () =>
      vi.waitFor(() => {
        expect(document.body.textContent).toContain(
          "Comment on a diff line to include it in the review",
        );
      }),
    );
    expect(document.body.textContent).not.toContain("Stale draft");
  } finally {
    await cleanup();
  }
});
