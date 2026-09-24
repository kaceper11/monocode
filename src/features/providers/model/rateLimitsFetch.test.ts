import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  home: vi.fn(async () => "/native/home"),
  resolve: vi.fn(async () => ({ path: "/cli" })),
  spawn: vi.fn(async () => 1),
  kill: vi.fn(async () => undefined),
  lines: new Map<string, (line: string) => void>(),
  requests: [] as Array<{ id: string; method: string; params: unknown }>,
  liveMuse: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../../platform/tauri/fs", () => ({ homeDir: mocks.home }));
vi.mock("../../../integrations/harness/providers/muse/muse", () => ({
  readLiveMuseUsage: mocks.liveMuse,
}));
vi.mock("../../../integrations/harness/core/child", () => ({
  resolveCodexBinary: mocks.resolve,
  resolveCopilotBinary: mocks.resolve,
  resolveMuseBinary: mocks.resolve,
  spawnChild: mocks.spawn,
  killChild: mocks.kill,
  watchChild: (id: string, line: (line: string) => void) =>
    mocks.lines.set(id, line),
  unwatchChild: (id: string) => mocks.lines.delete(id),
  writeChild: async (id: string, line: string) => {
    const request = JSON.parse(line);
    mocks.requests.push({ id, method: request.method, params: request.params });
    if (request.id == null) return;
    const result =
      request.method === "account/rateLimitResetCredit/consume"
        ? { outcome: "reset" }
        : request.method === "account/rateLimits/read"
          ? {
              rateLimits: {
                primary: { usedPercent: 31, windowDurationMins: 300 },
              },
            }
          : request.method === "account.getQuota"
            ? {
                quotaSnapshots: {
                  premium_interactions: {
                    entitlementRequests: 300,
                    remainingPercentage: 70,
                  },
                },
              }
            : request.method === "initialize"
              ? { schema: { version: 1 }, serverInfo: { version: "test" } }
              : {};
    mocks.lines.get(id)?.(JSON.stringify({ id: request.id, result }));
  },
}));
import {
  consumeCodexRateLimitResetCredit,
  fetchCodexRateLimits,
  fetchClaudeRateLimits,
  fetchAdditionalRateLimits,
} from "./rateLimitsFetch";

const cwd = "//wsl.localhost/Ubuntu/home/me/worktree";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lines.clear();
  mocks.requests.length = 0;
});

it("reads quota and consumes resets on the selected WSL host with isolated children", async () => {
  const [limits, outcome] = await Promise.all([
    fetchCodexRateLimits("default", cwd),
    consumeCodexRateLimitResetCredit("credit-1", "default", cwd),
  ]);
  expect(limits.session?.usedPercent).toBe(31);
  expect(outcome).toBe("reset");
  expect(mocks.resolve).toHaveBeenCalledWith(cwd);
  expect(mocks.home).not.toHaveBeenCalled();
  expect(mocks.spawn.mock.calls).toHaveLength(2);
  expect(new Set(mocks.spawn.mock.calls.map((call) => call[0])).size).toBe(2);
  for (const call of mocks.spawn.mock.calls)
    expect(call).toEqual([
      expect.any(String),
      "/cli",
      ["app-server"],
      cwd,
      { provider: "codex", id: "default" },
    ]);
  expect(
    mocks.requests.find((r) => r.method.endsWith("/consume"))?.params,
  ).toEqual({ creditId: "credit-1", idempotencyKey: expect.any(String) });
  expect(mocks.lines.size).toBe(0);
});

it("passes the distribution to Claude's credential boundary", async () => {
  mocks.invoke.mockResolvedValue({
    status: "ok",
    body: JSON.stringify({ five_hour: { utilization: 23 } }),
  });
  expect(
    (await fetchClaudeRateLimits("default", cwd)).session?.usedPercent,
  ).toBe(23);
  expect(mocks.invoke).toHaveBeenCalledWith("fetch_claude_usage", {
    accountId: "default",
    cwd,
  });
});

it("reads Copilot account quota over its SDK transport without creating a session", async () => {
  const limits = await fetchAdditionalRateLimits("copilot", cwd);
  expect(limits.monthly?.usedPercent).toBe(30);
  expect(mocks.spawn).toHaveBeenCalledWith(
    expect.any(String),
    "/cli",
    ["--headless", "--no-auto-update", "--stdio"],
    cwd,
    undefined,
  );
  expect(mocks.requests.map((r) => r.method)).toEqual([
    "connect",
    "account.getQuota",
  ]);
});

it("uses Muse's live host observation and leaves unsupported Devin usage explicit", async () => {
  mocks.liveMuse.mockReturnValueOnce(
    Promise.resolve({
      usage: {
        observedAtMs: 1_800_000_000_000,
        window: {
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAtMs: 1_800_010_000_000,
        },
        weekly: { usedPercent: 20, resetsAtMs: 1_800_060_000_000 },
      },
    }),
  );
  expect(
    (await fetchAdditionalRateLimits("muse", cwd, "session-1")).session
      ?.usedPercent,
  ).toBe(12);
  expect(mocks.liveMuse).toHaveBeenCalledWith("session-1", cwd);
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(await fetchAdditionalRateLimits("devin", cwd)).toMatchObject({
    status: "unsupported",
    session: null,
    weekly: null,
    monthly: null,
  });
});

it("keeps WSL connection failures visible instead of reporting a missing native CLI", async () => {
  mocks.resolve.mockRejectedValueOnce(new Error("WSL connection interrupted"));
  expect(await fetchCodexRateLimits("default", cwd)).toMatchObject({
    status: "error",
    error: "WSL connection interrupted",
  });
  expect(mocks.spawn).not.toHaveBeenCalled();
});
