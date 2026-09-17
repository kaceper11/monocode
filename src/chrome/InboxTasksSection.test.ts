// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxItem } from "../lib/githubTasks";
import type { InboxMyWork, InboxMyWorkSession } from "../lib/inboxMyWork";
import { saveAzurePrAssociation } from "../lib/azureRepos";
import { OPEN_TASK_DETAILS } from "../lib/taskWorkspaces";
import { InboxTasksSection } from "./InboxTasksSection";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const item = (over: Partial<InboxItem> = {}): InboxItem =>
  ({
    provider: "github",
    kind: "issue",
    number: 1,
    title: "Ticket",
    url: "https://github.com/acme/app/issues/1",
    repo: "acme/app",
    state: "open",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    projectPath: "/repo",
    ...over,
  }) as InboxItem;

const session = (
  over: Partial<InboxMyWorkSession>,
): InboxMyWorkSession => ({
  sessionId: "s1",
  title: "Claude · work",
  harness: "claude",
  cwd: "/repo",
  state: "idle",
  ...over,
});

const work = (over: Partial<InboxMyWork>): InboxMyWork => ({
  hasWork: true,
  tasks: [],
  sessions: [],
  prs: [],
  ci: [],
  attention: [],
  ...over,
});

const emptyDelivery = {
  prs: 0,
  prNeedsAttention: false,
  ci: 0,
  ciRunning: false,
  ciFailing: false,
};

async function render(
  value: Parameters<typeof InboxTasksSection>[0],
  container: HTMLElement,
) {
  const root = createRoot(container);
  await act(async () => root.render(createElement(InboxTasksSection, value)));
  return root;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());

describe("InboxTasksSection", () => {
  it("opens task details from a task row and folds owned sessions into it", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const opened: string[] = [];
    const onEvent = (event: Event) =>
      opened.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_TASK_DETAILS, onEvent);
    const onOpenSession = vi.fn();
    try {
      const root = await render(
        {
          item: item(),
          work: work({
            tasks: [
              {
                id: "t1",
                name: "Deliver the thing",
                sessions: 1,
                status: ["1 needs input"],
                delivery: { ...emptyDelivery, prs: 1 },
              },
            ],
            sessions: [
              session({
                sessionId: "s-task",
                taskId: "t1",
                coveredByTask: true,
              }),
              session({ sessionId: "s-loose", title: "Loose chat" }),
            ],
          }),
          onOpenSession,
        },
        host,
      );
      try {
        const row = (text: string) =>
          [...host.querySelectorAll("button")].find((button) =>
            button.textContent?.includes(text),
          )!;
        // The task's own session does not get a second conversation row.
        expect(host.textContent).toContain("Deliver the thing");
        expect(host.textContent).toContain("1 needs input");
        expect(host.textContent).toContain("Loose chat");
        expect(host.textContent).not.toContain("Claude · work");
        await act(async () => row("Deliver the thing").click());
        expect(opened).toEqual(["t1"]);
        await act(async () => row("Loose chat").click());
        expect(onOpenSession).toHaveBeenCalledWith("s-loose");
      } finally {
        await act(async () => root.unmount());
      }
    } finally {
      window.removeEventListener(OPEN_TASK_DETAILS, onEvent);
      host.remove();
    }
  });

  it("hosts one delivery cluster per checkout on the viewed conversation", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    saveAzurePrAssociation(
      {
        target: {
          site: "https://dev.azure.com/team",
          accountId: "ada",
          project: "Product",
          repository: "repo",
          number: 7,
        },
        account: "Ada",
        cwd: "/work/repo",
        branch: "feature",
        revision: "a:b",
        projectName: "Product",
        repositoryName: "repo",
        pr: {
          pullRequestId: 7,
          title: "PR 7",
          status: "active",
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          reviewers: [],
        },
      },
      "/work/repo",
      "feature",
    );
    const onOpenDelivery = vi.fn(async () => {});
    const host = document.createElement("div");
    document.body.append(host);
    try {
      const root = await render(
        {
          item: item({ provider: "azure", kind: "azure", repo: "" }),
          viewingSessionId: "s-b",
          work: work({
            sessions: [
              session({
                sessionId: "s-a",
                title: "First",
                cwd: "/work/repo",
                branch: "feature",
              }),
              session({
                sessionId: "s-b",
                title: "Second",
                cwd: "/work/repo",
                branch: "feature",
              }),
              session({
                sessionId: "s-c",
                title: "Other copy",
                cwd: "/work/other",
                branch: "main",
              }),
            ],
          }),
          onOpenDelivery,
        },
        host,
      );
      try {
        // Two checkouts → two delivery clusters; s-b hosts its copy's.
        const clusters = host.querySelectorAll(
          'button[aria-label^="Delivery actions for"]',
        );
        expect(clusters).toHaveLength(2);
        const hostRow = (title: string) =>
          [...host.querySelectorAll("button")].find(
            (el) => el.title === `Open conversation: ${title}`,
          )!.parentElement!;
        expect(
          hostRow("Second").querySelector('[aria-label^="1 pull request on"]'),
        ).not.toBeNull();
        expect(
          hostRow("First").querySelector('[aria-label^="1 pull request on"]'),
        ).toBeNull();
        await act(async () =>
          hostRow("Second")
            .querySelector<HTMLElement>('[aria-label^="1 pull request on"]')!
            .click(),
        );
        expect(onOpenDelivery).toHaveBeenCalledWith(
          "s-b",
          "pr",
          expect.any(Function),
          "azure",
          undefined,
          undefined,
        );
      } finally {
        await act(async () => root.unmount());
      }
    } finally {
      host.remove();
    }
  });

  it("routes attention rows to their action", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onOpenAttention = vi.fn();
    try {
      const root = await render(
        {
          item: item(),
          work: work({
            attention: [
              {
                key: "a1",
                kind: "approval",
                title: "Approve a command",
                urgency: 0,
                at: 1,
                signature: "sig",
                action: { kind: "open-session", sessionId: "s1" },
              },
            ],
          }),
          onOpenAttention,
        },
        host,
      );
      try {
        await act(async () =>
          [...host.querySelectorAll("button")]
            .find((button) => button.textContent?.includes("Approve a command"))!
            .click(),
        );
        expect(onOpenAttention).toHaveBeenCalledWith(
          expect.objectContaining({ key: "a1" }),
        );
      } finally {
        await act(async () => root.unmount());
      }
    } finally {
      host.remove();
    }
  });

  it("keeps a task-owned conversation row when the task doesn't cover its checkout", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onOpenSession = vi.fn();
    try {
      const root = await render(
        {
          item: item(),
          work: work({
            tasks: [
              {
                id: "t1",
                name: "Deliver the thing",
                sessions: 1,
                status: [],
                delivery: emptyDelivery,
              },
            ],
            sessions: [
              session({
                sessionId: "s-task",
                taskId: "t1",
                title: "Launch chat",
                cwd: "/main",
              }),
            ],
          }),
          onOpenSession,
        },
        host,
      );
      try {
        const row = [...host.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Launch chat"),
        )!;
        await act(async () => row.click());
        expect(onOpenSession).toHaveBeenCalledWith("s-task");
      } finally {
        await act(async () => root.unmount());
      }
    } finally {
      host.remove();
    }
  });

  it("lists joined delivery that no rendered row hosts", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onOpenDelivery = vi.fn(async () => {});
    try {
      const root = await render(
        {
          item: item({ provider: "azure", kind: "azure" }),
          work: work({
            prs: [
              {
                key: "azure:1",
                provider: "azure",
                repo: "Proj/Repo",
                number: 7,
                title: "Azure PR",
                url: "https://dev.azure.com/org/Proj/_git/Repo/pullrequest/7",
                needsAttention: false,
                sessionId: "s-capped",
                cwd: "/wt",
                branch: "feat",
              },
            ],
          }),
          onOpenDelivery,
        },
        host,
      );
      try {
        const row = [...host.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Azure PR"),
        )!;
        await act(async () => row.click());
        expect(onOpenDelivery).toHaveBeenCalledWith(
          "s-capped",
          "pr",
          expect.any(Function),
          "azure",
          "https://dev.azure.com/org/Proj/_git/Repo/pullrequest/7",
          undefined,
        );
      } finally {
        await act(async () => root.unmount());
      }
    } finally {
      host.remove();
    }
  });
});
