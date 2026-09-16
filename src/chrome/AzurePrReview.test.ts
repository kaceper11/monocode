// @vitest-environment happy-dom
import { Activity, act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AzurePrReview } from "./AzurePrReview";
import { PREPARE_AGENT_CONTEXT } from "../lib/agentContext";
import { AZURE_CHANGE_EVENT } from "../lib/azure";

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

const target = {
  site: "https://dev.azure.com/team",
  accountId: "account-a",
  project: "project-id",
  repository: "repo-id",
  number: 13,
};
const pr = {
  pullRequestId: 13,
  title: "Fix scoped review",
  status: "active",
  sourceRefName: "refs/heads/feature",
  targetRefName: "refs/heads/main",
  reviewers: [{ id: "reviewer", displayName: "Reviewer", vote: -5 }],
  lastMergeSourceCommit: { commitId: "source" },
};
let discovered: number[] = [];
let stale = false,
  account = "account-a";
beforeEach(() => {
  discovered = [];
  stale = false;
  account = "account-a";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, raw) => {
      const args = raw as Record<string, unknown>;
      if (command === "azure_status")
        return {
          connected: true,
          site: target.site,
          project: "Project",
          account: "Ada",
          accountId: account,
          capabilities: ["Repos"],
        };
      if (command === "azure_pr_remotes")
        return {
          items: discovered.length
            ? [
                {
                  name: "origin",
                  url: "https://dev.azure.com/team/Project/_git/repo",
                },
              ]
            : [],
          more: false,
        };
      if (command === "azure_pr_list")
        return {
          items: ((args.target as typeof target).number
            ? [(args.target as typeof target).number]
            : discovered
          ).map((number) => ({ ...pr, pullRequestId: number })),
          target,
          projectName: "Project",
          repositoryName: "repo",
          nextSkip: null,
        };
      if (command === "azure_pr_read") {
        if (args.expectedRevision && stale)
          throw new Error(
            "PR revision changed. Refresh before selecting or sending context.",
          );
        if (args.section === "summary")
          return {
            pr: { ...pr, pullRequestId: (args.target as typeof target).number },
            revision: stale ? "new-source:target" : "source:target",
          };
        if (args.section === "policies") throw new Error("Policy read denied");
        if (args.section === "threads")
          return {
            items: [
              {
                id: args.skip ? 43 : 42,
                status: "active",
                threadContext: {
                  filePath: "/file.ts",
                  rightFileStart: { line: 12 },
                },
                comments: [
                  {
                    id: 1,
                    content: "Only this selected review thread",
                    author: { displayName: "Reviewer" },
                  },
                ],
              },
            ],
            revision: "source:target",
            nextSkip: args.skip ? null : 50,
          };
        return { items: [], nextSkip: null, revision: "source:target" };
      }
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
  props: Omit<Parameters<typeof AzurePrReview>[0], "onClose">,
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
      createElement(AzurePrReview, {
        ...props,
        onClose: () => setOpen(false),
        onReveal: () => setOpen(true),
      }),
    ),
  );
}
async function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ReviewNavigation, {
        cwd: "wsl://Ubuntu/work/repo",
        branch: "feature",
        sourceSessionId: "session-a",
        enabled: true,
      }),
    ),
  );
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}
async function link() {
  await click("Pull requests");
  await click("Link a PR");
  await act(async () => {
    const input = document.querySelector(
      'input[aria-label="Azure PR link or repository remote"]',
    ) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(
      input,
      "https://dev.azure.com/team/Project/_git/repo/pullrequest/13",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Find PR");
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) =>
        button.textContent?.startsWith("#13 Fix scoped review"),
      )!
      .click(),
  );
}
async function expandThread() {
  await act(async () => {
    const details = [...document.querySelectorAll("details")].find((details) =>
      details.querySelector("summary")?.textContent?.startsWith("Thread "),
    )!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

it("finds and links a PR, isolates denied policies, pages threads, and hands off selected context once", async () => {
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    expect(invoke).not.toHaveBeenCalled();
    await link();
    expect(document.body.textContent).toContain("Reviewer: waiting for author");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([, args]) =>
            (args as Record<string, unknown>)?.section === "threads",
        ),
    ).toBe(true);
    await act(async () => {
      const details = [...document.querySelectorAll("details")].find((el) =>
        el.querySelector("summary")?.textContent?.includes("Files, policies"),
      )!;
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await act(async () =>
      vi.waitFor(() =>
        expect(document.body.textContent).toContain("Policy read denied"),
      ),
    );
    await click("Refresh PR");
    expect(document.body.textContent).not.toContain(
      "Only this selected review thread",
    );
    await expandThread();
    expect(document.body.textContent).toContain(
      "Only this selected review thread",
    );
    await click("Next threads");
    expect(document.body.textContent).toContain("Thread 43");
    await expandThread();
    await act(async () => {
      const send = button("Send thread to agent");
      send.click();
      send.click();
    });
    expect(handoff).toHaveBeenCalledTimes(1);
    const request = (handoff.mock.calls[0][0] as CustomEvent).detail;
    expect(request.sourceSessionId).toBe("session-a");
    expect(request.cwd).toBe("wsl://Ubuntu/work/repo");
    expect(request.context.entries[0].origin).toContain("account-a");
    expect(request.context.entries[0].title).toContain("thread 43");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(
      localStorage.getItem("monocode.azurePrAssociations.v1"),
    ).not.toContain("Only this selected review thread");
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});

it("blocks stale-revision handoff and keeps the association for refresh and account recovery", async () => {
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    await link();
    await click("Refresh PR");
    await expandThread();
    stale = true;
    await click("Send thread to agent");
    expect(handoff).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Refresh PR before sending context",
    );
    await click("Refresh PR");
    expect(document.body.textContent).toContain("new-source:target");
    account = "account-b";
    await act(async () => window.dispatchEvent(new Event(AZURE_CHANGE_EVENT)));
    expect(document.body.textContent).toContain(
      "Reconnect the linked Azure account",
    );
    expect(button("Refresh PR").disabled).toBe(true);
    expect(document.body.textContent).toContain("Fix scoped review");
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});

it("ignores a lookup that finishes after closing and retains the typed link for recovery", async () => {
  const cleanup = await setup();
  let resolve: (value: unknown) => void = () => {};
  const original = vi.mocked(invoke).getMockImplementation()!;
  try {
    await click("Pull requests");
    await click("Link a PR");
    await act(async () => {
      const input = document.querySelector(
        'input[aria-label="Azure PR link or repository remote"]',
      ) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(
        input,
        "https://dev.azure.com/team/Project/_git/repo/pullrequest/13",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    vi.mocked(invoke).mockImplementation((command, args) =>
      command === "azure_pr_list"
        ? new Promise((done) => {
            resolve = done;
          })
        : original(command, args),
    );
    await click("Find PR");
    await act(async () =>
      (
        document.querySelector(
          'button[aria-label="Files"]',
        ) as HTMLButtonElement
      ).click(),
    );
    await act(async () =>
      resolve({
        items: [pr],
        target,
        projectName: "Project",
        repositoryName: "repo",
        nextSkip: null,
      }),
    );
    expect(localStorage.getItem("monocode.azurePrAssociations.v1")).toBeNull();
    await click("Pull requests");
    expect(
      (
        document.querySelector(
          'input[aria-label="Azure PR link or repository remote"]',
        ) as HTMLInputElement
      ).value,
    ).toContain("pullrequest/13");
    expect(document.body.textContent).not.toContain("Choose the exact PR");
  } finally {
    await cleanup();
  }
});

it("keeps the linked PR and entered values when a PR or branch becomes unavailable", async () => {
  const cleanup = await setup();
  const original = vi.mocked(invoke).getMockImplementation()!;
  try {
    await link();
    await click("Choose another PR");
    await click("Link a PR");
    vi.mocked(invoke).mockImplementation((command, args) =>
      command === "azure_pr_list"
        ? Promise.reject(
            new Error(
              "Azure PR, repository or branch is unavailable. Check the linked target and permissions.",
            ),
          )
        : original(command, args),
    );
    await click("Find PR");
    expect(document.body.textContent).toContain("branch is unavailable");
    expect(document.body.textContent).toContain("Fix scoped review");
    expect(
      (
        document.querySelector(
          'input[aria-label="Azure PR link or repository remote"]',
        ) as HTMLInputElement
      ).value,
    ).toContain("pullrequest/13");
    expect(localStorage.getItem("monocode.azurePrAssociations.v1")).toContain(
      "source:target",
    );
  } finally {
    await cleanup();
  }
});

it("automatically opens a unique branch match but lets the user choose among multiple PRs", async () => {
  discovered = [13];
  let cleanup = await setup();
  await click("Pull requests");
  expect(document.querySelector("h3")?.textContent).toBe(
    "#13 Fix scoped review",
  );
  await act(async () =>
    vi.waitFor(() => expect(document.body.textContent).toContain("Thread")),
  );
  await cleanup();
  localStorage.setItem("monocode.azurePrAssociations.v1", "[]");
  discovered = [13, 14];
  cleanup = await setup();
  try {
    await click("Pull requests");
    expect(document.body.textContent).toContain(
      "Branch feature · remote origin",
    );
    expect(document.body.textContent).not.toContain("Address comments");
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) =>
          button.textContent?.startsWith("#14 Fix scoped review"),
        )!
        .click(),
    );
    expect(document.querySelector("h3")?.textContent).toBe(
      "#14 Fix scoped review",
    );
    await click("Choose another PR");
    await click("Link a PR");
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) =>
          button.textContent?.startsWith("#13 Fix scoped review"),
        )!
        .click(),
    );
    await click("Choose another PR");
    await click("Link a PR");
    expect(document.body.textContent).toContain("Saved PR #14");
    expect(document.body.textContent).toContain("Saved PR #13");
  } finally {
    await cleanup();
  }
});

it("labels the page limit and allows repairing a thread beyond the first twenty", async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "azure_ci_context")
      return {
        cwd: "wsl://Ubuntu/work/repo",
        branch: "feature",
        commit: "source",
        remotes: [
          {
            name: "azure",
            url: "https://dev.azure.com/team/project/_git/repo",
          },
        ],
      };
    if (
      command === "azure_pr_read" &&
      (args as Record<string, unknown>).section === "threads"
    )
      return {
        items: Array.from({ length: 21 }, (_, index) => ({
          id: index + 1,
          status: "active",
          comments: [{ id: 1, content: `Comment ${index + 1}` }],
        })),
        revision: "source:target",
        nextSkip: null,
      };
    return original(command, args);
  });
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    await link();
    await click("Refresh PR");
    expect(document.body.textContent).toContain(
      "Address comments · first 20 comments",
    );
    await act(async () => {
      const details = [...document.querySelectorAll("details")].find((el) =>
        el.querySelector("summary")?.textContent?.startsWith("Thread 21 "),
      )!;
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await click("Address this comment");
    await act(async () =>
      vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(1)),
    );
    expect(
      (handoff.mock.calls[0][0] as CustomEvent).detail.repair.threads.map(
        (thread: { id: number }) => thread.id,
      ),
    ).toEqual([21]);
    await click("Files");
    await act(async () =>
      (handoff.mock.calls[0][0] as CustomEvent).detail.onRefreshEvidence(
        "Preserve this instruction",
      ),
    );
    await click("Address this comment");
    await act(async () =>
      vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(2)),
    );
    expect(
      (handoff.mock.calls[1][0] as CustomEvent).detail.context.instruction,
    ).toBe("Preserve this instruction");
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});

it("retains the expanded thread and scroll while pausing hidden review effects", async () => {
  const cleanup = await setup();
  try {
    await link();
    await click("Refresh PR");
    await expandThread();
    const panel = document.querySelector('[aria-label="Azure pull requests"]')!;
    const thread = [...document.querySelectorAll("details")].find((el) =>
      el.querySelector("summary")?.textContent?.startsWith("Thread "),
    )!;
    panel.scrollTop = 120;
    await click("Files");
    const count = vi.mocked(invoke).mock.calls.length;
    await act(async () => window.dispatchEvent(new Event(AZURE_CHANGE_EVENT)));
    expect(invoke).toHaveBeenCalledTimes(count);
    await click("Pull requests");
    expect(document.querySelector('[aria-label="Azure pull requests"]')).toBe(
      panel,
    );
    expect(panel.scrollTop).toBe(120);
    expect(thread.isConnected).toBe(true);
    expect(thread.open).toBe(true);
    expect(document.body.textContent).toContain(
      "Only this selected review thread",
    );
  } finally {
    await cleanup();
  }
});

it("ignores a pending thread response after hiding and reopening the review", async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  let release!: () => void;
  let first = true;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (
      first &&
      command === "azure_pr_read" &&
      (args as Record<string, unknown>).section === "threads"
    ) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { items: [], revision: "source:target", nextSkip: null };
    }
    return original(command, args);
  });
  const cleanup = await setup();
  try {
    await link();
    await click("Files");
    await click("Pull requests");
    await click("Refresh PR");
    expect(document.body.textContent).toContain("Thread");
    await act(async () => release());
    expect(document.body.textContent).not.toContain("No review threads.");
    expect(document.body.textContent).toContain("Thread");
  } finally {
    release?.();
    await cleanup();
  }
});

it("opens an inline linking form and keeps entered values after Cancel", async () => {
  const cleanup = await setup();
  try {
    await click("Pull requests");
    expect(
      document.querySelector(
        'input[aria-label="Azure PR link or repository remote"]',
      ),
    ).toBeNull();
    await click("Link a PR");
    const input = document.querySelector(
      'input[aria-label="Azure PR link or repository remote"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "https://dev.azure.com/team/Project/_git/repo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Cancel");
    expect(
      document.querySelector(
        'input[aria-label="Azure PR link or repository remote"]',
      ),
    ).toBeNull();
    await click("Link a PR");
    expect(
      (
        document.querySelector(
          'input[aria-label="Azure PR link or repository remote"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("https://dev.azure.com/team/Project/_git/repo");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "azure_pr_list"),
    ).toBe(false);
  } finally {
    await cleanup();
  }
});
