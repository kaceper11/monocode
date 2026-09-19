import { afterEach, describe, expect, it, vi } from "vitest";
import { resetHarnessModelOverlays, setHarnessModels } from "../models";
import type { HarnessId } from "../session";
import {
  HARNESS_IDLE_PARK_MS,
  canCompactHarnessContext,
  compactHarnessContext,
  isLiveHarness,
  listHarnesses,
  refreshHarnessCatalogs,
  registerHarness,
  resetHarnessIdlePark,
  sendHarnessTurn,
  cancelHarnessTurn,
  steerHarnessTurn,
  type HarnessAdapter,
} from "./registry";
import type { SendTurnInput, SteerTurnInput } from "./types";
import { registerBuiltinHarnesses } from "./register";

function stub(
  id: "cursor" | "codex" | "claude" | "pi",
  extra: Partial<HarnessAdapter> = {},
): HarnessAdapter {
  return {
    id,
    live: true,
    async sendTurn(_input: SendTurnInput) {},
    async steerTurn(_input: SteerTurnInput) {},
    async cancelTurn() {},
    respondApproval() {},
    async stopSession() {},
    async forgetSession() {},
    bindSession() {},
    ...extra,
  };
}

describe("harness registry", () => {
  afterEach(() => {
    resetHarnessModelOverlays();
    resetHarnessIdlePark();
    vi.useRealTimers();
  });

  it("tracks live adapters", () => {
    registerHarness(stub("cursor"));
    registerHarness(stub("codex"));
    registerHarness(stub("claude"));
    expect(isLiveHarness("cursor")).toBe(true);
    expect(isLiveHarness("codex")).toBe(true);
    expect(isLiveHarness("claude")).toBe(true);
    expect(
      listHarnesses()
        .map((a) => a.id)
        .filter((id) => id === "claude" || id === "codex" || id === "cursor")
        .sort(),
    ).toEqual(["claude", "codex", "cursor"]);
  });

  it("advertises and dispatches compaction only when an adapter supports it", async () => {
    const compactContext = vi.fn(async () => undefined);
    registerHarness(stub("codex", { compactContext }));
    registerHarness(stub("claude"));

    expect(canCompactHarnessContext("codex")).toBe(true);
    expect(canCompactHarnessContext("claude")).toBe(false);

    await compactHarnessContext({
      harness: "codex",
      sessionId: "compact-1",
      cwd: "/tmp",
      model: "codex:gpt-5.4",
      runtimeMode: "supervised",
      onEvent: () => undefined,
    });

    expect(compactContext).toHaveBeenCalledOnce();
    await expect(
      compactHarnessContext({
        harness: "claude",
        sessionId: "compact-2",
        cwd: "/tmp",
        model: "claude:sonnet",
        runtimeMode: "supervised",
        onEvent: () => undefined,
      }),
    ).rejects.toThrow("does not support manual compaction");
  });

  it("exposes the native compaction support matrix", () => {
    registerBuiltinHarnesses();
    const ids: HarnessId[] = [
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
      "omp",
      "fx",
    ];

    expect(
      Object.fromEntries(ids.map((id) => [id, canCompactHarnessContext(id)])),
    ).toEqual({
      claude: true,
      codex: true,
      cursor: false,
      grok: true,
      opencode: true,
      pi: true,
      omp: true,
      fx: false,
    });
  });

  it("refreshes only the requested catalogs", async () => {
    const pi = vi.fn(async () => undefined);
    const claude = vi.fn(async () => undefined);
    registerHarness(stub("pi", { refreshCatalog: pi }));
    registerHarness(stub("claude", { refreshCatalog: claude }));

    await refreshHarnessCatalogs(["claude"]);

    expect(claude).toHaveBeenCalledOnce();
    expect(pi).not.toHaveBeenCalled();
  });

  it("does not spawn a catalog probe twice after a live list lands", async () => {
    const pi = vi.fn(async () => {
      setHarnessModels("pi", [
        {
          id: "pi:opus",
          harness: "pi",
          name: "Opus",
          nativeId: "anthropic/opus",
        },
      ]);
    });
    registerHarness(stub("pi", { refreshCatalog: pi }));

    await refreshHarnessCatalogs(["pi"]);
    await refreshHarnessCatalogs(["pi"]);

    expect(pi).toHaveBeenCalledOnce();
  });

  it("skips catalog refresh when no harness is in use", async () => {
    const pi = vi.fn(async () => undefined);
    registerHarness(stub("pi", { refreshCatalog: pi }));
    await refreshHarnessCatalogs([]);
    expect(pi).not.toHaveBeenCalled();
  });

  it("parks a live child a few minutes after the turn settles", async () => {
    vi.useFakeTimers();
    const stopSession = vi.fn(async () => undefined);
    registerHarness(stub("cursor", { stopSession }));

    await sendHarnessTurn({
      harness: "cursor",
      sessionId: "s1",
      cwd: "/tmp",
      model: "cursor:composer-2.5",
      text: "hi",
      runtimeMode: "supervised",
      onEvent: () => undefined,
    });

    expect(stopSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HARNESS_IDLE_PARK_MS - 1);
    expect(stopSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stopSession).toHaveBeenCalledWith("s1");
  });



  it("a park timer armed mid-turn cannot kill the running session", async () => {
    vi.useFakeTimers();
    const stopSession = vi.fn(async () => undefined);
    const cancelTurn = vi.fn(async () => undefined);
    let finishTurn: () => void = () => undefined;
    const sendTurn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTurn = resolve;
        }),
    );
    registerHarness(stub("cursor", { sendTurn, cancelTurn, stopSession }));

    const send = sendHarnessTurn({
      harness: "cursor",
      sessionId: "s4",
      cwd: "/tmp",
      model: "cursor:composer-2.5",
      text: "hi",
      runtimeMode: "supervised",
      onEvent: () => undefined,
    });
    // cancelTurn arms a fresh park timer while the turn is still running.
    await cancelHarnessTurn("cursor", "s4");

    await vi.advanceTimersByTimeAsync(HARNESS_IDLE_PARK_MS * 2);
    expect(stopSession).not.toHaveBeenCalled();

    finishTurn();
    await send;
    await vi.advanceTimersByTimeAsync(HARNESS_IDLE_PARK_MS);
    expect(stopSession).toHaveBeenCalledWith("s4");
  });

  it.each(["compact", "steer"] as const)(
    "does not idle-park during a pending %s operation",
    async (operation) => {
      vi.useFakeTimers();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stopSession = vi.fn(async () => undefined);
      registerHarness(
        stub("codex", {
          compactContext: () => pending,
          steerTurn: () => pending,
          stopSession,
        }),
      );
      const input = {
        harness: "codex" as const,
        sessionId: "busy-operation",
        cwd: "/tmp",
        model: "codex:default",
        runtimeMode: "supervised" as const,
        text: "follow up",
        onEvent: () => undefined,
      };
      const active = operation === "compact"
        ? compactHarnessContext(input)
        : steerHarnessTurn(input);
      // A concurrent send can finish and arm the idle timer first.
      await sendHarnessTurn(input);
      await vi.advanceTimersByTimeAsync(HARNESS_IDLE_PARK_MS * 2);
      expect(stopSession).not.toHaveBeenCalled();
      finish();
      await active;
      await vi.advanceTimersByTimeAsync(HARNESS_IDLE_PARK_MS);
      expect(stopSession).toHaveBeenCalledExactlyOnceWith("busy-operation");
    },
  );

  it("a failed steer still leaves the child on an idle-park timer", async () => {
    vi.useFakeTimers();
    const stopSession = vi.fn(async () => undefined);
    const steerTurn = vi.fn(async () => {
      throw new Error("no active turn");
    });
    registerHarness(stub("cursor", { steerTurn, stopSession }));

    await sendHarnessTurn({
      harness: "cursor",
      sessionId: "s5",
      cwd: "/tmp",
      model: "cursor:composer-2.5",
      text: "hi",
      runtimeMode: "supervised",
      onEvent: () => undefined,
    });
    await expect(
      steerHarnessTurn({
        harness: "cursor",
        sessionId: "s5",
        cwd: "/tmp",
        model: "cursor:composer-2.5",
        text: "steer",
        runtimeMode: "supervised",
      }),
    ).rejects.toThrow("no active turn");

    await vi.advanceTimersByTimeAsync(HARNESS_IDLE_PARK_MS);
    expect(stopSession).toHaveBeenCalledWith("s5");
  });
});
