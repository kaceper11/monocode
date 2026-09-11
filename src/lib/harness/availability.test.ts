import { expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("keeps native and distribution probes separate, coalesces requests and refreshes failures", async () => {
  const { registerBuiltinHarnesses } = await import("./register");
  registerBuiltinHarnesses();
  const {
    probeHarnessAvailability,
    isHarnessAvailable,
    hasProbedHarnessAvailability,
    invalidateHarnessAvailability,
    harnessUnavailableHint,
    harnessAuthHint,
  } = await import("./availability");
  const cwd = "//wsl.localhost/Ubuntu/home/me/Zażółć repo";
  const other = "//wsl.localhost/Debian/home/me/repo";
  invoke.mockImplementation(async (command, args) => {
    if (command === "wsl_resolve_agents") {
      if (args.cwd === cwd)
        return {
          codex: { path: "/usr/bin/codex", authenticated: true },
          pi: { path: "/home/me/.local/bin/pi", authenticated: false },
          opencode: { error: "OpenCode HTTP is not supported in WSL yet" },
        };
      return {};
    }
    if (command === "wsl_resolve_harness") {
      if (args.cwd === cwd && args.provider === "codex")
        return { path: "/usr/bin/codex" };
      throw new Error("CLI unavailable in distribution");
    }
    return { path: "C:/bin/agent.exe" };
  });
  await probeHarnessAvailability();
  expect(isHarnessAvailable("codex")).toBe(true);
  expect(isHarnessAvailable("codex", cwd)).toBe(false);
  expect(hasProbedHarnessAvailability(cwd)).toBe(false);
  const first = probeHarnessAvailability({ cwd });
  expect(probeHarnessAvailability({ cwd })).toBe(first);
  await first;
  // One batched bridged request resolves the whole distribution.
  expect(
    invoke.mock.calls.filter(([command]) => command === "wsl_resolve_agents"),
  ).toHaveLength(1);
  expect(isHarnessAvailable("codex", cwd)).toBe(true);
  expect(isHarnessAvailable("claude", cwd)).toBe(false);
  expect(isHarnessAvailable("pi", cwd)).toBe(true);
  // Auth is reported separately from binary discovery.
  expect(harnessAuthHint("codex", cwd)).toBeUndefined();
  expect(harnessAuthHint("pi", cwd)).toContain("not signed in");
  expect(harnessAuthHint("pi", cwd)).toContain("Ubuntu");
  expect(harnessAuthHint("grok", cwd)).toBeUndefined();
  expect(isHarnessAvailable("codex", other)).toBe(false);
  const count = invoke.mock.calls.length;
  await probeHarnessAvailability({ cwd: "//wsl$/ubuntu/home/another" });
  expect(invoke).toHaveBeenCalledTimes(count);
  await probeHarnessAvailability({ cwd: other });
  expect(isHarnessAvailable("codex", other)).toBe(false);
  invoke.mockRejectedValue(new Error("Disconnected"));
  await probeHarnessAvailability({ cwd, force: true });
  expect(isHarnessAvailable("codex", cwd)).toBe(false);
  expect(isHarnessAvailable("codex")).toBe(true);
  expect(harnessAuthHint("pi", cwd)).toBeUndefined();
  expect(harnessUnavailableHint("codex", cwd)).toContain("Disconnected");
  expect(harnessUnavailableHint("codex", cwd)).not.toContain("Install");
  invalidateHarnessAvailability(cwd);
  expect(hasProbedHarnessAvailability(cwd)).toBe(false);
  invoke.mockResolvedValue({ codex: { path: "/home/me/.local/bin/codex" } });
  await probeHarnessAvailability({ cwd });
  expect(isHarnessAvailable("codex", cwd)).toBe(true);
});
