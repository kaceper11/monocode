// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../lib/attention";
import type { InboxMyWork } from "../lib/inboxMyWork";
import { InboxMyWorkSection, MyWorkBadges, myWorkBadges } from "./InboxMyWorkSection";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const work = (over: Partial<InboxMyWork>): InboxMyWork => ({
  hasWork: true,
  sessions: [],
  prs: [],
  ci: [],
  attention: [],
  ...over,
});

const attention = (over: Partial<AttentionItem>): AttentionItem => ({
  key: "a1",
  kind: "approval",
  title: "Approve a command",
  urgency: 0,
  at: 1,
  signature: "sig",
  ...over,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());

describe("myWorkBadges", () => {
  it("stays calm when there is no work", () => {
    expect(myWorkBadges(undefined)).toBeNull();
    expect(myWorkBadges(work({ hasWork: false }))).toBeNull();
  });

  it("prefers waiting over working and folds PR, CI and attention into the aria text", () => {
    const badges = myWorkBadges(
      work({
        sessions: [
          { sessionId: "s1", title: "t", harness: "claude", cwd: "/r", state: "working" },
          { sessionId: "s2", title: "t", harness: "claude", cwd: "/r", state: "waiting" },
        ],
        prs: [
          {
            key: "k",
            provider: "github",
            repo: "a/b",
            number: 5,
            title: "PR",
            url: "https://github.com/a/b/pull/5",
            needsAttention: false,
            ci: { count: 1, failing: true, running: false, label: "CI failing" },
          },
        ],
        attention: [attention({})],
      }),
    )!;
    expect(badges.sessionState).toBe("waiting");
    expect(badges.prs).toBe(1);
    expect(badges.ciFailing).toBe(true);
    expect(badges.attention).toBe(1);
    expect(badges.aria).toBe(
      "1 session waiting on you, 1 working, 1 pull request, CI failing, 1 waiting on you",
    );
  });
});

describe("InboxMyWorkSection", () => {
  it("opens each row's owning context", async () => {
    const onOpenSession = vi.fn();
    const onOpenDelivery = vi.fn(async () => {});
    const onOpenAttention = vi.fn();
    const snapshot = work({
      sessions: [
        { sessionId: "s1", title: "Claude · fix", harness: "claude", cwd: "/repo", state: "waiting" },
      ],
      prs: [
        {
          key: "azure:t",
          provider: "azure",
          repo: "Proj/Repo",
          number: 7,
          title: "Azure PR",
          url: "https://dev.azure.com/org/Proj/_git/Repo/pullrequest/7",
          state: "Active",
          needsAttention: false,
          sessionId: "s-task",
          cwd: "/wt",
          ci: { count: 1, failing: true, running: false, label: "CI failing" },
        },
      ],
      ci: [
        {
          key: "ci:1",
          provider: "azure",
          name: "CI",
          projectName: "Proj",
          state: "Failed",
          failing: true,
          running: false,
          sessionId: "s-task",
          cwd: "/wt",
          branch: "feat",
        },
      ],
      attention: [attention({ action: { kind: "open-session", sessionId: "s1" } })],
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    document.body.append(host);
    try {
      await act(async () =>
        root.render(
          createElement(InboxMyWorkSection, {
            work: snapshot,
            onOpenSession,
            onOpenDelivery,
            onOpenAttention,
          }),
        ),
      );
      expect(host.textContent).toContain("My work");
      expect(host.textContent).toContain("Azure PR");
      const buttons = [...host.querySelectorAll("button")];
      const row = (text: string) =>
        buttons.find((button) => button.textContent?.includes(text))!;
      await act(async () => row("Claude · fix").click());
      expect(onOpenSession).toHaveBeenCalledWith("s1");
      await act(async () => row("Azure PR").click());
      expect(onOpenDelivery).toHaveBeenCalledWith(
        "s-task",
        "pr",
        expect.any(Function),
        "azure",
        "https://dev.azure.com/org/Proj/_git/Repo/pullrequest/7",
      );
      await act(async () => row("Failed").click());
      expect(onOpenDelivery).toHaveBeenCalledWith(
        "s-task",
        "ci",
        expect.any(Function),
        "azure",
        undefined,
      );
      await act(async () => row("Approve a command").click());
      expect(onOpenAttention).toHaveBeenCalledWith(
        expect.objectContaining({ key: "a1" }),
      );
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("renders badges only for linked work", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    document.body.append(host);
    try {
      await act(async () =>
        root.render(createElement(MyWorkBadges, { work: undefined })),
      );
      expect(host.textContent).toBe("");
      await act(async () =>
        root.render(
          createElement(MyWorkBadges, {
            work: work({
              prs: [
                {
                  key: "k",
                  provider: "github",
                  repo: "a/b",
                  number: 5,
                  title: "PR",
                  url: "https://github.com/a/b/pull/5",
                  needsAttention: false,
                },
              ],
              attention: [attention({})],
            }),
          }),
        ),
      );
      expect(host.textContent).toContain("1");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
