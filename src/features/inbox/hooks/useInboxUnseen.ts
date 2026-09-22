import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  inboxListCacheKey,
  inboxItemKey,
  inboxProjectsForRail,
  listInboxItems,
  type InboxItem,
  type InboxQuery,
  type InboxProvider,
} from "../model/githubTasks";
import {
  applyInboxFilters,
  inboxFetchState,
  loadInboxFilters,
  pruneInboxFilters,
} from "../model/inboxFilters";
import {
  inboxHasUnseenItems,
  rememberInboxItems,
  markInboxItemsSeen,
  seedInboxSeenIfNeeded,
  subscribeInboxSeen,
  type InboxSeenEntry,
} from "../model/inboxSeen";
import {
  linkedSessionUpdates,
  linkedWorkItemTargets,
  linkedWorkItemUpdateKey,
  type LinkedSessionUpdate,
  type LinkedWorkItemTarget,
} from "../model/linkedSessionUpdates";
import { refreshLinkedWorkItem } from "../../sessions/model/linkedWorkItemRefresh";
import {
  indexByWorkItem,
  relatedFromIndex,
} from "../../sessions/model/sessionWorkItem";
import {
  markLinkedSessionUpdateSeen,
  linkedSessionSeenAt,
  subscribeLinkedSessionSeen,
} from "../model/linkedSessionSeen";
import { loadHiddenLinearTeamIds } from "../model/linear";
import type { RecentProject } from "../../projects/model/recents";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { playCue } from "../../settings/model/sounds";
import {
  InboxNotificationTracker,
  inboxNotificationSubject,
} from "../model/inboxNotifications";
import {
  inboxNotificationProject,
  rememberNotificationProjects,
} from "../../notifications/model/notificationProjects";
import {
  allowsProjectNotificationIndicator,
  loadNotificationPreferences,
  subscribeNotificationPreferences,
  type NotificationSubject,
} from "../../notifications/model/notificationPreferences";
import {
  consumeInboxSelfActivity,
  subscribeInboxSelfActivity,
} from "../model/inboxSelfActivity";

import { listInboxIntegrations } from "../../sessions/model/inboxIntegrations";

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
    const previous = current.get(key);
    if (previous?.updatedAt === item.updatedAt && previous.account === item.account) continue;
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
  options?: { onAppeared?: (items: InboxItem[]) => void },
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
  const onAppearedRef = useRef(options?.onAppeared);
  const fallbackFetchedAt = useRef(new Map<string, number>());
  const targetKey = linkedWorkItemTargets(sessions)
    .map((target) => target.key)
    .join("\0");

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

  useLayoutEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useLayoutEffect(() => {
    onAppearedRef.current = options?.onAppeared;
  }, [options?.onAppeared]);

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

  useEffect(() => {
    const projects = inboxProjectsForRail(recents, cwd);
    let cancelled = false;
    let pulling = false;
    let pullAgain = false;

    const pull = async (force: boolean) => {
      if (pulling) {
        pullAgain ||= force;
        return;
      }
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
        // Preserve upstream's no-project boundary; added services are project-independent.
        const listed = projects.length
          ? await listInboxItems(projects, query, { force })
          : await listInboxIntegrations(query.state, query.assignedToMe);
        if (cancelled) return;
        const visible = applyInboxFilters(listed.items, filters, "");
        rememberNotificationProjects(
          listed.items.map(inboxNotificationProject),
        );
        const observed = notifications.current.observe(
          listed.items,
          inboxListCacheKey(projects, query),
          Object.keys(listed.errors) as InboxProvider[],
        );
        const changed = observed.changed;
        // Invoke on every successful poll so retained automation claims can be
        // retried even when the item is no longer newly appeared.
        onAppearedRef.current?.(observed.appeared);
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

        const targets = linkedWorkItemTargets(sessionsRef.current).filter(
          (target) => projects.length > 0 ||
            target.item.provider === "jira" ||
            (target.item.provider as string) === "azure" ||
            target.item.provider === "azuredevops",
        );
        const liveKeys = new Set(targets.map((target) => target.key));
        for (const key of fallbackFetchedAt.current.keys()) {
          if (!liveKeys.has(key)) fallbackFetchedAt.current.delete(key);
        }
        const index = indexByWorkItem(targets, (target) => [target.item]);
        const listedKeys = new Set<string>();
        const snapshots: Array<readonly [string, InboxItem]> = [];
        for (const item of listed.items) {
          for (const target of relatedFromIndex(item, index)) {
            // Azure PR listing rows stamp only creation/close — comment
            // activity needs the direct thread read in the fallback below.
            if (
              ((target.item.provider as string) === "azure" ||
                target.item.provider === "azuredevops") &&
              target.item.kind === "pr"
            )
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
    // Keep polling while minimized or closed-to-tray: the webview is still
    // alive, and Inbox automation triggers ride this same refresh.
    const timer = window.setInterval(() => void pull(true), POLL_MS);
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
  }, [applyUnseen, cwd, recents, targetKey]);

  const updates = useMemo(
    () => linkedSessionUpdates(sessions, workItems, linkedSessionSeenAt),
    [sessions, workItems, linkedSeenRevision],
  );
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

/** Badge-only compatibility wrapper for consumers that do not render sessions. */
export function useInboxUnseen(recents: RecentProject[], cwd: string): boolean {
  return useInboxActivity(recents, cwd, []).unseen;
}
