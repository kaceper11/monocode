// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSessionTitle } from "../lib/session";
import { Sidebar } from "./Sidebar";

// Keep native services out of these menu interaction tests.
vi.mock("../hooks/useInboxUnseen", () => ({ useInboxUnseen: () => false }));
vi.mock("../hooks/useProjectDiffStats", () => ({
  useProjectDiffStats: () => null,
}));
vi.mock("../hooks/useGitFileStatuses", () => ({
  useGitFileStatuses: () => ({ files: new Map(), dirs: new Map() }),
}));
vi.mock("./SidebarUpdate", () => ({ SidebarUpdateFooter: () => null }));
vi.mock("./FileTree", () => ({ FileTree: () => null }));

let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof Sidebar>;

function render() {
  root.render(createElement(Sidebar, props));
}

function card(id: string): HTMLElement {
  return container.querySelector(`[data-session-card="${id}"]`)!;
}

function openMenu(id: string): HTMLButtonElement[] {
  act(() => {
    card(id).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  );
}

function syncItem(items: HTMLButtonElement[]): HTMLButtonElement | undefined {
  return items.find(
    (item) => item.textContent === "Sync with remote default…",
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  props = {
    cwd: "/workspace/project",
    open: true,
    sessions: [
      {
        id: "session-1",
        cwd: "/workspace/project",
        harness: "codex",
        model: "",
        runtimeMode: "supervised",
        title: formatSessionTitle("codex", "First conversation"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "session-2",
        cwd: "/workspace/project",
        worktreeCwd: "/workspace/project-wt",
        harness: "codex",
        model: "",
        runtimeMode: "supervised",
        title: formatSessionTitle("codex", "Worktree conversation"),
        createdAt: Date.now(),
        updatedAt: Date.now() - 1,
      },
    ],
    busySessionIds: new Set(),
    approvalSessionIds: new Set(),
    activeSessionId: "session-1",
    status: "idle",
    pending: false,
    tab: "sessions",
    filesSearchOpen: false,
    onSelectSession: vi.fn(),
    onRenameSession: vi.fn(),
    onOpenFile: vi.fn(),
    onTabChange: vi.fn(),
    onFilesSearchOpenChange: vi.fn(),
    onSyncSession: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("sidebar sync-with-default menu item", () => {
  it("routes the clicked session — its own worktree — to onSyncSession", () => {
    act(() => render());
    const item = syncItem(openMenu("session-2"))!;
    expect(item.disabled).toBe(false);
    act(() => item.click());
    expect(props.onSyncSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "session-2",
        worktreeCwd: "/workspace/project-wt",
      }),
    );
  });

  it("never falls back to another row's session", () => {
    act(() => render());
    const item = syncItem(openMenu("session-1"))!;
    act(() => item.click());
    expect(props.onSyncSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "session-1" }),
    );
    expect(
      vi.mocked(props.onSyncSession!).mock.calls[0][0].id,
    ).not.toBe("session-2");
  });

  it("is hidden without a handler or on a multi-select menu", () => {
    props.onSyncSession = undefined;
    act(() => render());
    expect(syncItem(openMenu("session-1"))).toBeUndefined();
  });
});
