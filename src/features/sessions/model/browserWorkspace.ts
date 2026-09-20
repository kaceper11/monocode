import { openEditorTab, removePane, firstLeafId, siblingLeafId } from "../../workspace/model/layout.ts";
import type { FilePaneTab, WorkspaceTab, LayoutRect } from "../../workspace/model/layout.ts";
import { isHttpUrl } from "./browser";

export type BrowserTabSource = {
  /** Page currently shown; updated as the webview navigates. */
  url: string;
  /** Last document title reported by the page. */
  title?: string;
  /** Leaf expands to cover the whole pane area; other leaves stay mounted. */
  expanded?: boolean;
  /** Keep cookies/site data across restarts — the default. `false` marks a
   * private tab on the throwaway data store. */
  persist?: boolean;
};

export function newBrowserTab(
  cwd: string,
  url: string,
  persist = true,
): FilePaneTab {
  return {
    id: crypto.randomUUID(),
    path: url,
    cwd,
    browser: { url, ...(persist ? {} : { persist: false }) },
  };
}

export type BrowserMetaPatch = {
  url?: string;
  title?: string;
  expanded?: boolean;
  persist?: boolean;
};

/** Page-side state the webview reports back; keeps tab + snapshot current. */
export function updateBrowserTab(
  tab: WorkspaceTab,
  fileId: string,
  patch: BrowserMetaPatch,
): WorkspaceTab {
  let changed = false;
  const editorPanes = tab.editorPanes.map((pane) => {
    let paneChanged = false;
    const files = pane.files.map((file) => {
      if (!file.browser || file.id !== fileId) return file;
      const url = patch.url?.trim();
      const title =
        patch.title !== undefined ? patch.title.trim() : file.browser.title;
      const expanded = patch.expanded ?? file.browser.expanded;
      const persist = patch.persist ?? file.browser.persist;
      if (
        (!url || url === file.browser.url) &&
        title === file.browser.title &&
        expanded === file.browser.expanded &&
        persist === file.browser.persist
      )
        return file;
      paneChanged = true;
      const browser: BrowserTabSource = {
        url: url || file.browser.url,
        ...(title ? { title } : {}),
        ...(expanded ? { expanded: true } : {}),
        ...(persist === false ? { persist: false } : {}),
      };
      return { ...file, ...(url ? { path: url } : {}), browser };
    });
    if (!paneChanged) return pane;
    changed = true;
    return { ...pane, files };
  });
  if (!changed) return tab;
  return { ...tab, editorPanes };
}

/** Restore only browser-owned metadata; never reinterpret another tab kind. */
export function restoreBrowserTab(value: Record<string, unknown>): FilePaneTab | null {
  const source = value.browser;
  if (!source || typeof source !== "object") return null;
  const browser = source as Record<string, unknown>;
  if (
    typeof value.id !== "string" || !value.id ||
    typeof value.cwd !== "string" || !value.cwd ||
    typeof browser.url !== "string" ||
    (browser.url !== "" && !isHttpUrl(browser.url)) ||
    browser.url.length > 8192 ||
    ["plan", "releaseNotes", "commit", "sessionChanges", "terminal", "review", "changes", "delivery", "agent", "changeKind"]
      .some(key => value[key] != null && value[key] !== false)
  ) return null;
  return {
    id: value.id,
    path: browser.url,
    cwd: value.cwd,
    ...(typeof value.projectCwd === "string" && value.projectCwd ? { projectCwd: value.projectCwd } : {}),
    browser: {
      url: browser.url,
      ...(typeof browser.title === "string" && browser.title.trim() ? { title: browser.title.trim().slice(0, 200) } : {}),
      ...(browser.expanded === true ? { expanded: true } : {}),
      ...(browser.persist === false ? { persist: false } : {}),
    },
  };
}

/** Use upstream pane insertion; only explicit browser targeting changes focus. */
export function openBrowserTab(tab: WorkspaceTab, file: FilePaneTab, paneId?: string): WorkspaceTab {
  const target = paneId && tab.editorPanes.some(pane => pane.id === paneId)
    ? { ...tab, focusedId: paneId } : tab;
  return openEditorTab(target, file);
}

/** Close browser tabs while retaining other editors, terminals and sessions. */
export function closeBrowserTabs(tab: WorkspaceTab): WorkspaceTab | null {
  let layout = tab.layout;
  let focusedId = tab.focusedId;
  const editorPanes = [];
  for (const pane of tab.editorPanes) {
    if (!pane.files.some(file => file.browser)) { editorPanes.push(pane); continue; }
    const files = pane.files.filter(file => !file.browser);
    if (files.length) {
      editorPanes.push(files.length === pane.files.length ? pane : {
        ...pane, files,
        activeFileId: files.some(file => file.id === pane.activeFileId) ? pane.activeFileId : files[0].id,
      });
      continue;
    }
    const sibling = siblingLeafId(layout, pane.id);
    const next = removePane(layout, pane.id);
    if (!next) return null;
    layout = next;
    if (focusedId === pane.id) focusedId = sibling ?? firstLeafId(next);
  }
  return { ...tab, layout, focusedId, editorPanes };
}

/** Compact dock size while a browser is expanded: ~24rem, capped at a
 * fraction of the pane area so the dock never dominates a small window. */
const DOCK_PX = 24 * 16;
const DOCK_FRAC = 0.4;

/** A leaf docked while a browser is expanded keeps the edge it already
 * hugs, shrunk to a compact band; the expanded pane fills the rest. */
type DockBand = {
  side: "left" | "right" | "top" | "bottom";
  agent: LayoutRect;
  rest: LayoutRect;
};

export function browserDockBand(
  rect: LayoutRect,
  tree: { w: number; h: number },
): DockBand {
  const E = 1e-3;
  let side: DockBand["side"];
  if (rect.h > 1 - E && rect.y < E) {
    side = rect.x + rect.w / 2 < 0.5 ? "left" : "right";
  } else if (rect.w > 1 - E && rect.x < E) {
    side = rect.y + rect.h / 2 < 0.5 ? "top" : "bottom";
  } else {
    const d = {
      left: rect.x,
      right: 1 - rect.x - rect.w,
      top: rect.y,
      bottom: 1 - rect.y - rect.h,
    };
    side = (Object.keys(d) as DockBand["side"][]).reduce((a, b) =>
      d[a] <= d[b] ? a : b,
    );
  }
  const span = tree.w > 0 ? Math.min(DOCK_PX / tree.w, DOCK_FRAC) : DOCK_FRAC;
  const spanY =
    tree.h > 0 ? Math.min(DOCK_PX / tree.h, DOCK_FRAC) : DOCK_FRAC;
  const w = Math.min(rect.w, span);
  const h = Math.min(rect.h, spanY);
  switch (side) {
    case "left":
      return {
        side,
        agent: { x: 0, y: 0, w, h: 1 },
        rest: { x: w, y: 0, w: 1 - w, h: 1 },
      };
    case "right":
      return {
        side,
        agent: { x: 1 - w, y: 0, w, h: 1 },
        rest: { x: 0, y: 0, w: 1 - w, h: 1 },
      };
    case "top":
      return {
        side,
        agent: { x: 0, y: 0, w: 1, h },
        rest: { x: 0, y: h, w: 1, h: 1 - h },
      };
    default:
      return {
        side,
        agent: { x: 0, y: 1 - h, w: 1, h },
        rest: { x: 0, y: 0, w: 1, h: 1 - h },
      };
  }
}
