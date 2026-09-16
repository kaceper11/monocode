// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../lib/attention";
import type {
  InboxMyWork,
  InboxMyWorkCi,
  InboxMyWorkPr,
} from "../lib/inboxMyWork";
import {
  InboxMyWorkSection,
  MyWorkBadges,
  myWorkBadges,
  myWorkSummary,
} from "./InboxMyWorkSection";

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

const ghPr = (over: Partial<InboxMyWorkPr>): InboxMyWorkPr => ({
  key: "p1",
  provider: "github",
  repo: "a/b",
  number: 5,
  title: "PR",
  url: "https://github.com/a/b/pull/5",
  needsAttention: false,
  ...over,
});

const azCi = (over: Partial<InboxMyWorkCi>): InboxMyWorkCi => ({
  key: "c1",
  provider: "azure",
  name: "CI",
  projectName: "P",
  state: "Succeeded",
  failing: false,
  running: false,
  cwd: "/w",
  branch: "b",
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

describe("myWorkSummary", () => {
  it("counts groups and surfaces the states worth attention", () => {
    const parts = myWorkSummary(
      work({
        sessions: [
          {
            sessionId: "s1",
            title: "t",
            harness: "claude",
            cwd: "/r",
            state: "waiting",
          },
        ],
        prs: [
          ghPr({ key: "a", needsAttention: true }),
          ghPr({ key: "b", state: "MERGED" }),
          ghPr({
            key: "c",
            checksFailing: true,
            ci: { count: 1, failing: true, running: false, label: "CI failing" },
          }),
        ],
        ci: [
          azCi({ key: "1", failing: true, state: "Failed" }),
          azCi({ key: "2" }),
          azCi({ key: "3", running: true, state: "In progress" }),
        ],
        attention: [attention({})],
      }),
    );
    expect(parts.map((part) => part.text)).toEqual([
      "1 session",
      "3 PRs",
      "1 needs changes",
      "1 open",
      "1 checks failing",
      "3 CI",
      "1 failing",
      "1 waiting on you",
    ]);
    expect(parts[2].tone).toBe("amber");
    expect(parts[4].tone).toBe("rose");
    expect(parts[6].tone).toBe("rose");
  });

  it("collapses a uniform PR set into one muted part", () => {
    const parts = myWorkSummary(
      work({
        prs: [ghPr({ key: "a", state: "completed" }), ghPr({ key: "b", state: "MERGED" })],
      }),
    );
    expect(parts).toEqual([{ text: "2 merged PRs", tone: "muted" }]);
  });

  it("caps qualifiers so many-state lists stay one line", () => {
    const parts = myWorkSummary(
      work({
        prs: [
          ghPr({ key: "a", needsAttention: true }),
          ghPr({ key: "b", draft: true }),
          ghPr({ key: "c", state: "MERGED" }),
          ghPr({ key: "d", state: "CLOSED" }),
        ],
      }),
    );
    expect(parts.map((part) => part.text)).toEqual([
      "4 PRs",
      "1 needs changes",
      "1 merged",
    ]);
  });
});

describe("InboxMyWorkSection", () => {
  it("caps long groups behind a Show all row and sorts actionable first", async () => {
    const prs = [
      ghPr({ key: "p0", title: "PR old", state: "MERGED" }),
      ...Array.from({ length: 5 }, (_, i) =>
        ghPr({ key: `p${i + 1}`, title: `PR ${i + 1}` }),
      ),
      ghPr({ key: "hot", title: "PR hot", needsAttention: true }),
    ];
    const host = document.createElement("div");
    const root = createRoot(host);
    document.body.append(host);
    const rowButtons = () =>
      [...host.querySelectorAll("button")].filter((button) =>
        button.textContent?.includes("PR"),
      );
    try {
      await act(async () =>
        root.render(
          createElement(InboxMyWorkSection, {
            work: work({ prs }),
            onOpenSession: vi.fn(),
            onOpenDelivery: vi.fn(async () => {}),
            onOpenAttention: vi.fn(),
          }),
        ),
      );
      // Four rows shown; the attention PR floats to the top despite arriving last.
      expect(rowButtons()).toHaveLength(4);
      expect(rowButtons()[0].textContent).toContain("PR hot");
      expect(host.textContent).not.toContain("PR old");
      expect(host.textContent).toContain("Show all 7…");
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "Show all 7…")!
          .click(),
      );
      expect(rowButtons()).toHaveLength(7);
      expect(host.textContent).toContain("Show less");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

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
