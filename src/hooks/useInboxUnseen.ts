import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  inboxItemKey,
  inboxProjectsForRail,
  listInboxItems,
  type InboxItem,
  type InboxQuery,
} from "../lib/githubTasks";
import {
  applyInboxFilters,
  inboxFetchState,
  loadInboxFilters,
  pruneInboxFilters,
} from "../lib/inboxFilters";
import {
  inboxHasUnseenItems,
  seedInboxSeenIfNeeded,
  subscribeInboxSeen,
  type InboxSeenEntry,
} from "../lib/inboxSeen";
import {
  linkedSessionUpdates,
  linkedWorkItemTargets,
  type LinkedSessionUpdate,
  type LinkedWorkItemTarget,
} from "../lib/linkedSessionUpdates";
import { refreshLinkedWorkItem } from "../lib/linkedWorkItemRefresh";
import {
  indexByWorkItem,
  relatedFromIndex,
} from "../lib/sessionWorkItem";
import {
  linkedSessionSeenAll,
  subscribeLinkedSessionSeen,
} from "../lib/linkedSessionSeen";
import { loadHiddenLinearTeamIds } from "../lib/linear";
import type { RecentProject } from "../lib/recents";
import type { SessionSummary } from "../lib/sessionStore";
import { noteInboxUnseen } from "../lib/sounds";

const POLL_MS = 30_000;
const FALLBACK_REFRESH_MS = 60_000;
const MAX_CONCURRENT_LOOKUPS = 3;

function seenEntries(items: readonly InboxItem[]): InboxSeenEntry[] {
  return items.map((item) => ({
    key: inboxItemKey(item),
    updatedAt: item.updatedAt,
  }));
}

function mergeSnapshots(
  current: ReadonlyMap<string, InboxItem>,
  snapshots: readonly (readonly [string, InboxItem])[],
): ReadonlyMap<string, InboxItem> {
  let next: Map<string, InboxItem> | undefined;
  for (const [key, item] of snapshots) {
    if (current.get(key)?.updatedAt === item.updatedAt) continue;
    next ??= new Map(current);
    next.set(key, item);
  }
  return next ?? current;
}

/** Direct per-provider reads for linked items missing from the Inbox listing. */
async function fetchFallbackUpdates(
  cwd: string,
  targets: readonly LinkedWorkItemTarget[],
): Promise<Array<readonly [string, InboxItem]>> {
  const results: Array<readonly [string, InboxItem]> = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      if (!target) return;
      const item = await refreshLinkedWorkItem(cwd, target.item);
      if (item && Number.isFinite(Date.parse(item.updatedAt))) {
        results.push([target.key, item]);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_LOOKUPS, targets.length) },
      worker,
    ),
  );
  return results;
}

export type InboxActivity = {
  unseen: boolean;
  linkedSessionUpdateIds: ReadonlySet<string>;
  linkedSessionUpdates: ReadonlyMap<string, LinkedSessionUpdate>;
};

/** One background refresh supplies both the Inbox badge and linked sessions. */
export function useInboxActivity(
  recents: RecentProject[],
  cwd: string,
  sessions: readonly SessionSummary[],
): InboxActivity {
  const [unseen, setUnseen] = useState(false);
  const [workItems, setWorkItems] = useState<
    ReadonlyMap<string, InboxItem>
  >(() => new Map());
  const [linkedSeenRevision, setLinkedSeenRevision] = useState(0);
  const entriesRef = useRef<InboxSeenEntry[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const fallbackFetchedAt = useRef(new Map<string, number>());
  const targets = useMemo(() => linkedWorkItemTargets(sessions), [sessions]);
  const targetKey = useMemo(
    () => targets.map((target) => target.key).join("\0"),
    [targets],
  );

  const applyUnseen = useCallback((next: boolean) => {
    noteInboxUnseen(next);
    setUnseen(next);
  }, []);

  useEffect(() => {
    return subscribeInboxSeen(() => {
      applyUnseen(inboxHasUnseenItems(entriesRef.current));
    });
  }, [applyUnseen]);

  useEffect(
    () =>
      subscribeLinkedSessionSeen(() =>
        setLinkedSeenRevision((revision) => revision + 1),
      ),
    [],
  );

  useEffect(() => {
    const projects = inboxProjectsForRail(recents, cwd);

    let cancelled = false;
    let pulling = false;

    const pull = async (force: boolean) => {
      if (pulling) return;
      pulling = true;
      const projectPaths = projects.map((project) => project.path);
      const filters = pruneInboxFilters(loadInboxFilters(), projectPaths);
      const query: InboxQuery = {
        assignedToMe: filters.assignedToMe,
        state: inboxFetchState(filters),
        search: "",
        linearHiddenTeamIds: loadHiddenLinearTeamIds(),
      };
      try {
        // No rail projects still refreshes linked items via the fallback.
        const listed = projects.length
          ? await listInboxItems(projects, query, { force })
          : { items: [], errors: {} };
        if (cancelled) return;
        const visible = applyInboxFilters(listed.items, filters, "");
        const entries = seenEntries(visible);
        entriesRef.current = entries;
        seedInboxSeenIfNeeded(entries);
        applyUnseen(inboxHasUnseenItems(entries));

        const targets = linkedWorkItemTargets(sessionsRef.current);
        const liveKeys = new Set(targets.map((target) => target.key));
        for (const key of fallbackFetchedAt.current.keys()) {
          if (!liveKeys.has(key)) fallbackFetchedAt.current.delete(key);
        }
        const index = indexByWorkItem(targets, (target) => [target.item]);
        const listedKeys = new Set<string>();
        const snapshots: Array<readonly [string, InboxItem]> = [];
        for (const item of listed.items) {
          if (item.kind === "ci") continue;
          for (const target of relatedFromIndex(item, index)) {
            // Azure PR listing rows stamp only creation/close — comment
            // activity needs the direct thread read in the fallback below.
            if (target.item.provider === "azure" && target.item.kind === "pr")
              continue;
            listedKeys.add(target.key);
            if (Number.isFinite(Date.parse(item.updatedAt))) {
              snapshots.push([target.key, item]);
            }
          }
        }
        if (snapshots.length > 0) {
          setWorkItems((current) => mergeSnapshots(current, snapshots));
        }

        const now = Date.now();
        const missing = targets.filter((target) => {
          if (listedKeys.has(target.key)) return false;
          const last = fallbackFetchedAt.current.get(target.key) ?? 0;
          if (now - last < FALLBACK_REFRESH_MS) return false;
          fallbackFetchedAt.current.set(target.key, now);
          return true;
        });
        if (missing.length > 0) {
          const fallback = await fetchFallbackUpdates(cwd, missing);
          if (!cancelled && fallback.length > 0) {
            setWorkItems((current) => mergeSnapshots(current, fallback));
          }
        }
      } catch {
        // Leave the last known badges; a later poll can try again.
      } finally {
        pulling = false;
      }
    };

    void pull(false);
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void pull(true);
    }, POLL_MS);
    const onVis = () => {
      if (!document.hidden) void pull(true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [applyUnseen, cwd, recents, targetKey]);

  const updates = useMemo(() => {
    const seen = linkedSessionSeenAll();
    return linkedSessionUpdates(
      sessions,
      workItems,
      (sessionId) => seen[sessionId] ?? 0,
    );
  }, [sessions, workItems, linkedSeenRevision]);
  const updateIds = useMemo(() => new Set(updates.keys()), [updates]);
  return {
    unseen,
    linkedSessionUpdates: updates,
    linkedSessionUpdateIds: updateIds,
  };
}
