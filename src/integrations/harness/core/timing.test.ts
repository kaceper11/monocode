import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  startHarnessTiming,
  markHarnessTiming,
  finishHarnessTiming,
  measureHarnessTiming,
  bindHarnessTiming,
  currentHarnessTiming,
  clearHarnessTimings,
  observeHarnessTiming,
  queueHarnessTimingCommit,
  commitHarnessTiming,
  timingWriteKind,
  type HarnessTiming,
} from "./timing";

function read(): HarnessTiming[] {
  return (
    globalThis as unknown as {
      monocodeHarnessTiming: { read(): HarnessTiming[] };
    }
  ).monocodeHarnessTiming.read();
}

beforeEach(() => {
  clearHarnessTimings();
  vi.stubGlobal("localStorage", { getItem: () => "true" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearHarnessTimings();
});

it("is opt-in and stores only bounded diagnostic metadata", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  expect(startHarnessTiming({ harness: "codex" })).toBeUndefined();
  vi.stubGlobal("localStorage", { getItem: () => "true" });
  for (let i = 0; i < 110; i++)
    startHarnessTiming({
      harness: "codex",
      modelSettings: { effort: "high", apiKey: "secret" },
    });
  expect(read()).toHaveLength(100);
  expect(read()[0].settings).toEqual({ effort: "high" });
  expect(JSON.stringify(read())).not.toContain("secret");
  const copy = read();
  copy[0].settings.effort = "low";
  expect(read()[0].settings.effort).toBe("high");
});

it("separates first text, state application, visible commit and completion", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const timing = startHarnessTiming({ harness: "muse" })!;
  now = 20;
  observeHarnessTiming("s", timing, {
    type: "reasoning.delta",
    text: "private reasoning",
  });
  now = 100;
  observeHarnessTiming("s", timing, {
    type: "message.delta",
    text: "private response",
  });
  now = 120;
  observeHarnessTiming("s", timing, { type: "message.delta", text: "more" });
  commitHarnessTiming("s");
  expect(timing.marks.firstTextCommitted).toBeUndefined();
  queueHarnessTimingCommit("s", [{ type: "message.delta", text: "HI" }]);
  finishHarnessTiming(timing, "completed");
  now = 125;
  commitHarnessTiming("other");
  commitHarnessTiming("s");
  expect(timing.marks).toMatchObject({
    firstReasoning: 20,
    firstText: 100,
    firstTextApplied: 120,
    firstTextCommitted: 125,
    settled: 120,
  });
  expect(JSON.stringify(read())).not.toContain("private");
});

it("does not let late cleanup remove a newer turn and preserves errors", async () => {
  const first = startHarnessTiming({ harness: "claude" })!;
  const unbind = bindHarnessTiming("s", first);
  const next = startHarnessTiming({ harness: "claude" })!;
  bindHarnessTiming("s", next);
  unbind();
  expect(currentHarnessTiming("s")).toBe(next);
  await expect(
    measureHarnessTiming(first, "spawn", async () => {
      throw new Error("secret error");
    }),
  ).rejects.toThrow("secret error");
  expect(first.spans[0]).toMatchObject({ name: "spawn", failed: true });
  markHarnessTiming(first, "cancelRequested");
  finishHarnessTiming(first, "completed");
  expect(first.outcome).toBe("cancelled");
  expect(JSON.stringify(read())).not.toContain("secret");
});

it("observes promises without changing identity or RPC settlement ordering", async () => {
  const pending = Promise.resolve("ack");
  const timing = startHarnessTiming({ harness: "codex" });
  expect(measureHarnessTiming(undefined, "rpc", () => pending)).toBe(pending);
  expect(measureHarnessTiming(timing, "rpc", () => pending)).toBe(pending);
  await pending;
  expect(timing?.spans).toHaveLength(1);
});

it("caps long-running traces and classifies all six providers without saving payloads", async () => {
  const timing = startHarnessTiming({ harness: "omp" })!;
  for (let i = 0; i < 140; i++)
    await measureHarnessTiming(timing, "write", async () => undefined);
  expect(timing.spans).toHaveLength(128);
  for (const method of ["turn/start", "session/prompt"])
    expect(
      timingWriteKind(JSON.stringify({ method, params: { text: "secret" } })),
    ).toBe("prompt");
  for (const type of ["prompt", "user"])
    expect(timingWriteKind(JSON.stringify({ type, message: "secret" }))).toBe(
      "prompt",
    );
  expect(
    timingWriteKind(
      '{"type":"control_request","request":{"subtype":"interrupt"}}',
    ),
  ).toBe("cancel");
  expect(timingWriteKind('{"method":"turn/steer"}')).toBe("steer");
  expect(timingWriteKind("unparseable")).toBe("control");
});

it("classifies large prompt headers without scanning their contents", () => {
  expect(
    timingWriteKind(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "turn/start",
        params: { input: "x".repeat(1_000_000) },
      }),
    ),
  ).toBe("prompt");
  expect(
    timingWriteKind(
      JSON.stringify({
        type: "control_response",
        response: { method: "turn/start" },
      }),
    ),
  ).toBe("control");
});
