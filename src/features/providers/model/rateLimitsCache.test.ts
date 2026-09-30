import { afterEach, expect, it, vi } from "vitest";
vi.mock("./rateLimitsFetch", () => ({ fetchClaudeRateLimits: vi.fn(), fetchCodexRateLimits: vi.fn(), fetchOpencodeGoRateLimits: vi.fn(), fetchAdditionalRateLimits: vi.fn() }));
import { clearCachedRateLimits, getCachedRateLimits, setCachedRateLimits } from "./rateLimitsCache";
import { idleRateLimits } from "./rateLimits";
afterEach(() => clearCachedRateLimits());
it("keeps native and WSL account usage separate and clears every host on account removal", () => {
  const guest = "//wsl.localhost/Ubuntu/work";
  const native = { ...idleRateLimits("codex"), error: "native" };
  const wsl = { ...idleRateLimits("codex"), error: "guest" };
  setCachedRateLimits("codex", "work", native);
  setCachedRateLimits("codex", "work", wsl, guest);
  expect(getCachedRateLimits("codex", "work")).toBe(native);
  expect(getCachedRateLimits("codex", "work", "//wsl.localhost/ubuntu/other")).toBe(wsl);
  expect(getCachedRateLimits("codex", "work", "//wsl.localhost/Debian/work")).not.toBe(wsl);
  clearCachedRateLimits("codex", "work");
  expect(getCachedRateLimits("codex", "work")).not.toBe(native);
  expect(getCachedRateLimits("codex", "work", guest)).not.toBe(wsl);
});
it("keeps Muse's session quota snapshots separate", () => {
  const first = { ...idleRateLimits("muse"), error: "first" };
  const second = { ...idleRateLimits("muse"), error: "second" };
  setCachedRateLimits("muse", "default", first, "/work", "first");
  setCachedRateLimits("muse", "default", second, "/work", "second");
  expect(getCachedRateLimits("muse", "default", "/work", "first")).toBe(first);
  expect(getCachedRateLimits("muse", "default", "/work", "second")).toBe(second);
});
