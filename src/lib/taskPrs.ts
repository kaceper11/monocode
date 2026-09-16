import type { DeliveryProvider } from "./deliveryProviders";
import type { AzurePrTarget } from "./azureRepos";
import type { GitPrCheck } from "./fs";

export const TASK_PRS_CHANGED = "monocode:task-pr-drafts";
const KEY = "monocode.taskPrDrafts.v1";
const MAX_ROWS = 100;
const RELATED_START = "<!-- monocode:related-prs:start -->";
const RELATED_END = "<!-- monocode:related-prs:end -->";
export const RELATED_PRS_MARKER = "monocode:related-prs";

export type TaskPrResult = {
  provider: DeliveryProvider;
  url: string;
  title: string;
  number?: number;
  /** True when create resolved to a pre-existing PR (Azure one-per-branch). */
  existing?: boolean;
  /** Canonical Azure identity returned by create — required for body updates. */
  azureTarget?: AzurePrTarget;
};

export type TaskPrDraft = {
  target: string;
  title: string;
  body: string;
  draft: boolean;
  provider?: DeliveryProvider;
  result?: TaskPrResult;
  updatedAt: number;
};

export const taskPrRowKey = (taskId: string, childId: string) =>
  `${taskId}:${childId}`;

export function subscribeTaskPrs(listener: () => void) {
  const handler = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  window.addEventListener(TASK_PRS_CHANGED, listener);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(TASK_PRS_CHANGED, listener);
    window.removeEventListener("storage", handler);
  };
}

// In-flight marks change no stored bytes, so the snapshot carries a version
// counter that still lets useSyncExternalStore see them.
let version = 0;

/** Blocked storage (SecurityError) must not break every subscribed surface. */
function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function taskPrsSnapshot(): string {
  return `${version}:${readRaw() ?? ""}`;
}

// The parse result is memoized against the raw string — store subscribers
// (TaskDetails rows, the PR sheet) call `all()` on every publish.
let cachedRaw: string | null = null;
let cachedRows: Record<string, TaskPrDraft> = {};

function all(): Record<string, TaskPrDraft> {
  const raw = readRaw();
  if (raw === cachedRaw) return cachedRows;
  cachedRows = parse(raw);
  cachedRaw = raw;
  return cachedRows;
}

function parse(raw: string | null): Record<string, TaskPrDraft> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, TaskPrDraft> = {};
    for (const [key, row] of Object.entries(value)) {
      if (
        !key ||
        typeof row?.target !== "string" ||
        typeof row?.title !== "string" ||
        typeof row?.body !== "string" ||
        row.target.length > 250 ||
        row.title.length > 500 ||
        row.body.length > 64_000
      )
        continue;
      out[key] = {
        target: row.target,
        title: row.title,
        body: row.body,
        draft: row.draft === true,
        provider:
          row.provider === "github" || row.provider === "azure"
            ? row.provider
            : undefined,
        result:
          row.result &&
          (row.result.provider === "github" ||
            row.result.provider === "azure") &&
          typeof row.result.url === "string" &&
          /^https?:\/\//.test(row.result.url) &&
          row.result.url.length <= 2048
            ? {
                provider: row.result.provider,
                url: row.result.url,
                title: String(row.result.title ?? "").slice(0, 500),
                number: Number.isInteger(row.result.number)
                  ? row.result.number
                  : undefined,
                existing: row.result.existing === true,
                azureTarget:
                  row.result.provider === "azure" &&
                  row.result.azureTarget &&
                  [
                    row.result.azureTarget.site,
                    row.result.azureTarget.accountId,
                    row.result.azureTarget.project,
                    row.result.azureTarget.repository,
                  ].every((field) => typeof field === "string") &&
                  Number.isInteger(row.result.azureTarget.number)
                    ? {
                        site: row.result.azureTarget.site,
                        accountId: row.result.azureTarget.accountId,
                        project: row.result.azureTarget.project,
                        repository: row.result.azureTarget.repository,
                        number: row.result.azureTarget.number,
                      }
                    : undefined,
              }
            : undefined,
        updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function loadTaskPrDraft(
  taskId: string,
  childId: string,
): TaskPrDraft | null {
  return all()[taskPrRowKey(taskId, childId)] ?? null;
}

/** All rows at once — memoize against `taskPrsSnapshot()` instead of calling
 * `loadTaskPrDraft` per row per render. */
export function listTaskPrDrafts(): Record<string, TaskPrDraft> {
  return all();
}

export function saveTaskPrDraft(
  taskId: string,
  childId: string,
  patch: Partial<Omit<TaskPrDraft, "updatedAt" | "provider" | "result">> & {
    provider?: DeliveryProvider | null;
    result?: TaskPrResult | null;
  },
) {
  // Copy — mutating the memoized rows before setItem lands would leave the
  // cache claiming a save storage never took.
  const rows = { ...all() };
  const key = taskPrRowKey(taskId, childId);
  const previous = rows[key] ?? {
    target: "",
    title: "",
    body: "",
    draft: false,
  };
  rows[key] = {
    ...previous,
    ...patch,
    provider:
      patch.provider === undefined
        ? previous.provider
        : (patch.provider ?? undefined),
    result:
      patch.result === undefined
        ? previous.result
        : (patch.result ?? undefined),
    // Strictly increasing so the newest write always wins eviction, even when
    // several saves land inside one Date.now() tick.
    updatedAt: Math.max(
      Date.now(),
      ...Object.values(rows).map((row) => row.updatedAt + 1),
    ),
  };
  const entries = Object.entries(rows)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_ROWS);
  const next = Object.fromEntries(entries);
  localStorage.setItem(KEY, JSON.stringify(next));
  cachedRows = next;
  cachedRaw = readRaw();
  window.dispatchEvent(new Event(TASK_PRS_CHANGED));
}

/** Deletes run inside task teardown — a blocked-storage throw must not abort
 * the removal and orphan watchers the caller was about to lift. */
function writeRowsBestEffort(rows: Record<string, TaskPrDraft>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    return;
  }
  cachedRows = rows;
  cachedRaw = readRaw();
  window.dispatchEvent(new Event(TASK_PRS_CHANGED));
}

export function deleteTaskPrDraft(taskId: string, childId: string) {
  const rows = all();
  const key = taskPrRowKey(taskId, childId);
  if (!(key in rows)) return;
  const { [key]: _dropped, ...rest } = rows;
  writeRowsBestEffort(rest);
}

/** Drops every draft a task owns — removal paths keep no orphaned rows. */
export function deleteTaskPrDraftsFor(taskId: string) {
  const rows = all();
  const prefix = `${taskId}:`;
  const rest = Object.fromEntries(
    Object.entries(rows).filter(([key]) => !key.startsWith(prefix)),
  );
  if (Object.keys(rest).length === Object.keys(rows).length) return;
  writeRowsBestEffort(rest);
}

// In-flight creations are tracked outside the sheet so closing it mid-run
// still reflects the operation when reopened; the invoke writes the result.
const creating = new Set<string>();
export const isTaskPrCreating = (taskId: string, childId: string) =>
  creating.has(taskPrRowKey(taskId, childId));
export function markTaskPrCreating(
  taskId: string,
  childId: string,
  on: boolean,
) {
  const key = taskPrRowKey(taskId, childId);
  if (on) creating.add(key);
  else creating.delete(key);
  version += 1;
  window.dispatchEvent(new Event(TASK_PRS_CHANGED));
}

export type RelatedPr = { repo: string; title: string; url: string };

/** Why a row cannot create a PR right now, or null when it is ready. */
export function prRowBlocker(
  check: GitPrCheck,
  target: string,
): string | null {
  if (!check.branch) return "Not on a branch (detached HEAD).";
  if (check.branch === target)
    return "Source and target are the same branch.";
  if (!check.remote) return "No git remote configured.";
  if (check.dirtyFiles > 0)
    return `${check.dirtyFiles}${check.dirtyLimited ? "+" : ""} uncommitted ${
      check.dirtyFiles === 1 && !check.dirtyLimited ? "change" : "changes"
    } — commit or stash first.`;
  if (!check.targetExists) return `No branch named ${target}.`;
  if (check.ahead === 0)
    return `${check.branch} has no commits ahead of ${target}.`;
  return null;
}

/** Fallback PR body when no text harness can draft one. */
export function prCommitBody(commits: string[]): string {
  const items = commits.slice(0, 20);
  return [
    "## Summary",
    ...(items.length
      ? items.map((commit) => `- ${commit}`)
      : ["- See commits."]),
    "",
    "## Testing",
    "- Not run",
  ].join("\n");
}

const safe = (value: string) =>
  value.replace(/[[\]`*_<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);

/** Splice the managed related-PRs section into `body`. Entries must already be
 * filtered to siblings sharing this PR's target; an empty list strips any
 * existing section so a now-standalone PR doesn't keep a stale block. */
export function withRelatedPrs(body: string, entries: RelatedPr[]): string {
  const start = body.indexOf(RELATED_START);
  const end = body.indexOf(RELATED_END);
  const base = (
    start !== -1 && end !== -1 && end > start
      ? body.slice(0, start) + body.slice(end + RELATED_END.length)
      : // A marker whose pair was hand-deleted would otherwise ride along
        // with every rewrite.
        body.replace(RELATED_START, "").replace(RELATED_END, "")
  ).trimEnd();
  const usable = entries
    .filter(
      (entry) =>
        /^https?:\/\//.test(entry.url) && !/\s/.test(entry.url) && entry.url.length <= 2048,
    )
    .slice(0, 20);
  if (usable.length === 0) return base;
  const lines = usable
    .map((entry) => `- **${safe(entry.repo)}** — [${safe(entry.title)}](${entry.url})`)
    .join("\n");
  const section = `${RELATED_START}\n## Related pull requests\n${lines}\n${RELATED_END}`;
  return base ? `${base}\n\n${section}` : section;
}
