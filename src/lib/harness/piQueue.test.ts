import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
import { killChild, spawnChild, writeChild } from "./child";
import { PiRpc } from "./piClient";

afterEach(() => { vi.useRealTimers(); native.invoke.mockReset(); });

it.each(["cancel", "timeout", "close"])("revokes a Pi request in the real child queue on %s", async (reason) => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const delivered: string[] = [];
  native.invoke.mockImplementation(async (command: string, args: { line?: string }) => {
    if (command === "harness_spawn") return 11;
    if (command === "harness_write") {
      delivered.push(args.line!);
      if (args.line === "blocker") await blocker;
    }
  });
  const id = `pi-queue-${reason}`;
  await spawnChild(id, "pi", [], "/repo");
  const first = writeChild(id, "blocker");
  await Promise.resolve();
  const onFrame = vi.fn();
  const rpc = new PiRpc(id, onFrame);
  const pending = rpc.request({ type: "prompt", id: "queued", message: "must not execute" }, 20);
  const rejected = expect(pending).rejects.toThrow();
  if (reason === "cancel") rpc.cancelRequest("queued");
  else if (reason === "close") rpc.close();
  else await vi.advanceTimersByTimeAsync(20);
  await rejected;
  release();
  await first;
  await vi.advanceTimersByTimeAsync(0);
  expect(delivered).toEqual(["blocker"]);
  rpc.close();
  rpc.pushLine(JSON.stringify({ type: "agent_end" }));
  expect(onFrame).not.toHaveBeenCalled();
  await killChild(id);
});
