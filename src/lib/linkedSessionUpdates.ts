import type { LinkedWorkItem } from "./session";
import type { InboxItem } from "./githubTasks";
import type { SessionSummary } from "./sessionStore";
import { sessionWorkItems } from "./sessionWorkItem";

export type LinkedWorkItemTarget = {
  key: string;
  item: LinkedWorkItem;
};

export type LinkedSessionUpdate = {
  sessionId: string;
  /** The remote snapshot that triggered the update. */
  item: InboxItem;
  /** The linked work item it matched — the thread fetch uses this identity. */
  linked: LinkedWorkItem;
  /** The last local turn or acknowledged remote snapshot, whichever is newer. */
  since: number;
  updatedAt: number;
};

/**
 * Identity mirrors {@link inboxItemMatchesLinkedWorkItem}: GitHub uses
 * repo/kind/number, every other provider its item URL. Provider and account
 * stay in the key — same short names and issue numbers exist across services
 * and connections.
 */
export function linkedWorkItemUpdateKey(
  item: Pick<
    LinkedWorkItem,
    "provider" | "account" | "repo" | "kind" | "number" | "url"
  >,
): string {
  const provider = item.provider ?? "github";
  const identity =
    provider === "github"
      ? `${item.repo.trim().toLowerCase()}:${item.kind}:${item.number}`
      : item.url;
  return `${provider}:${item.account ?? ""}:${identity}`;
}

export function linkedWorkItemTargets(
  sessions: readonly SessionSummary[],
): LinkedWorkItemTarget[] {
  const targets = new Map<string, LinkedWorkItem>();
  for (const session of sessions) {
    if (session.archived) continue;
    for (const linked of sessionWorkItems(session)) {
      const key = linkedWorkItemUpdateKey(linked);
      if (!targets.has(key)) targets.set(key, linked);
    }
  }
  return [...targets].map(([key, item]) => ({ key, item }));
}

/** Sessions whose linked item changed after the last local turn/read snapshot. */
export function linkedSessionUpdates(
  sessions: readonly SessionSummary[],
  workItems: ReadonlyMap<string, InboxItem>,
  seenAt: (sessionId: string) => number = () => 0,
): Map<string, LinkedSessionUpdate> {
  const updates = new Map<string, LinkedSessionUpdate>();
  for (const session of sessions) {
    if (session.archived) continue;
    const since = Math.max(session.updatedAt, seenAt(session.id));
    for (const linked of sessionWorkItems(session)) {
      const item = workItems.get(linkedWorkItemUpdateKey(linked));
      if (!item) continue;
      const remoteUpdatedAt = Date.parse(item.updatedAt);
      if (!Number.isFinite(remoteUpdatedAt) || remoteUpdatedAt <= since)
        continue;
      const current = updates.get(session.id);
      // One card per session: the most recently changed link wins.
      if (current && current.updatedAt >= remoteUpdatedAt) continue;
      updates.set(session.id, {
        sessionId: session.id,
        item,
        linked,
        since,
        updatedAt: remoteUpdatedAt,
      });
    }
  }
  return updates;
}

/** A replaced primary link — any activity card belongs to the old item. */
export function linkedWorkItemIdentityChanged(
  before: LinkedWorkItem | undefined,
  after: LinkedWorkItem | undefined,
): boolean {
  if (!before || !after) return before !== after;
  return linkedWorkItemUpdateKey(before) !== linkedWorkItemUpdateKey(after);
}

export function linkedSessionUpdateIds(
  sessions: readonly SessionSummary[],
  workItems: ReadonlyMap<string, InboxItem>,
  seenAt?: (sessionId: string) => number,
): Set<string> {
  return new Set(linkedSessionUpdates(sessions, workItems, seenAt).keys());
}
