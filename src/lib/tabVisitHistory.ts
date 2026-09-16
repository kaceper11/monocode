/**
 * Browser-style back/forward stack for workspace locations.
 *
 * A location is either an overlay (inbox, search, settings, notes) or a
 * workspace tab plus the leaf (session / editor / terminal pane) focused in
 * it — whatever was actually on screen when the user navigated away.
 */

const MAX_STACK = 50;

export type OverlayView = "inbox" | "search" | "settings" | "notes";

export type VisitLocation =
  | { view: OverlayView; conversation?: string }
  | { tab: string; leaf?: string; diff?: boolean };

export type TabVisitHistory = {
  back: VisitLocation[];
  forward: VisitLocation[];
  current: VisitLocation;
};

export function sameVisitLocation(a: VisitLocation, b: VisitLocation): boolean {
  if ("view" in a || "view" in b) {
    return (
      "view" in a &&
      "view" in b &&
      a.view === b.view &&
      a.conversation === b.conversation
    );
  }
  return a.tab === b.tab && a.leaf === b.leaf && !!a.diff === !!b.diff;
}

export function emptyTabVisitHistory(current: VisitLocation): TabVisitHistory {
  return { back: [], forward: [], current };
}

export function recordTabVisit(
  history: TabVisitHistory,
  location: VisitLocation,
): TabVisitHistory {
  if (sameVisitLocation(history.current, location)) return history;
  const back = [...history.back, history.current];
  while (back.length > MAX_STACK) back.shift();
  return { back, forward: [], current: location };
}

export function tabVisitBack(
  history: TabVisitHistory,
): TabVisitHistory | undefined {
  const previous = history.back[history.back.length - 1];
  if (previous === undefined) return undefined;
  return {
    back: history.back.slice(0, -1),
    forward: [history.current, ...history.forward],
    current: previous,
  };
}

export function tabVisitForward(
  history: TabVisitHistory,
): TabVisitHistory | undefined {
  const next = history.forward[0];
  if (next === undefined) return undefined;
  return {
    back: [...history.back, history.current],
    forward: history.forward.slice(1),
    current: next,
  };
}

export function canTabVisitBack(history: TabVisitHistory): boolean {
  return history.back.length > 0;
}

export function canTabVisitForward(history: TabVisitHistory): boolean {
  return history.forward.length > 0;
}

function collapseAdjacent(history: TabVisitHistory): TabVisitHistory {
  const back: VisitLocation[] = [];
  for (const entry of history.back) {
    if (back.length && sameVisitLocation(back[back.length - 1], entry))
      continue;
    back.push(entry);
  }
  while (
    back.length &&
    sameVisitLocation(back[back.length - 1], history.current)
  ) {
    back.pop();
  }
  const forward = history.forward.filter(
    (entry, index) =>
      !sameVisitLocation(
        index === 0 ? history.current : history.forward[index - 1],
        entry,
      ),
  );
  return { back, forward, current: history.current };
}

/**
 * Drop visits to tabs that no longer exist and snap `current` to the active
 * location when it pointed at a closed tab. Overlay visits are always valid.
 */
export function pruneTabVisitHistory(
  history: TabVisitHistory,
  openTabs: Set<string>,
  active: VisitLocation,
): TabVisitHistory {
  const kept = (entry: VisitLocation) =>
    "view" in entry || openTabs.has(entry.tab);
  const back = history.back.filter(kept);
  const forward = history.forward.filter(kept);
  const current =
    "view" in history.current || openTabs.has(history.current.tab)
      ? history.current
      : active;
  return collapseAdjacent({ back, forward, current });
}
