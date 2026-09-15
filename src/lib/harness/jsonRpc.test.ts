import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  onWrite: async (
    _sessionId: string,
    _line: string,
    _signal?: AbortSignal,
  ): Promise<void> => {},
}));

vi.mock("./child", () => ({
  writeChild: (sessionId: string, line: string, signal?: AbortSignal) =>
    transport.onWrite(sessionId, line, signal),
}));

import { JsonRpcClient } from "./jsonRpc";

describe("JsonRpcClient", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    transport.onWrite = async () => {};
  });

  it("accepts a response delivered before the write resolves", async () => {
    let client!: JsonRpcClient;
    transport.onWrite = async (_sessionId, line) => {
      const outbound = JSON.parse(line) as { id: number };
      client.pushLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: outbound.id,
          result: { ok: true },
        }),
      );
    };
    client = new JsonRpcClient("fast", {});

    await expect(client.request("session/set_mode")).resolves.toEqual({
      ok: true,
    });
  });

  it("retains a fast error while the native write is still pending", async () => {
    let release!: () => void;
    let client!: JsonRpcClient;
    let writeSignal: AbortSignal | undefined;
    transport.onWrite = async (_id, line, signal) => {
      writeSignal = signal;
      client.pushLine(
        JSON.stringify({
          id: JSON.parse(line).id,
          error: { code: -1, message: "rejected" },
        }),
      );
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    client = new JsonRpcClient("fast-error", {});
    const request = client.request("turn/start");
    const rejection = expect(request).rejects.toThrow("rejected");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeSignal?.aborted).toBe(false);
    release();
    await rejection;
  });

  it("rejects and removes a request when writing fails", async () => {
    transport.onWrite = async () => {
      throw new Error("pipe closed");
    };
    const client = new JsonRpcClient("failed", {});

    await expect(client.request("initialize")).rejects.toThrow("pipe closed");
  });
  it("settles timeout even when the native write never resolves", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    transport.onWrite = (_id, _line, pendingSignal) => {
      signal = pendingSignal;
      return new Promise(() => {});
    };
    const client = new JsonRpcClient("blocked", {});
    const result = expect(
      client.request("initialize", {}, 100),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(101);
    await result;
    expect(signal?.aborted).toBe(true);
  });

  it("settles cancellation while the native write is blocked", async () => {
    transport.onWrite = () => new Promise(() => {});
    const client = new JsonRpcClient("cancelled", {});
    const result = expect(client.request("initialize")).rejects.toThrow(
      "cancelled",
    );
    client.rejectPending();
    await result;
  });
  it("ignores late events and requests after the client is closed", () => {
    const onNotification = vi.fn(),
      onRequest = vi.fn();
    const client = new JsonRpcClient("closed", { onNotification, onRequest });
    client.close();
    client.pushLine(JSON.stringify({ method: "turn/completed" }));
    client.pushLine(JSON.stringify({ id: 1, method: "approval/request" }));
    expect(onNotification).not.toHaveBeenCalled();
    expect(onRequest).not.toHaveBeenCalled();
  });
});
