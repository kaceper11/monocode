import { afterEach, expect, it, vi } from "vitest";
import { AcpClient } from "./acp";
const { write } = vi.hoisted(() => ({ write: vi.fn(async (_session: string, _line: string) => undefined) }));
vi.mock("./child", () => ({ writeChild: write }));
afterEach(() => { vi.useRealTimers(); write.mockClear(); });

it("keeps upstream request lifetimes unless the adapter supplies a timeout", async () => {
  vi.useFakeTimers();
  const client = new AcpClient("upstream-lifetime", {});
  const settled = vi.fn();
  const pending = ["session/prompt", "session/custom"].map((method) =>
    client.request(method).then(settled, settled));
  try {
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(settled).not.toHaveBeenCalled();
    const bounded = client.request("session/custom", {}, 20);
    const rejected = expect(bounded).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
  } finally {
    client.close();
    await Promise.all(pending);
  }
});

it("echoes opaque provider request ids without numeric coercion", async () => {
  const client = new AcpClient("opaque-request", {
    onRequest: async (id) => client.respond(id, { ok: true }),
  });
  client.pushLine(JSON.stringify({ jsonrpc: "2.0", id: "approval:abc", method: "session/request_permission" }));
  await Promise.resolve();
  expect(JSON.parse(write.mock.calls[0][1])).toMatchObject({ id: "approval:abc", result: { ok: true } });
  client.close();
});
