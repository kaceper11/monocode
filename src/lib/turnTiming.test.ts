import { afterEach, expect, it, vi } from "vitest";
import {
  beginTurnTiming,
  endTurnTiming,
  markFirstTurnEvent,
  markTurnContentApplied,
  markTurnRendered,
} from "./turnTiming";
afterEach(() => vi.restoreAllMocks());

it("times actual content and its DOM commit, excluding handshake/status events", () => {
  const log = vi.spyOn(console, "debug").mockImplementation(() => {});
  const clock = beginTurnTiming("s", "muse", "submission-1");
  markFirstTurnEvent("s", { type: "session.started" });
  markFirstTurnEvent("s", { type: "status", text: "Starting" });
  expect(log).not.toHaveBeenCalled();
  markTurnRendered("s");
  markFirstTurnEvent("s", { type: "message.delta", text: "answer" });
  markTurnRendered("s");
  expect(log.mock.calls.flat().join(" ")).not.toContain(
    "first content rendered",
  );
  markTurnContentApplied("s");
  markTurnRendered("s");
  markTurnRendered("s");
  expect(
    log.mock.calls.filter(([line]) => line.includes("first content rendered")),
  ).toHaveLength(1);
  expect(log.mock.calls.flat().join(" ")).toContain("submission-1");
  endTurnTiming("s", "done", clock);
});

it("a replaced turn cannot delete the next submission's clock", () => {
  const log = vi.spyOn(console, "debug").mockImplementation(() => {});
  const first = beginTurnTiming("s", "muse", "first");
  const next = beginTurnTiming("s", "muse", "next");
  endTurnTiming("s", "done", first);
  markFirstTurnEvent("s", { type: "tool.started", callId: "t", title: "Read" });
  expect(log.mock.calls[0][0]).toContain("next");
  endTurnTiming("s", "done", next);
});
