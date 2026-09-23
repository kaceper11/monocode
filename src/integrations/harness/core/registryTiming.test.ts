import { afterEach, expect, it, vi } from "vitest";
import type { HarnessId } from "../../../features/sessions/model/session";
import {
  registerHarness,
  resetHarnessIdlePark,
  sendHarnessTurn,
} from "./registry";
import {
  clearHarnessTimings,
  currentHarnessTiming,
  startHarnessTiming,
} from "./timing";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async () => undefined),
}));

afterEach(() => {
  clearHarnessTimings();
  resetHarnessIdlePark();
  vi.unstubAllGlobals();
});

it.each<HarnessId>(["codex", "claude", "devin", "copilot", "omp", "muse"])(
  "traces %s without buffering streamed events or changing selected settings",
  async (harness) => {
    vi.stubGlobal("localStorage", { getItem: () => "true" });
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const settings = { effort: "high" };
    const timing = startHarnessTiming({
      harness,
      model: "chosen-model",
      modelSettings: settings,
    })!;
    registerHarness({
      id: harness,
      live: true,
      async sendTurn(input) {
        expect(input.model).toBe("chosen-model");
        expect(input.modelSettings).toBe(settings);
        expect(currentHarnessTiming(input.sessionId)).toBe(timing);
        input.onEvent({ type: "message.delta", text: "HI" });
        await pending;
      },
      async steerTurn() {},
      async cancelTurn() {},
      respondApproval() {},
      async stopSession() {},
      async forgetSession() {},
      bindSession() {},
    });
    const onEvent = vi.fn();
    const turn = sendHarnessTurn({
      harness,
      sessionId: "test",
      cwd: "/repo",
      model: "chosen-model",
      modelSettings: settings,
      runtimeMode: "supervised",
      text: "HI",
      onEvent,
      timing,
    });
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith({
        type: "message.delta",
        text: "HI",
      }),
    );
    expect(timing.marks.firstText).toBeTypeOf("number");
    expect(timing.outcome).toBeUndefined();
    settle();
    await turn;
    expect(timing.outcome).toBe("completed");
    expect(currentHarnessTiming("test")).toBeUndefined();
    expect(timing.spans.some((span) => span.name === "authorize")).toBe(true);
  },
);
