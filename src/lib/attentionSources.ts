import {
  ATTENTION_ACTION,
  ATTENTION_INFO,
  ATTENTION_URGENT,
  type AttentionItem,
} from "./attention";
import { composeToolTitle } from "./harness/preview";
import { displayPath, isEqualOrInside, pathKey, projectName } from "./paths";
import type { ProjectRecord } from "./projects";
import { collectRailProjects, type RecentProject } from "./recents";
import {
  lastWorkingCopyUse,
  workingCopyAge,
  type RepositoryFamily,
} from "./repositoryFamilies";
import type { RepairRecord } from "./repair";
import {
  HARNESS_TITLE,
  sessionDisplayTitle,
  sessionWorkCwd,
  type Session,
} from "./session";
import type { SessionReminder } from "./sessionReminders";

/**
 * Local signals → AttentionItems (#76 "feed the queue from local signals
 * first"). These rows are *derived*: recomputed from live state on every
 * read, so they clear the moment the underlying condition resolves — an
 * answered approval, a reviewed session, a released repair. They are never
 * written to the attention store; only their mute state persists.
 */

function pendingApprovals(session: Session): AttentionItem[] {
  const items: AttentionItem[] = [];
  const title = sessionDisplayTitle(session.title, session.harness);
  const cwd = sessionWorkCwd(session);
  for (const block of session.blocks) {
    if (!block.approval || block.approval.decided) continue;
    const preview = block.tool?.preview;
    const what =
      composeToolTitle({
        kind: block.tool?.kind,
        title: block.text || block.tool?.title,
        path: preview?.path
          ? displayPath(preview.path, session.cwd)
          : preview?.fileName,
        query: preview?.query,
        previewKind: preview?.kind,
        cwd: session.cwd,
      }) || block.text;
    items.push({
      key: `approval:${session.id}:${block.approval.requestId}`,
      kind: "approval",
      title: what ? `Approve: ${what.slice(0, 120)}` : `${HARNESS_TITLE[session.harness]} needs approval`,
      detail: title,
      urgency: ATTENTION_URGENT,
      at: block.startedAt ?? Date.now(),
      signature: `approval:${block.approval.requestId}`,
      provider: undefined,
      cwd,
      sessionId: session.id,
      action: { kind: "open-session", sessionId: session.id },
    });
  }
  if (session.pendingQuestion) {
    const question = session.pendingQuestion;
    items.push({
      key: `question:${session.id}:${question.requestId}`,
      kind: "approval",
      title:
        question.title ||
        question.questions[0]?.prompt ||
        `${HARNESS_TITLE[session.harness]} has a question`,
      detail: title,
      urgency: ATTENTION_URGENT,
      at: Date.now(),
      signature: `question:${question.requestId}`,
      cwd,
      sessionId: session.id,
      action: { kind: "open-session", sessionId: session.id },
    });
  }
  return items;
}

function finishedItems(
  session: Session,
): AttentionItem[] {
  const title = sessionDisplayTitle(session.title, session.harness);
  const cwd = sessionWorkCwd(session);
  // Signature binds to the turn that finished — a new turn finishing later
  // resurfaces even if the user muted this row.
  let turnStart: number | undefined;
  for (let i = session.blocks.length - 1; i >= 0; i--) {
    if (session.blocks[i].role === "user") {
      turnStart = session.blocks[i].startedAt;
      break;
    }
  }
  const signature = `finished:${turnStart ?? 0}`;
  return [
    {
      key: `finished:${session.id}:${signature}`,
      kind: "finished",
      title: `${title} finished`,
      detail: displayPath(cwd) || "Review the result",
      urgency: ATTENTION_ACTION,
      at: Date.now(),
      signature,
      cwd,
      sessionId: session.id,
      action: { kind: "open-changes", sessionId: session.id },
    },
  ];
}

function reminderItems(reminder: SessionReminder): AttentionItem[] {
  return [
    {
      key: `reminder:${reminder.sessionId}:${reminder.dueAt}`,
      kind: "reminder",
      title: reminder.title || "Session reminder",
      detail: `${HARNESS_TITLE[reminder.harness]} · ${displayPath(reminder.cwd)}`,
      urgency: ATTENTION_URGENT,
      at: reminder.firedAt ?? reminder.dueAt,
      signature: `reminder:${reminder.dueAt}`,
      cwd: reminder.cwd,
      sessionId: reminder.sessionId,
      action: { kind: "open-session", sessionId: reminder.sessionId },
    },
  ];
}

const REPAIR_ATTENTION: Record<string, { urgency: 1 | 2; label: string }> = {
  blocked: { urgency: ATTENTION_ACTION, label: "Repair blocked" },
  uncertain: { urgency: ATTENTION_ACTION, label: "Repair result uncertain" },
  completed: { urgency: ATTENTION_INFO, label: "Repair finished" },
};

function repairItems(record: RepairRecord, sessions: Session[]): AttentionItem[] {
  const attention = REPAIR_ATTENTION[record.state];
  if (!attention) return [];
  const session = sessions.find((row) => row.id === record.session);
  // The owning conversation is gone — the record stays for reconciliation but
  // cannot be actioned; drop it from the queue rather than showing a dead row.
  if (!session) return [];
  return [
    {
      key: `repair:${record.id}`,
      kind: "repair",
      title: `${attention.label} · ${sessionDisplayTitle(session.title, session.harness)}`,
      detail: record.detail,
      urgency: attention.urgency,
      at: record.at,
      signature: `repair:${record.state}:${record.at}`,
      cwd: record.cwd,
      sessionId: session.id,
      action: { kind: "open-session", sessionId: session.id },
    },
  ];
}

/** A working copy counts as stale when Git marks it missing/prunable, or
 * when its last recorded MonoCode use is older than this. Unknown activity
 * is never stale — a fresh or externally-used copy has no recorded use. */
export const STALE_WORKTREE_AGE = 14 * 24 * 60 * 60 * 1000;

/** Small stable hash for signatures — fingerprints the stale set without
 * embedding whole paths. */
function signatureHash(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  const text = parts.join(" ");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Repository families reachable from the rail — recents, the open checkout,
 * stored project anchors and their member repositories. The shared verified
 * map also holds families probed incidentally (task worktree verification,
 * sheet locates); those must not raise cleanup rows for repositories the
 * user never added.
 */
export function railReachableFamilies(input: {
  families: ReadonlyMap<string, RepositoryFamily>;
  recents: RecentProject[];
  currentCwd: string;
  projects: readonly ProjectRecord[];
}): Map<string, RepositoryFamily> {
  const railPaths = [
    ...collectRailProjects(input.recents, input.currentCwd).values(),
  ].map((item) => item.path);
  for (const project of input.projects) {
    if (project.anchor) railPaths.push(project.anchor);
    for (const repo of project.repositories) railPaths.push(repo.anchor);
  }
  const commonDirs = new Set<string>();
  for (const path of railPaths) {
    const family = input.families.get(pathKey(path));
    if (family) commonDirs.add(pathKey(family.commonDir));
  }
  return new Map(
    [...input.families].filter(([, family]) =>
      commonDirs.has(pathKey(family.commonDir)),
    ),
  );
}

/**
 * Stale working copies → one cleanup row per repository family. A copy is
 * stale when Git marks it missing/prunable, or when its last recorded
 * MonoCode use is older than {@link STALE_WORKTREE_AGE}. Hidden, main,
 * locked and currently-open copies never nudge. The row is derived — using
 * or removing the copies clears it; nothing is deleted automatically. Its
 * action opens the worktree manager, which re-checks every entry before any
 * removal.
 */
export function worktreeCleanupAttention(input: {
  families: ReadonlyMap<string, RepositoryFamily>;
  recents: RecentProject[];
  /** Last observed session activity per checkout path — family inventory
   * only carries `lastUsed` after the worktree panel has joined session
   * evidence, so callers fold in the session summaries they already hold. */
  sessionActivity?: ReadonlyMap<string, number>;
  currentCwd?: string;
  hidden?: readonly string[];
  now?: number;
}): AttentionItem[] {
  const now = input.now ?? Date.now();
  const hiddenKeys = new Set((input.hidden ?? []).map(pathKey));
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  const lastUse = (entry: RepositoryFamily["worktrees"][number]) =>
    Math.max(
      lastWorkingCopyUse(entry, input.recents) ?? 0,
      input.sessionActivity?.get(pathKey(entry.path)) ?? 0,
    ) || null;
  for (const family of input.families.values()) {
    // Alias keys can map to a distinct probe result — dedupe on the
    // canonical common dir, not object identity.
    const familyKey = pathKey(family.commonDir);
    if (seen.has(familyKey)) continue;
    seen.add(familyKey);
    const stale = family.worktrees.filter((entry) => {
      if (entry.main) return false;
      if (hiddenKeys.has(pathKey(entry.path))) return false;
      if (input.currentCwd && isEqualOrInside(input.currentCwd, entry.path))
        return false;
      // Locked is an explicit "don't touch" — it wins over a stale or
      // missing registration too.
      if (entry.locked) return false;
      if (entry.missing || entry.prunable) return true;
      const used = lastUse(entry);
      return used !== null && now - used > STALE_WORKTREE_AGE;
    });
    if (!stale.length) continue;
    const missing = stale.filter(
      (entry) => entry.missing || entry.prunable,
    ).length;
    const uses = stale
      .map(lastUse)
      .filter((value): value is number => value !== null);
    const name = projectName(family.checkout || stale[0].path);
    // A surviving member path — `family.checkout` is not guaranteed to be a
    // verified-family map key, and the manager seeds its list from it.
    const member =
      family.worktrees.find((entry) => !entry.missing && !entry.prunable)
        ?.path ??
      family.checkout ??
      stale[0].path;
    items.push({
      key: `worktree-stale:${pathKey(family.commonDir)}`,
      kind: "worktree",
      title: `${name} · ${stale.length} stale working ${
        stale.length === 1 ? "copy" : "copies"
      }`,
      detail: [
        missing ? `${missing} missing or stale on disk` : "",
        uses.length
          ? `oldest ${workingCopyAge(Math.min(...uses), now).toLowerCase()}`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
      urgency: ATTENTION_INFO,
      // The newest stale copy's last use — stable across re-derivations, so
      // the row keeps its queue position. With no recorded use at all the
      // state-change time is unknown; 0 sorts it below dated rows.
      at: uses.length ? Math.max(...uses) : 0,
      signature: `stale:${signatureHash(
        stale
          .map(
            (entry) =>
              `${pathKey(entry.path)}:${
                entry.missing ? "m" : entry.prunable ? "p" : "s"
              }`,
          )
          .sort(),
      )}`,
      cwd: member,
      action: {
        kind: "open-worktrees",
        cwd: member,
      },
    });
  }
  return items;
}

/**
 * Everything the local session state currently wants the user to see.
 * `unseenFinishedIds` is the same set the Working rail card uses.
 */
export function deriveLocalAttention(input: {
  sessions: Session[];
  unseenFinishedIds: ReadonlySet<string>;
  reminders: SessionReminder[];
  repairs: RepairRecord[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const byId = new Set(input.unseenFinishedIds);
  for (const session of input.sessions) {
    if (session.inboxAsk) continue;
    items.push(...pendingApprovals(session));
    if (byId.has(session.id)) items.push(...finishedItems(session));
  }
  const liveSessions = new Set(input.sessions.map((session) => session.id));
  for (const reminder of input.reminders) {
    // A reminder whose session is gone produces a dead row — drop it like
    // repairItems does for orphaned records.
    if (!liveSessions.has(reminder.sessionId)) continue;
    items.push(...reminderItems(reminder));
  }
  for (const record of input.repairs) {
    items.push(...repairItems(record, input.sessions));
  }
  return items;
}
