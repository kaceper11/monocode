import { HARNESSES, type HarnessId } from "./session";
import { removeAttention, resolveAttentionWhere } from "./attention";
import { pathKey } from "./paths";
import { parseGithubWorkItemUrl } from "./sessionWorkItem";
import type { AzurePrTarget } from "./azureRepos";
import type { CiTarget } from "./azurePipelines";
import type { JiraFilter } from "./jira";
import type { AzureFilter } from "./azure";
import type { GithubTaskKind } from "./githubTasks";

/**
 * Watcher model (#23). A watcher polls one explicitly bound source — an
 * assigned-ticket query, a PR's review surface, a CI pipeline — and emits
 * AttentionItems for new events. Watchers own event detection, cursors and
 * dedup; they are foreground-only and share the queue's dispatch path rather
 * than a separate job engine.
 *
 * All fields persist under `monocode.watchers.v1` so a restart resumes with
 * the same cursor and seen-set: replayed provider events never re-notify.
 */

export type WatcherSource =
  | {
      /** Assigned issues/PRs in the GitHub repo of `cwd`. */
      kind: "github-items";
      cwd: string;
      repo: string;
      itemKind: GithubTaskKind;
    }
  | {
      /** Reviews and checks on one GitHub PR. */
      kind: "github-pr";
      cwd: string;
      repo: string;
      number: number;
      sessionId?: string;
    }
  | {
      /** Assigned Jira issues matching the saved filter. */
      kind: "jira-items";
      site: string;
      filter: JiraFilter;
    }
  | {
      /** Assigned Azure Boards items matching the saved filter. */
      kind: "azure-boards";
      site: string;
      project: string;
      filter: AzureFilter;
    }
  | {
      /** Review threads on one Azure Repos PR. */
      kind: "azure-pr";
      target: AzurePrTarget;
      projectName: string;
      repositoryName: string;
      cwd: string;
      branch: string;
      sessionId?: string;
    }
  | {
      /** Failures on one Azure Pipelines definition for this checkout. */
      kind: "azure-ci";
      target: CiTarget;
      definitionName: string;
      remote: string;
      cwd: string;
      branch: string;
      sessionId?: string;
    };

export type WatcherMode = "notify" | "draft" | "run";

export type WatcherHistoryEntry = {
  at: number;
  kind: "event" | "skip" | "error" | "run";
  text: string;
};

export type Watcher = {
  id: string;
  name: string;
  source: WatcherSource;
  enabled: boolean;
  mode: WatcherMode;
  /** Created by a produced-delivery link rather than the Watch sheet — task,
   * link and session teardown lift only these; hand-made watchers stay. */
  auto?: boolean;
  /** Saved #9 action used by draft/run modes. */
  actionId?: string;
  /** Where draft/run output goes — explicit checkout + agent. */
  target?: {
    cwd: string;
    harness: HarnessId;
    model: string;
    sessionId?: string;
  };
  /** Base cadence; idle/failure backoff stretches from here. */
  intervalSec: number;
  /** Minimum gap between automatic runs. */
  cooldownSec: number;
  /** Adapter watermark — e.g. newest seen updatedAt ISO string. */
  cursor?: string;
  /** Bounded ring of emitted event keys — replay dedup survives restart. */
  seen: string[];
  nextPollAt: number;
  failures: number;
  idleStreak: number;
  lastError?: string;
  lastPollAt?: number;
  lastEventAt?: number;
  lastRunAt?: number;
  history: WatcherHistoryEntry[];
  createdAt: number;
};

const KEY = "monocode.watchers.v1";
export const WATCHERS_CHANGED = "monocode:watchers-changed";
const MAX_WATCHERS = 50;
export const MAX_WATCHER_SEEN = 200;
export const MAX_WATCHER_HISTORY = 20;
export const WATCHER_INTERVAL_MIN = 60;
export const WATCHER_INTERVAL_MAX = 3600;
export const WATCHER_INTERVAL_DEFAULT = 300;
export const WATCHER_COOLDOWN_MIN = 300;
export const WATCHER_COOLDOWN_DEFAULT = 900;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const clean = (value: unknown, max = 2000): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

const num = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

const isSource = (value: unknown): value is WatcherSource => {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "github-items":
      return (
        !!clean(value.cwd) &&
        !!clean(value.repo) &&
        (value.itemKind === "issue" || value.itemKind === "pr")
      );
    case "github-pr":
      return (
        !!clean(value.cwd) &&
        !!clean(value.repo) &&
        Number.isInteger(value.number) &&
        (value.number as number) > 0
      );
    case "jira-items":
      return !!clean(value.site) && isRecord(value.filter);
    case "azure-boards":
      return (
        !!clean(value.site) && !!clean(value.project) && isRecord(value.filter)
      );
    case "azure-pr":
      return (
        isRecord(value.target) &&
        Number.isInteger((value.target as AzurePrTarget).number) &&
        !!clean(value.cwd) &&
        !!clean(value.branch)
      );
    case "azure-ci":
      return (
        isRecord(value.target) &&
        Number.isInteger((value.target as CiTarget).definition) &&
        !!clean(value.cwd) &&
        !!clean(value.branch)
      );
    default:
      return false;
  }
};

function sanitize(value: unknown): Watcher | null {
  if (!isRecord(value)) return null;
  const id = clean(value.id, 128);
  const name = clean(value.name, 160);
  if (!id || !name || !isSource(value.source)) return null;
  const mode =
    value.mode === "draft" || value.mode === "run" ? value.mode : "notify";
  const target =
    isRecord(value.target) && clean(value.target.cwd)
      ? {
          cwd: clean(value.target.cwd)!,
          harness: HARNESSES.includes(value.target.harness as HarnessId)
            ? (value.target.harness as HarnessId)
            : HARNESSES[0],
          model: clean(value.target.model, 120) ?? "",
          ...(clean(value.target.sessionId, 128)
            ? { sessionId: clean(value.target.sessionId, 128) }
            : {}),
        }
      : undefined;
  const history: WatcherHistoryEntry[] = [];
  if (Array.isArray(value.history)) {
    for (const entry of value.history.slice(-MAX_WATCHER_HISTORY)) {
      if (!isRecord(entry)) continue;
      const text = clean(entry.text, 500);
      const kind =
        entry.kind === "event" ||
        entry.kind === "skip" ||
        entry.kind === "error" ||
        entry.kind === "run"
          ? entry.kind
          : null;
      const at =
        typeof entry.at === "number" && Number.isFinite(entry.at)
          ? entry.at
          : 0;
      if (text && kind && at) history.push({ at, kind, text });
    }
  }
  return {
    id,
    name,
    source: value.source as WatcherSource,
    enabled: value.enabled !== false,
    mode,
    ...(value.auto === true ? { auto: true } : {}),
    ...(clean(value.actionId, 128) ? { actionId: clean(value.actionId, 128) } : {}),
    ...(target ? { target } : {}),
    intervalSec: num(
      value.intervalSec,
      WATCHER_INTERVAL_MIN,
      WATCHER_INTERVAL_MAX,
      WATCHER_INTERVAL_DEFAULT,
    ),
    cooldownSec: num(
      value.cooldownSec,
      WATCHER_COOLDOWN_MIN,
      24 * 3600,
      WATCHER_COOLDOWN_DEFAULT,
    ),
    ...(clean(value.cursor, 500) ? { cursor: clean(value.cursor, 500) } : {}),
    seen: Array.isArray(value.seen)
      ? value.seen
          .filter((entry): entry is string => typeof entry === "string")
          .slice(-MAX_WATCHER_SEEN)
      : [],
    nextPollAt:
      typeof value.nextPollAt === "number" && Number.isFinite(value.nextPollAt)
        ? value.nextPollAt
        : 0,
    failures: num(value.failures, 0, 1000, 0),
    idleStreak: num(value.idleStreak, 0, 1000, 0),
    ...(clean(value.lastError, 500)
      ? { lastError: clean(value.lastError, 500) }
      : {}),
    ...(typeof value.lastPollAt === "number" ? { lastPollAt: value.lastPollAt } : {}),
    ...(typeof value.lastEventAt === "number"
      ? { lastEventAt: value.lastEventAt }
      : {}),
    ...(typeof value.lastRunAt === "number" ? { lastRunAt: value.lastRunAt } : {}),
    history,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : Date.now(),
  };
}

export function loadWatchers(): Watcher[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Watcher[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      const watcher = sanitize(entry);
      if (!watcher || seen.has(watcher.id)) continue;
      seen.add(watcher.id);
      out.push(watcher);
      if (out.length >= MAX_WATCHERS) break;
    }
    return out;
  } catch {
    return [];
  }
}

function writeWatchers(watchers: Watcher[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(watchers));
  } catch {
    /* storage full or unavailable */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(WATCHERS_CHANGED));
  }
}

export function watchersSnapshot(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function subscribeWatchers(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener(WATCHERS_CHANGED, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(WATCHERS_CHANGED, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function saveWatcher(
  draft: Omit<Watcher, "id" | "createdAt" | "seen" | "history" | "nextPollAt" | "failures" | "idleStreak"> & Partial<Watcher>,
  existingId?: string,
): { watcher?: Watcher; error?: string } {
  const watchers = loadWatchers();
  const name = draft.name.trim().slice(0, 160);
  if (!name) return { error: "Name the watcher." };
  if (!isSource(draft.source)) return { error: "The watch source is invalid." };
  if ((draft.mode === "draft" || draft.mode === "run") && !draft.actionId?.trim())
    return { error: "Choose the action this watcher runs." };
  if (draft.mode === "run" && !draft.target?.cwd)
    return { error: "Choose the checkout the action runs in." };
  const existing = existingId
    ? watchers.find((row) => row.id === existingId)
    : undefined;
  const next: Watcher = {
    id: existingId ?? crypto.randomUUID(),
    name,
    source: draft.source,
    enabled: draft.enabled !== false,
    mode: draft.mode ?? "notify",
    ...(draft.auto === true ? { auto: true } : {}),
    ...(draft.actionId?.trim() ? { actionId: draft.actionId.trim() } : {}),
    ...(draft.target?.cwd ? { target: draft.target } : {}),
    intervalSec: num(
      draft.intervalSec,
      WATCHER_INTERVAL_MIN,
      WATCHER_INTERVAL_MAX,
      WATCHER_INTERVAL_DEFAULT,
    ),
    cooldownSec: num(
      draft.cooldownSec,
      WATCHER_COOLDOWN_MIN,
      24 * 3600,
      WATCHER_COOLDOWN_DEFAULT,
    ),
    // Edits to source/mode keep identity but reset the watermark so a
    // re-pointed watcher never silently skips the new scope's history.
    cursor:
      existing && sameSource(existing.source, draft.source)
        ? draft.cursor ?? existing.cursor
        : undefined,
    seen: existing && sameSource(existing.source, draft.source) ? existing.seen : [],
    nextPollAt: 0,
    failures: 0,
    idleStreak: 0,
    lastError: undefined,
    ...(existing?.lastPollAt ? { lastPollAt: existing.lastPollAt } : {}),
    ...(existing?.lastEventAt ? { lastEventAt: existing.lastEventAt } : {}),
    ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
    history: existing?.history ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
  };
  const list = existing
    ? watchers.map((row) => (row.id === existingId ? next : row))
    : [...watchers, next];
  if (list.length > MAX_WATCHERS) return { error: "Too many watchers." };
  writeWatchers(list);
  // A re-pointed watcher's old rows describe a source it no longer polls —
  // nothing can resolve them, so drop them with the watermark.
  if (existing && !sameSource(existing.source, next.source)) {
    resolveAttentionWhere(
      (row) => row.source?.kind === "watcher" && row.source.id === existing.id,
    );
  }
  return { watcher: next };
}

export function removeWatcher(id: string) {
  writeWatchers(loadWatchers().filter((row) => row.id !== id));
  // Emitted rows can never resolve once their watcher is gone — remove them
  // instead of leaving dead rows in the queue.
  resolveAttentionWhere(
    (row) => row.source?.kind === "watcher" && row.source.id === id,
  );
}

export function setWatcherEnabled(id: string, enabled: boolean) {
  updateWatcher(id, (watcher) => ({
    ...watcher,
    enabled,
    // Resuming polls promptly rather than waiting out an old backoff.
    nextPollAt: enabled ? 0 : watcher.nextPollAt,
    failures: enabled ? 0 : watcher.failures,
  }));
  if (!enabled) {
    // A paused watcher never recovers, so a stale "check failed" row would
    // linger forever; condition rows stay — they remain true remotely.
    removeAttention(`watcher-error:${id}`);
  }
}

/** Single-writer update helper — engine and UI both go through this. */
export function updateWatcher(
  id: string,
  update: (watcher: Watcher) => Watcher,
) {
  const watchers = loadWatchers();
  const index = watchers.findIndex((row) => row.id === id);
  if (index < 0) return;
  const next = update(watchers[index]);
  next.seen = next.seen.slice(-MAX_WATCHER_SEEN);
  next.history = next.history.slice(-MAX_WATCHER_HISTORY);
  writeWatchers(watchers.map((row, i) => (i === index ? next : row)));
}

export function watcherHistory(
  watcher: Watcher,
  entry: Omit<WatcherHistoryEntry, "at">,
  at = Date.now(),
): WatcherHistoryEntry[] {
  return [...watcher.history, { ...entry, at }].slice(-MAX_WATCHER_HISTORY);
}

/** Two watchers share one provider fetch when their poll key matches. The key
 * covers every field that shapes the emitted rows' bindings (checkout,
 * session) — sharing must never let one watcher's rows carry another's
 * checkout or owner. */
export function watcherPollKey(watcher: Watcher): string {
  const source = watcher.source;
  const session = "sessionId" in source ? `:${source.sessionId ?? ""}` : "";
  switch (source.kind) {
    case "github-items":
      return `gh-items:${source.repo}:${source.itemKind}:${source.cwd}`;
    case "github-pr":
      return `gh-pr:${source.repo}:${source.number}:${source.cwd}${session}`;
    case "jira-items":
      return `jira:${source.site}:${JSON.stringify(source.filter)}`;
    case "azure-boards":
      return `boards:${source.site}:${source.project}:${JSON.stringify(source.filter)}`;
    case "azure-pr":
      return `azure-pr:${source.target.site}:${source.target.accountId}:${source.target.project}:${source.target.repository}:${source.target.number}:${source.projectName}:${source.repositoryName}:${source.cwd}:${source.branch}${session}`;
    case "azure-ci":
      return `azure-ci:${source.target.site}:${source.target.accountId}:${source.target.project}:${source.target.definition}:${source.target.repositoryId}:${source.remote}:${source.definitionName}:${source.cwd}:${source.branch}${session}`;
  }
}

function sameSource(a: WatcherSource, b: WatcherSource): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One-line description of what a watcher polls — sheet + settings rows. */
export function watcherSourceLabel(source: WatcherSource): string {
  switch (source.kind) {
    case "github-items":
      return `GitHub ${source.itemKind === "pr" ? "pull requests" : "issues"} assigned to you in ${source.repo}`;
    case "github-pr":
      return `Reviews and checks on ${source.repo}#${source.number}`;
    case "jira-items":
      return `Jira issues${source.filter.project ? ` in ${source.filter.project}` : ""} assigned to you`;
    case "azure-boards":
      return `Azure Boards items in ${source.project || source.site} assigned to you`;
    case "azure-pr":
      return `Review threads on ${source.repositoryName || source.target.repository} !${source.target.number}`;
    case "azure-ci":
      return `Failures on ${source.definitionName || `pipeline ${source.target.definition}`} · ${source.branch}`;
  }
}

/** Fired on `window` to open the watcher sheet — surfaces emit, App hosts. */
export const OPEN_WATCH_SHEET = "monocode:open-watch-sheet";

export type WatchRepoOption = { cwd: string; repo: string };

export type WatchSheetRequest = {
  /** The source to bind — for "github-items" with `repos` the sheet asks the
   * user to pick the repository first. */
  source: WatcherSource;
  /** Suggested name, editable. */
  name: string;
  /** Repo choices for github-items sources spanning several checkouts. */
  repos?: WatchRepoOption[];
  /** Edit this watcher instead of creating a new one. */
  existing?: Watcher;
};

export function openWatchSheet(request: WatchSheetRequest) {
  // A delivery already watched — by hand or by a produced link — opens for
  // edit instead of stacking a second poller that would double-report.
  const existing = request.existing ?? deliveryWatcherFor(request.source);
  window.dispatchEvent(
    new CustomEvent<WatchSheetRequest>(OPEN_WATCH_SHEET, {
      detail: existing ? { ...request, existing } : request,
    }),
  );
}

/**
 * Produced-delivery auto-watchers. Saving a PR or CI link the user's work
 * produced registers a `notify` watcher bound to the same checkout/session,
 * so review comments and CI failures surface without a manual Watch click.
 * `auto` marks these rows: teardown paths (unlink, terminal status re-save,
 * task close, session prune) lift only auto watchers — a watcher the user
 * created by hand is never removed by them. The sheet can't re-point a
 * delivery source, so editing one keeps its managed status — delete and
 * recreate to own it.
 */

export type DeliveryWatcherSource = Extract<
  WatcherSource,
  { kind: "github-pr" | "azure-pr" | "azure-ci" }
>;

const isDeliverySource = (
  source: WatcherSource,
): source is DeliveryWatcherSource =>
  source.kind === "github-pr" ||
  source.kind === "azure-pr" ||
  source.kind === "azure-ci";

/** The same field tuples `azurePrKey`/`ciKey` build — inlined so this module
 * keeps provider imports type-only. */
const azurePrTuple = (target: AzurePrTarget) =>
  JSON.stringify([
    target.site,
    target.accountId,
    target.project,
    target.repository,
    target.number,
  ]);
const ciTuple = (target: CiTarget) =>
  JSON.stringify([
    target.site,
    target.accountId,
    target.project,
    target.definition,
    target.repositoryId,
  ]);

/** Canonical identity of the delivery a source polls. Owner fields
 * (`sessionId`) are excluded: a watcher covering the same PR or pipeline
 * under another session already serves the link, so a re-save must not stack
 * a second row on it. */
function deliveryWatchKey(source: WatcherSource): string | null {
  switch (source.kind) {
    case "github-pr":
      return `gh-pr:${source.repo.toLowerCase()}:${source.number}:${pathKey(source.cwd)}`;
    case "azure-pr":
      return `azure-pr:${azurePrTuple(source.target)}:${pathKey(source.cwd)}:${source.branch}`;
    case "azure-ci":
      return `azure-ci:${ciTuple(source.target)}:${pathKey(source.cwd)}:${source.branch}`;
    default:
      return null;
  }
}

/** Create the delivery watcher when none covers it — an existing watcher,
 * even paused or hand-made, already serves this PR/pipeline. */
export function ensureDeliveryWatcher(source: DeliveryWatcherSource): void {
  // Detached checkouts link rows without a branch — nothing pollable.
  if (!isSource(source)) return;
  const key = deliveryWatchKey(source);
  if (!key) return;
  if (
    loadWatchers().some(
      (watcher) => deliveryWatchKey(watcher.source) === key,
    )
  )
    return;
  saveWatcher({
    name: watcherSourceLabel(source),
    source,
    enabled: true,
    mode: "notify",
    auto: true,
    intervalSec: WATCHER_INTERVAL_DEFAULT,
    cooldownSec: WATCHER_COOLDOWN_DEFAULT,
  });
}

/** Two sources poll the same delivery — same PR/pipeline at one
 * checkout+branch, regardless of which session owns the link. */
export function sameDeliverySource(
  a: WatcherSource,
  b: WatcherSource,
): boolean {
  const key = deliveryWatchKey(a);
  return key !== null && key === deliveryWatchKey(b);
}

/** The watcher already covering this delivery — auto or manual, any
 * session. Non-delivery sources return nothing. */
export function deliveryWatcherFor(
  source: WatcherSource,
): Watcher | undefined {
  const key = deliveryWatchKey(source);
  if (!key) return undefined;
  return loadWatchers().find(
    (watcher) => deliveryWatchKey(watcher.source) === key,
  );
}

/** Parse a just-created GitHub PR URL into its watcher — shared by the task
 * sheet and the diff panel so both produce the identical source shape. */
export function watchGithubPrUrl(
  cwd: string,
  url: string,
  sessionId?: string,
): void {
  const parsed = parseGithubWorkItemUrl(url);
  if (parsed?.kind !== "pr") return;
  ensureDeliveryWatcher({
    kind: "github-pr",
    cwd,
    repo: parsed.repo,
    number: parsed.number,
    ...(sessionId ? { sessionId } : {}),
  });
}

function removeAutoDeliveryWatchers(
  match: (source: DeliveryWatcherSource) => boolean,
) {
  for (const watcher of loadWatchers()) {
    if (!watcher.auto || !isDeliverySource(watcher.source)) continue;
    if (match(watcher.source)) removeWatcher(watcher.id);
  }
}

/** Lift auto watchers for one delivery at one checkout+branch — any session.
 * Callers invoke this only when no stored link still covers the delivery, so
 * the watcher is orphaned regardless of which session it was bound to. */
function unwatchDelivery(
  kind: "azure-pr" | "azure-ci",
  targetKey: string,
  cwd: string,
  branch: string,
) {
  const cwdKey = pathKey(cwd);
  removeAutoDeliveryWatchers((source) => {
    if (source.kind !== kind) return false;
    const key =
      kind === "azure-pr"
        ? azurePrTuple(
            (source as Extract<WatcherSource, { kind: "azure-pr" }>).target,
          )
        : ciTuple(
            (source as Extract<WatcherSource, { kind: "azure-ci" }>).target,
          );
    return (
      key === targetKey &&
      pathKey(source.cwd) === cwdKey &&
      source.branch === branch
    );
  });
}

/** No association row still links this PR at this checkout — nothing left to
 * watch, whichever session scope the link lived in. */
export function unwatchAzurePrDelivery(
  target: AzurePrTarget,
  cwd: string,
  branch: string,
) {
  unwatchDelivery("azure-pr", azurePrTuple(target), cwd, branch);
}

/** No CI source row still links this pipeline at this checkout. */
export function unwatchCiDelivery(
  target: CiTarget,
  cwd: string,
  branch: string,
) {
  unwatchDelivery("azure-ci", ciTuple(target), cwd, branch);
}

/** What a torn-down scope's delivery watcher becomes: `false` lifts it;
 * `{ sessionId }` keeps it because a link outside the scope still covers
 * the delivery, rebinding the session owner this scope took with it. */
export type DeliverySurvival = false | { sessionId?: string };

/** Drop auto watchers bound to a gone scope — an archived or removed task's
 * sessions and working copies, or a deleted session. A checkout shared with
 * another live task still loses the watcher (coverage can't span checkouts);
 * a delivery still linked under a session outside the scope keeps its
 * watcher — watermark included — rebound to that link's session. */
export function unwatchDeliveryScope(
  scope: {
    sessionIds?: readonly string[];
    cwds?: readonly string[];
  },
  stillLinked?: (source: DeliveryWatcherSource) => DeliverySurvival,
) {
  const sessionIds = new Set(scope.sessionIds ?? []);
  const cwds = new Set((scope.cwds ?? []).map(pathKey));
  if (!sessionIds.size && !cwds.size) return;
  for (const watcher of loadWatchers()) {
    if (!watcher.auto || !isDeliverySource(watcher.source)) continue;
    const source = watcher.source;
    if (
      !(
        (source.sessionId !== undefined &&
          sessionIds.has(source.sessionId)) ||
        cwds.has(pathKey(source.cwd))
      )
    )
      continue;
    const survival = stillLinked?.(source) ?? false;
    if (survival === false) {
      removeWatcher(watcher.id);
      continue;
    }
    if (source.sessionId === survival.sessionId) continue;
    // updateWatcher — not saveWatcher — keeps the watermark: rebinding an
    // owner is not a re-point, so seen/cursor must not reset.
    const { sessionId: _dropped, ...unbound } = source;
    updateWatcher(watcher.id, (row) => ({
      ...row,
      source: survival.sessionId
        ? { ...unbound, sessionId: survival.sessionId }
        : unbound,
    }));
  }
}
