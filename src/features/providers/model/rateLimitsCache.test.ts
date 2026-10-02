import { afterEach, expect, it, vi } from "vitest";
vi.mock("./rateLimitsFetch", () => ({ fetchClaudeRateLimits: vi.fn(), fetchCodexRateLimits: vi.fn(), fetchOpencodeGoRateLimits: vi.fn(), fetchAdditionalRateLimits: vi.fn() }));
import { clearCachedRateLimits, getCachedRateLimits, setCachedRateLimits } from "./rateLimitsCache";
import { idleRateLimits } from "./rateLimits";
afterEach(() => clearCachedRateLimits());
it("clears a removed account's cached usage", () => {
  const cached = { ...idleRateLimits("codex"), error: "cached" };
  setCachedRateLimits("codex", "work", cached);
  expect(getCachedRateLimits("codex", "work")).toBe(cached);
  clearCachedRateLimits("codex", "work");
  expect(getCachedRateLimits("codex", "work")).not.toBe(cached);
});
it("keeps Muse's session quota snapshots separate", () => {
  const first = { ...idleRateLimits("muse"), error: "first" };
  const second = { ...idleRateLimits("muse"), error: "second" };
  setCachedRateLimits("muse", "default", first, "first");
  setCachedRateLimits("muse", "default", second, "second");
  expect(getCachedRateLimits("muse", "default", "first")).toBe(first);
  expect(getCachedRateLimits("muse", "default", "second")).toBe(second);
});
