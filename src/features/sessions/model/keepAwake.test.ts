import { describe, expect, it } from "vitest";
import { keepAwakeSessionIds } from "./keepAwake";
import { newSession, type Session } from "./session";

function chat(patch: Partial<Session> = {}): Session {
  const session = newSession("cursor", "/tmp/a");
  session.blocks = [{ id: "u1", role: "user", text: "hello" }];
  return { ...session, ...patch, blocks: patch.blocks ?? session.blocks };
}

describe("keepAwakeSessionIds", () => {
  it("keeps sessions executing a turn, sorted and deduplicated", () => {
    const b = chat({ busy: true });
    const a = chat({ busy: true });
    const idle = chat({});
    const ids = keepAwakeSessionIds([b, idle, a, b]);
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("drops sessions waiting for approval even while busy", () => {
    const waiting = chat({
      busy: true,
      blocks: [
        { id: "u1", role: "user", text: "hello" },
        {
          id: "a1",
          role: "approval",
          text: "run rm",
          approval: { requestId: 1 },
        },
      ],
    });
    expect(keepAwakeSessionIds([waiting])).toEqual([]);
  });

  it("drops sessions parked on a question", () => {
    const waiting = chat({
      busy: true,
      pendingQuestion: {
        requestId: 1,
        title: "Pick one",
        questions: [
          {
            id: "q1",
            prompt: "Which?",
            multiSelect: false,
            allowCustom: true,
            options: [],
          },
        ],
      },
    });
    expect(keepAwakeSessionIds([waiting])).toEqual([]);
  });

  it("ignores queued-only, finished and idle sessions", () => {
    const queued = chat({
      queuedMessages: [{ id: "q1", text: "next", attachments: [] }],
    });
    const finished = chat({ busy: false });
    const removed = chat({ busy: true, worktreeRemoved: true });
    expect(keepAwakeSessionIds([queued, finished, removed])).toEqual([]);
  });
});
