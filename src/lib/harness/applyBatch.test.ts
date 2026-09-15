import { afterEach, describe, expect, it, vi } from "vitest";
import { HARNESSES, newSession, type Block } from "../session";
import { applyHarnessEvent, applyHarnessEvents } from "./apply";
import type { HarnessEvent } from "./types";

afterEach(() => vi.restoreAllMocks());

const events: HarnessEvent[] = [
  { type: "reasoning.delta", text: "" },
  { type: "reasoning.delta", text: "Think" },
  { type: "reasoning.delta", text: "Thinking" },
  { type: "reasoning.delta", text: "" },
  { type: "reasoning.completed" },
  { type: "message.delta", text: "" },
  { type: "message.delta", text: "a" },
  { type: "message.delta", text: "a" },
  { type: "message.delta", text: "aa" },
  { type: "message.delta", text: "aab" },
  { type: "message.delta", text: "\n" },
  { type: "message.delta", text: "\n" },
  { type: "message.delta", text: "aab" },
  { type: "message.delta", text: "# Title\n" },
  { type: "message.delta", text: "| A | B |\n" },
  { type: "tool.started", callId: "read-1", title: "Read file", kind: "read" },
  {
    type: "approval.requested",
    requestId: 1,
    callId: "read-1",
    title: "Read file",
  },
  { type: "approval.resolved", requestId: 1, decision: "deny" },
  { type: "tool.updated", callId: "read-1", status: "cancelled" },
  { type: "question.asked", requestId: 2, questions: [] },
  { type: "question.resolved", requestId: 2, decision: "skipped" },
  { type: "status", text: "Working" },
  { type: "reasoning.delta", text: "more" },
  { type: "status", text: "Working" },
  { type: "message.delta", text: "Done" },
  { type: "message.completed" },
  { type: "message.delta", text: "Done" },
  { type: "message.delta", text: "!" },
  { type: "session.error", message: "Disconnected" },
  { type: "session.ended", code: 1 },
];

describe("batched harness events", () => {
  it("matches sequential reduction at every flush boundary for every harness", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-0000-0000-000000000001",
    );
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const tails: Block[][] = [
      [],
      [{ id: "user", role: "user", text: "help", startedAt: 0 }],
      [{ id: "answer", role: "assistant", text: "prefix", streaming: true }],
      [{ id: "reason", role: "reasoning", text: "Think", streaming: false }],
    ];
    for (const harness of HARNESSES) {
      for (const blocks of tails) {
        for (let batchSize = 1; batchSize <= events.length; batchSize += 1) {
          const initial = {
            ...newSession(harness, "/tmp"),
            blocks,
            busy: true,
          };
          Object.freeze(initial);
          Object.freeze(blocks);
          for (const block of blocks) Object.freeze(block);
          let expected = initial;
          let actual = initial;
          for (let offset = 0; offset < events.length; offset += batchSize) {
            const batch = events.slice(offset, offset + batchSize);
            expected = batch.reduce(applyHarnessEvent, expected);
            actual = applyHarnessEvents(actual, batch);
            expect(actual).toEqual(expected);
          }
        }
      }
    }
  });

  it("retains identity for empty batches and duplicate snapshots", () => {
    const initial = newSession("codex", "/tmp");
    expect(applyHarnessEvents(initial, [])).toBe(initial);
    const streaming = applyHarnessEvent(initial, {
      type: "message.delta",
      text: "hello",
    });
    expect(
      applyHarnessEvents(streaming, [
        { type: "message.delta", text: "hello" },
        { type: "message.delta", text: "hello" },
      ]),
    ).toBe(streaming);
    expect(initial.blocks).toEqual([]);
  });
});
