import { describe, expect, it } from "vitest";
import { setWslStatus, subscribeWslStatus, wslStatusFor } from "./wslStatus";

describe("wslStatus", () => {
  it("defaults to unknown for a distribution never seen", () => {
    expect(wslStatusFor("NeverSeen")).toEqual({ state: "unknown" });
  });

  it("tracks per-distribution transitions and errors", () => {
    setWslStatus("Ubuntu", { state: "connecting" });
    setWslStatus("Debian", { state: "connected" });
    expect(wslStatusFor("Ubuntu").state).toBe("connecting");
    expect(wslStatusFor("Debian").state).toBe("connected");

    setWslStatus("Ubuntu", { state: "error", error: "wsl exited 1" });
    expect(wslStatusFor("Ubuntu")).toEqual({
      state: "error",
      error: "wsl exited 1",
    });

    setWslStatus("Ubuntu", { state: "disconnected" });
    expect(wslStatusFor("Ubuntu").state).toBe("disconnected");
    // Debian is untouched — status is per-distribution.
    expect(wslStatusFor("Debian").state).toBe("connected");
  });

  it("keys status by distribution name case-insensitively", () => {
    setWslStatus("Ubuntu", { state: "connected" });
    expect(wslStatusFor("ubuntu").state).toBe("connected");
    expect(wslStatusFor("UBUNTU").state).toBe("connected");
  });

  it("ignores repeat writes with identical state and error", () => {
    let ticks = 0;
    const stop = subscribeWslStatus(() => {
      ticks += 1;
    });
    setWslStatus("Same", { state: "connecting" });
    setWslStatus("Same", { state: "connecting" });
    setWslStatus("Same", { state: "connected" });
    stop();
    expect(ticks).toBe(2);
    // No new listeners — further writes stay silent for this subscriber.
    setWslStatus("Same", { state: "disconnected" });
    expect(ticks).toBe(2);
  });
});
