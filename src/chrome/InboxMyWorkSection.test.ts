// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../lib/attention";
import type { InboxMyWork } from "../lib/inboxMyWork";
import { MyWorkBadges, myWorkBadges } from "./InboxMyWorkSection";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const work = (over: Partial<InboxMyWork>): InboxMyWork => ({
  hasWork: true,
  tasks: [],
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

describe("MyWorkBadges", () => {
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
