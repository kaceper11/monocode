import { expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("retains upstream native installation hints when a resolver fails", async () => {
  vi.resetModules();
  invoke.mockReset().mockRejectedValue(new Error("resolver detail"));
  const { registerBuiltinHarnesses } = await import("./register");
  registerBuiltinHarnesses();
  const { probeHarnessAvailability, harnessUnavailableHint } = await import("./availability");
  await probeHarnessAvailability();
  expect(harnessUnavailableHint("claude")).toBe("Claude Code CLI not found. Install it, or restart MonoCode if it is already installed.");
  expect(harnessUnavailableHint("hermes")).toContain("Install from hermes-agent.nousresearch.com, then run hermes model");
});
