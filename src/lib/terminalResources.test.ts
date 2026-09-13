import { describe, expect, it } from "vitest";
import type { FilePaneTab, WorkspaceTab } from "./layout";
import type { ProjectTerminalDock } from "./projectTerminal";
import type { PtyResource } from "./pty";
import {
  footerTerminals,
  formatCpu,
  formatMem,
  mergeTerminalRows,
  type FooterTerminal,
} from "./terminalResources";

function terminalFile(id: string, cwd = "/repo"): FilePaneTab {
  return { id, path: "repo", cwd, terminal: true };
}

function dock(projectPath: string, files: FilePaneTab[]): ProjectTerminalDock {
  return {
    projectPath,
    pane: { id: "p", files, activeFileId: files[0]?.id ?? "" },
    side: "bottom",
    size: 220,
    open: true,
  };
}

function tab(files: FilePaneTab[]): WorkspaceTab {
  return {
    kind: "session",
    id: "t1",
    layout: { type: "leaf", id: "s1" },
    focusedId: "s1",
    editorPanes: [],
    terminalPanes: [{ id: "tp", files, activeFileId: files[0]?.id ?? "" }],
  };
}

describe("footerTerminals", () => {
  it("collects the current project's dock and pane terminals", () => {
    const result = footerTerminals(
      [
        dock("/repo", [terminalFile("a")]),
        dock("/other", [terminalFile("b", "/other")]),
      ],
      [tab([terminalFile("c")])],
      "/repo",
    );
    expect(result.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("keeps the tab title and foreground process", () => {
    const file = { ...terminalFile("a"), path: "vite", foreground: "vite" };
    expect(footerTerminals([], [tab([file])], null)).toEqual([
      { id: "a", title: "vite", cwd: "/repo", foreground: "vite" },
    ]);
  });

  it("skips non-terminal files and dockless projects", () => {
    const file = { id: "f", path: "/repo/a.ts", cwd: "/repo" };
    expect(footerTerminals([], [tab([file])], null)).toEqual([]);
    expect(
      footerTerminals([dock("/other", [terminalFile("b")])], [], "/repo"),
    ).toEqual([]);
  });
});

describe("mergeTerminalRows", () => {
  const terminals: FooterTerminal[] = [
    { id: "a", title: "repo", cwd: "/repo", foreground: null },
    { id: "b", title: "other", cwd: "/other", foreground: "make" },
  ];
  const resources: PtyResource[] = [
    {
      id: "a",
      host: "wsl",
      distro: "Ubuntu",
      cpuPct: 42.5,
      rssBytes: 300 * 1024 * 1024,
      processes: 4,
      workload: true,
      top: "node",
    },
  ];

  it("joins stats by terminal id and marks missing ones dead", () => {
    const rows = mergeTerminalRows(terminals, resources);
    expect(rows[0]).toMatchObject({
      id: "a",
      alive: true,
      workload: true,
      cpuPct: 42.5,
      rssBytes: 300 * 1024 * 1024,
      top: "node",
      host: "wsl",
      distro: "Ubuntu",
    });
    expect(rows[1]).toMatchObject({
      id: "b",
      alive: false,
      workload: false,
      cpuPct: null,
      rssBytes: null,
      foreground: "make",
    });
  });

  it("keeps the tab meta foreground alongside live stats", () => {
    const file = { ...terminals[1], foreground: "make" };
    const stat = { ...resources[0], id: "b" };
    const rows = mergeTerminalRows([file], [stat]);
    expect(rows[0]).toMatchObject({ alive: true, foreground: "make" });
  });

  it("reads as alive with unknown stats before the first sample", () => {
    const rows = mergeTerminalRows(terminals, null);
    expect(rows[0]).toMatchObject({
      alive: true,
      workload: false,
      cpuPct: null,
      rssBytes: null,
    });
  });

  it("ignores resource entries with no matching terminal", () => {
    const orphan = { ...resources[0], id: "ghost" };
    const rows = mergeTerminalRows([terminals[0]], [orphan]);
    expect(rows).toHaveLength(1);
    expect(rows[0].alive).toBe(false);
  });
});

describe("formatCpu", () => {
  it("renders null, near-zero and large values", () => {
    expect(formatCpu(null)).toBe("—");
    expect(formatCpu(0)).toBe("0%");
    expect(formatCpu(0.04)).toBe("0%");
    expect(formatCpu(0.5)).toBe("<1%");
    expect(formatCpu(1)).toBe("1%");
    expect(formatCpu(137.4)).toBe("137%");
  });
});

describe("formatMem", () => {
  it("renders B, KB, MB and GB", () => {
    expect(formatMem(null)).toBe("—");
    expect(formatMem(512)).toBe("512 B");
    expect(formatMem(1024)).toBe("1 KB");
    expect(formatMem(64 * 1024)).toBe("64 KB");
    expect(formatMem(384 * 1024 * 1024)).toBe("384 MB");
    expect(formatMem(1024 ** 3)).toBe("1.0 GB");
    expect(formatMem(3.2 * 1024 * 1024 * 1024)).toBe("3.2 GB");
  });
});
