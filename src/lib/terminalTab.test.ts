import { describe, expect, it } from "vitest";
import { newTerminalFile } from "./layout";
import {
  applyTerminalMeta,
  defaultTerminalTitle,
  runningTerminalChipLabel,
  scanOscCwd,
  terminalTabLabel,
} from "./terminalTab";

describe("defaultTerminalTitle", () => {
  it("uses the directory basename", () => {
    expect(defaultTerminalTitle("/Users/dev/agent-terminal")).toBe(
      "agent-terminal",
    );
    expect(defaultTerminalTitle("/")).toBe("Terminal");
  });
});

describe("terminalTabLabel", () => {
  it("prefers the dynamic title on the tab", () => {
    const file = newTerminalFile("/repo", "npm");
    expect(terminalTabLabel(file)).toBe("npm");
  });
});

describe("applyTerminalMeta", () => {
  it("records a foreground process and clears it", () => {
    const file = newTerminalFile("/repo", "repo");
    const running = applyTerminalMeta(file, {
      title: "vite",
      foreground: "vite",
    });
    expect(running).toMatchObject({ path: "vite", foreground: "vite" });
    expect(running).not.toBe(file);

    const idle = applyTerminalMeta(running, {
      title: "repo",
      foreground: null,
    });
    expect(idle.path).toBe("repo");
    expect(idle.foreground).toBeUndefined();
  });

  it("returns the same object when nothing changes", () => {
    const file = applyTerminalMeta(newTerminalFile("/repo", "vite"), {
      foreground: "vite",
    });
    expect(applyTerminalMeta(file, { foreground: "vite" })).toBe(file);
  });

  it("merges a bound command's run state", () => {
    const file = {
      ...newTerminalFile("/repo", "dev"),
      command: {
        presetId: "c1",
        name: "Dev",
        text: "npm run dev",
        runId: 1,
      },
    };
    const launched = applyTerminalMeta(file, { command: { launched: 1 } });
    expect(launched.command).toEqual({
      presetId: "c1",
      name: "Dev",
      text: "npm run dev",
      runId: 1,
      launched: 1,
    });
    expect(launched).not.toBe(file);
    // An identical patch is a no-op — no new object, no extra render.
    expect(
      applyTerminalMeta(launched, { command: { launched: 1 } }),
    ).toBe(launched);
    const rerun = applyTerminalMeta(launched, { command: { runId: 2 } });
    expect(rerun.command).toMatchObject({ runId: 2, launched: 1 });
  });
});

describe("runningTerminalChipLabel", () => {
  it("joins unique names and collapses duplicates", () => {
    expect(runningTerminalChipLabel(["vite", "jest"])).toBe("vite · jest");
    expect(runningTerminalChipLabel(["vite", "vite"])).toBe("vite ×2");
    expect(runningTerminalChipLabel([])).toBe("");
  });
});

describe("scanOscCwd", () => {
  it("extracts cwd from OSC 7 reports", () => {
    const chunk = "\x1b]7;file://host/Users/dev/repo\x07";
    const { cwd, rest } = scanOscCwd(chunk, "");
    expect(cwd).toBe("/Users/dev/repo");
    expect(rest).toBe("");
  });

  it("keeps a trailing buffer for split sequences", () => {
    const partial = "\x1b]7;file://host/Users/dev";
    const { cwd, rest } = scanOscCwd("/repo\x07", partial);
    expect(cwd).toBe("/Users/dev/repo");
    expect(rest).toBe("");
  });
});
