import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  inboxFetchPaths,
  inboxListCacheKey,
  inboxItemKey,
  inboxProjectIdentities,
  inboxProjectsForRail,
  inboxRailKeyResolver,
  listInboxItems,
  type InboxItem,
  type InboxQuery,
  type InboxProvider,
} from "../lib/githubTasks";
import {
  applyInboxFilters,
  inboxFetchState,
  loadInboxFilters,
  pruneInboxFilters,
} from "../lib/inboxFilters";
import {
  inboxHasUnseenItems,
  rememberInboxItems,
  markInboxItemsSeen,
  seedInboxSeenIfNeeded,
  subscribeInboxSeen,
  type InboxSeenEntry,
} from "../lib/inboxSeen";
import {
  linkedSessionUpdates,
  linkedWorkItemTargets,
  linkedWorkItemUpdateKey,
  type LinkedSessionUpdate,
  type LinkedWorkItemTarget,
} from "../lib/linkedSessionUpdates";
import { refreshLinkedWorkItem } from "../lib/linkedWorkItemRefresh";
import {
  indexByWorkItem,
  relatedFromIndex,
} from "../lib/sessionWorkItem";
import {
  markLinkedSessionUpdateSeen,
  linkedSessionSeenAll,
  subscribeLinkedSessionSeen,
} from "../lib/linkedSessionSeen";
import { loadHiddenLinearTeamIds } from "../lib/linear";
import { projectsSnapshot, subscribeProjects } from "../lib/projects";
import type { RecentProject } from "../lib/recents";
import type { SessionSummary } from "../lib/sessionStore";
import { playCue } from "../lib/sounds";
import {
  InboxNotificationTracker,
  inboxNotificationSubject,
} from "../lib/inboxNotifications";
import {
  inboxNotificationProject,
  rememberNotificationProjects,
} from "../lib/notificationProjects";
import {
  allowsProjectNotificationIndicator,
  loadNotificationPreferences,
  subscribeNotificationPreferences,
  type NotificationSubject,
} from "../lib/notificationPreferences";
import {
  consumeInboxSelfActivity,
  subscribeInboxSelfActivity,
} from "../lib/inboxSelfActivity";

const POLL_MS = 30_000;
const FALLBACK_REFRESH_MS = 60_000;
const MAX_CONCURRENT_LOOKUPS = 3;

type ProjectSeenEntry = InboxSeenEntry & NotificationSubject;

function seenEntries(items: readonly InboxItem[]): ProjectSeenEntry[] {
  return items.map((item) => ({
    key: inboxItemKey(item),
    updatedAt: item.updatedAt,
    ...inboxNotificationSubject(item),
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
  const [notificationRevision, setNotificationRevision] = useState(0);
  const entriesRef = useRef<ProjectSeenEntry[]>([]);
  const notifications = useRef(new InboxNotificationTracker());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const fallbackFetchedAt = useRef(new Map<string, number>());
  const targets = useMemo(() => linkedWorkItemTargets(sessions), [sessions]);
  const targetKey = useMemo(
    () => targets.map((target) => target.key).join("\0"),
    [targets],
  );

  const applyUnseen = useCallback(() => {
    const preferences = loadNotificationPreferences();
    // Category choices and mute affect badges, never the item's unread state.
    setUnseen(
      inboxHasUnseenItems(
        entriesRef.current.filter((entry) =>
          allowsProjectNotificationIndicator(entry, preferences),
        ),
      ),
    );
  }, []);

  useEffect(() => {
    const stopSeen = subscribeInboxSeen(applyUnseen);
    const stopPreferences = subscribeNotificationPreferences(() => {
      applyUnseen();
      setNotificationRevision((revision) => revision + 1);
    });
    return () => {
      stopSeen();
      stopPreferences();
    };
  }, [applyUnseen]);

  useEffect(
    () =>
      subscribeLinkedSessionSeen(() =>
        setLinkedSeenRevision((revision) => revision + 1),
      ),
    [],
  );

  // Repulling on a project-store save is what lands a just-added project's
  // items without waiting for the next interval or a remount.
  const projectsRaw = useSyncExternalStore(subscribeProjects, projectsSnapshot);

  useEffect(() => {
    let cancelled = false;
    let pulling = false;
    let pullAgain = false;

    const pull = async (force: boolean) => {
      if (pulling) {
        pullAgain ||= force;
        return;
      }
      pulling = true;
      // Recomputed per pass — membership edits between polls are picked up.
      const projects = inboxProjectsForRail(recents, cwd);
      const filters = pruneInboxFilters(
        loadInboxFilters(),
        inboxProjectIdentities(projects),
      );
      const query: InboxQuery = {
        assignedToMe: filters.assignedToMe,
        state: inboxFetchState(filters),
        search: "",
        linearHiddenTeamIds: loadHiddenLinearTeamIds(),
      };
      try {
        // No rail projects still refreshes linked items via the fallback.
        const listed = projects.length
          ? await listInboxItems(inboxFetchPaths(projects), query, { force })
          : { items: [], errors: {} };
        if (cancelled) return;
        const visible = applyInboxFilters(
          listed.items,
          filters,
          "",
          Date.now(),
          undefined,
          inboxRailKeyResolver(projects),
        );
        rememberNotificationProjects(
          listed.items.map(inboxNotificationProject),
        );
        const changed = notifications.current.observe(
          listed.items,
          inboxListCacheKey(inboxFetchPaths(projects), query),
          Object.keys(listed.errors) as InboxProvider[],
        );
        const selfAuthored = changed.filter((item) =>
          consumeInboxSelfActivity(item),
        );
        const selfAuthoredKeys = new Set(selfAuthored.map(inboxItemKey));
        const visibleKeys = new Set(visible.map(inboxItemKey));
        // The whole batch is observed even when every cue is suppressed. At most
        // one eligible project chimes; muted projects cannot consume that slot.
        for (const item of changed) {
          if (selfAuthoredKeys.has(inboxItemKey(item))) continue;
          if (!visibleKeys.has(inboxItemKey(item))) continue;
          if (playCue("inboxUnseen", inboxNotificationSubject(item))) break;
        }
        const entries = seenEntries(visible);
        entriesRef.current = entries;
        rememberInboxItems(listed.items.map((item) => ({
          key: inboxItemKey(item),
          updatedAt: item.updatedAt,
          projectPath: item.projectPath,
        })));
        seedInboxSeenIfNeeded(entries);
        const selfAuthoredEntries = entries.filter((entry) =>
          selfAuthoredKeys.has(entry.key),
        );
        if (selfAuthoredEntries.length > 0) {
          markInboxItemsSeen(selfAuthoredEntries);
        }
        for (const item of selfAuthored) {
          if (
            item.provider !== "github" ||
            (item.kind !== "issue" && item.kind !== "pr")
          )
            continue;
          const updatedAt = Date.parse(item.updatedAt);
          if (!Number.isFinite(updatedAt)) continue;
          const key = linkedWorkItemUpdateKey({
            repo: item.repo,
            kind: item.kind,
            number: item.number,
            url: item.url,
          });
          for (const session of sessionsRef.current) {
            if (
              session.linkedWorkItem &&
              linkedWorkItemUpdateKey(session.linkedWorkItem) === key
            ) {
              markLinkedSessionUpdateSeen(session.id, updatedAt);
            }
          }
        }
        applyUnseen();

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
        if (!cancelled && pullAgain) {
          pullAgain = false;
          void pull(true);
        }
      }
    };

    void pull(false);
    const stopSelfActivity = subscribeInboxSelfActivity(() => void pull(true));
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
      stopSelfActivity();
    };
  }, [applyUnseen, cwd, recents, targetKey, projectsRaw]);

  const updates = useMemo(() => {
    const seen = linkedSessionSeenAll();
    return linkedSessionUpdates(
      sessions,
      workItems,
      (sessionId) => seen[sessionId] ?? 0,
    );
  }, [sessions, workItems, linkedSeenRevision]);
  const linkedIndicators = useMemo(() => {
    const preferences = loadNotificationPreferences();
    return new Set(
      [...updates]
        .filter(([, update]) =>
          allowsProjectNotificationIndicator(
            inboxNotificationSubject({
              ...update.item,
              provider: update.item.provider ?? "github",
            }),
            preferences,
          ),
        )
        .map(([id]) => id),
    );
  }, [updates, notificationRevision]);
  return {
    unseen,
    linkedSessionUpdates: updates,
    linkedSessionUpdateIds: linkedIndicators,
  };
}
