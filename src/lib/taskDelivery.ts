import {
  allAzurePrAssociations,
  azurePrKey,
  type AzurePrAssociation,
} from "./azureRepos";
import {
  allCiSources,
  ciKey,
  ciMatches,
  ciState,
  type CiSource,
} from "./azurePipelines";
import type { GitPr } from "./fs";
import { pathKey } from "./paths";
import type { TaskDeliveryRef } from "./taskCi";
import {
  taskSessionIds,
  type TaskChild,
  type TaskWorkspace,
} from "./taskWorkspaces";

/**
 * Compact delivery state for one task child — counts and attention flags only,
 * never provider payloads. Derived from saved provider links plus whatever
 * fresh data the caller already holds; this module never fetches.
 */
export type TaskChildDelivery = {
  /** Linked pull requests still open/active, across providers. */
  prs: number;
  /** A linked PR is waiting on the author (Azure reviewer vote < 0). */
  prNeedsAttention: boolean;
  /** Linked CI pipelines for this checkout. */
  ci: number;
  /** A linked pipeline's latest verified run is queued/running. */
  ciRunning: boolean;
  /** A linked pipeline's latest verified run failed. */
  ciFailing: boolean;
};

export const EMPTY_DELIVERY: TaskChildDelivery = {
  prs: 0,
  prNeedsAttention: false,
  ci: 0,
  ciRunning: false,
  ciFailing: false,
};

const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, "");

/** Saved provider links, parsed once — pass to every childDelivery call in a
 * loop so an N-child task costs one storage read, not N. */
export type DeliveryStores = {
  prs: AzurePrAssociation[];
  ci: CiSource[];
};

export function deliveryStores(): DeliveryStores {
  return { prs: allAzurePrAssociations(), ci: allCiSources() };
}

/**
 * The saved provider links matched to one child checkout — the rows behind
 * `childDelivery`'s counts, for callers (task details) that render the links
 * themselves rather than a badge. Every status is kept; counting callers
 * filter to the states they report.
 */
export type ChildDeliveryLinks = {
  /** Matched Azure PR associations, any status. */
  prs: AzurePrAssociation[];
  /** The caller-supplied GitHub PR for this branch, if any. */
  githubPr: GitPr | null;
  /** Matched CI sources. */
  ci: CiSource[];
};

/**
 * Delivery links saved against one child checkout.
 *
 * `branches` are the names this child may be known under — the recorded
 * `child.branch` plus the observed head from diff stats/index. Links for the
 * recorded branch keep counting even when the checkout moved on: they belong
 * to the child's task branch, not to whatever someone checked out meanwhile.
 * A saved link counts when its scope session belongs to this task (or is
 * unassigned) and its own branch — or the PR's source ref — names a known
 * branch. With no known branch the child's links stay unknown rather than
 * guessed.
 */
export function childDeliveryLinks(
  task: TaskWorkspace,
  child: TaskChild,
  branches: readonly (string | null | undefined)[],
  githubPr?: GitPr | null,
  stores: DeliveryStores = deliveryStores(),
): ChildDeliveryLinks {
  const sessions = taskSessionIds(task);
  return deliveryLinksFor(
    child.workingCopy,
    branches,
    (session) => session === undefined || sessions.has(session),
    githubPr,
    stores,
  );
}

/** Delivery saved against an arbitrary working copy — e.g. the checkout a
 * related inbox thread sits in. Scoped to that copy's branch plus links
 * recorded from the given sessions (or left unassigned). */
export function sessionDeliveryLinks(input: {
  cwd: string;
  /** Current branch plus any recorded fallbacks (sessions keep one). */
  branches: readonly (string | null | undefined)[];
  sessionIds: readonly string[];
  githubPr?: GitPr | null;
  stores?: DeliveryStores;
}): ChildDeliveryLinks {
  const sessions = new Set(input.sessionIds);
  return deliveryLinksFor(
    input.cwd,
    input.branches,
    (session) => session === undefined || sessions.has(session),
    input.githubPr,
    input.stores ?? deliveryStores(),
  );
}

/** Link matching shared by task children and ad-hoc working copies (e.g. a
 * related inbox thread's checkout). `scoped` decides which saved links'
 * recorded session may count; `undefined` means unassigned links always do. */
function deliveryLinksFor(
  cwd: string | undefined,
  branches: readonly (string | null | undefined)[],
  scoped: (session: string | undefined) => boolean,
  githubPr: GitPr | null | undefined,
  stores: DeliveryStores,
): ChildDeliveryLinks {
  const links: ChildDeliveryLinks = { prs: [], githubPr: githubPr ?? null, ci: [] };
  if (!cwd) return links;
  const cwdKey = pathKey(cwd);
  const known = new Set(branches.filter((b): b is string => !!b));
  if (!known.size) return links;

  // The same link can be saved under several matching scopes (unassigned
  // plus one or more task sessions) — dedupe on the provider identity.
  const seenPrs = new Set<string>();
  for (const row of stores.prs) {
    if (pathKey(row.cwd) !== cwdKey || !scoped(row.sourceSessionId)) continue;
    if (!known.has(row.branch) && !known.has(shortRef(row.pr.sourceRefName)))
      continue;
    const key = azurePrKey(row.target);
    if (seenPrs.has(key)) continue;
    seenPrs.add(key);
    links.prs.push(row);
  }

  const seenCi = new Map<string, number>();
  for (const row of stores.ci) {
    if (pathKey(row.cwd) !== cwdKey || !scoped(row.session)) continue;
    if (
      !known.has(row.branch) &&
      !known.has(shortRef(row.last?.run.branch ?? ""))
    )
      continue;
    const key = ciKey(row.target);
    const existing = seenCi.get(key);
    if (existing !== undefined) {
      // Duplicate scope — keep the copy with the freshest verified run.
      if (
        (row.last?.checkedAt ?? 0) >
        (links.ci[existing].last?.checkedAt ?? 0)
      )
        links.ci[existing] = row;
      continue;
    }
    seenCi.set(key, links.ci.length);
    links.ci.push(row);
  }
  return links;
}

/**
 * Delivery links saved against one child checkout — counts and attention
 * flags over {@link childDeliveryLinks} plus the caller's cached GitHub PR.
 */
export function childDelivery(
  task: TaskWorkspace,
  child: TaskChild,
  branches: readonly (string | null | undefined)[],
  githubPr?: GitPr | null,
  stores: DeliveryStores = deliveryStores(),
): TaskChildDelivery {
  const delivery = { ...EMPTY_DELIVERY };
  if (!child.workingCopy || !branches.some(Boolean)) return delivery;
  return deliveryFromLinks(
    childDeliveryLinks(task, child, branches, githubPr, stores),
  );
}

/** Counts/attention flags from already-resolved links — for callers that
 * render the links themselves and shouldn't pay a second store scan. */
export function deliveryFromLinks(links: ChildDeliveryLinks): TaskChildDelivery {
  const delivery = { ...EMPTY_DELIVERY };
  for (const row of links.prs) {
    if (row.pr.status.toLowerCase() !== "active") continue;
    delivery.prs += 1;
    if (row.pr.reviewers.some((reviewer) => reviewer.vote < 0))
      delivery.prNeedsAttention = true;
  }
  if (links.githubPr && links.githubPr.state.toLowerCase() === "open")
    delivery.prs += 1;

  for (const row of links.ci) {
    delivery.ci += 1;
    const run = row.last?.run;
    if (!run || !ciMatches(run)) continue;
    const state = ciState(run.status, run.result);
    if (state === "Failed") delivery.ciFailing = true;
    else if (state === "Queued" || state === "Running" || state === "Cancelling")
      delivery.ciRunning = true;
  }
  return delivery;
}

/** A badge's click target — a child plus the delivery ref that opens its
 * review surface. */
export type TaskDeliveryTarget = {
  child: TaskChild;
  ref: TaskDeliveryRef;
};

export type TaskDeliveryOverview = {
  prs: number;
  ci: number;
  ciRunning: boolean;
  /** An open/active PR has a negative reviewer vote. */
  prAttention: boolean;
  /** A linked pipeline's latest verified run failed. */
  ciFailing: boolean;
  /** Attention PR first, else any open PR — the badge's click target. */
  prTarget?: TaskDeliveryTarget;
  /** Failing pipeline first, else any linked one. */
  ciTarget?: TaskDeliveryTarget;
};

/**
 * Aggregate delivery over every child with a working copy — the counts the
 * rail menu's badges show plus the single best click target per kind.
 * `resolve` supplies the caller's branch/GitHub-PR peeks so the aggregation
 * stays synchronous and never fetches.
 */
export function taskDeliveryOverview(
  task: TaskWorkspace,
  resolve: (child: TaskChild) => {
    branches: readonly (string | null | undefined)[];
    githubPr?: GitPr | null;
  },
  stores: DeliveryStores = deliveryStores(),
): TaskDeliveryOverview {
  let prs = 0;
  let ci = 0;
  let ciRunning = false;
  let prAny: TaskDeliveryTarget | undefined;
  let prAttention: TaskDeliveryTarget | undefined;
  let ciAny: TaskDeliveryTarget | undefined;
  let ciFailing: TaskDeliveryTarget | undefined;
  for (const child of task.children) {
    if (!child.workingCopy) continue;
    const { branches, githubPr } = resolve(child);
    const links = childDeliveryLinks(task, child, branches, githubPr, stores);
    const delivery = deliveryFromLinks(links);
    prs += delivery.prs;
    ci += delivery.ci;
    ciRunning ||= delivery.ciRunning;
    const active = links.prs.filter(
      (row) => row.pr.status.toLowerCase() === "active",
    );
    if (active.some((row) => row.pr.reviewers.some((vote) => vote.vote < 0)))
      prAttention ??= { child, ref: { kind: "pr" } };
    if (!prAny) {
      if (active.length) prAny = { child, ref: { kind: "pr" } };
      else if (links.githubPr && links.githubPr.state.toLowerCase() === "open")
        prAny = {
          child,
          ref: {
            kind: "pr",
            provider: "github",
            number: links.githubPr.number,
          },
        };
    }
    if (delivery.ci > 0) {
      ciAny ??= { child, ref: { kind: "ci" } };
      if (delivery.ciFailing) ciFailing ??= { child, ref: { kind: "ci" } };
    }
  }
  return {
    prs,
    ci,
    ciRunning,
    prAttention: !!prAttention,
    ciFailing: !!ciFailing,
    prTarget: prAttention ?? prAny,
    ciTarget: ciFailing ?? ciAny,
  };
}

/**
 * Short status phrases for a whole task, most actionable first — e.g.
 * "1 needs input", "CI failing", "2 working". Empty when nothing is
 * reportable (all children idle/ready). Derived per child so several
 * repositories can each contribute; the caller renders them joined.
 */
export function taskStatusSegments(
  task: TaskWorkspace,
  opts: {
    /** Sessions currently mid-turn (live agents, not done). */
    busySessionIds?: ReadonlySet<string>;
    /** Sessions blocked on approval/question. */
    needsInputIds?: ReadonlySet<string>;
    /** Per-child delivery from childDelivery; omit for session-only state. */
    delivery?: ReadonlyMap<string, TaskChildDelivery>;
    /** Skip the "N working" segment — e.g. a row that already shows its own
     * Working badge. Prefer this over filtering the strings afterwards. */
    dropWorking?: boolean;
  } = {},
): string[] {
  const sessions = taskSessionIds(task);
  const segments: string[] = [];

  const needsInput = [...sessions].filter((id) =>
    opts.needsInputIds?.has(id),
  ).length;
  if (needsInput)
    segments.push(
      needsInput === 1 ? "1 needs input" : `${needsInput} need input`,
    );

  let ciFailing = 0;
  let prAttention = 0;
  let ciRunning = 0;
  for (const child of task.children) {
    const delivery = opts.delivery?.get(child.id);
    if (!delivery) continue;
    if (delivery.ciFailing) ciFailing += 1;
    if (delivery.prNeedsAttention) prAttention += 1;
    if (delivery.ciRunning) ciRunning += 1;
  }
  if (ciFailing)
    segments.push(ciFailing === 1 ? "CI failing" : `CI failing ×${ciFailing}`);
  if (prAttention)
    segments.push(
      prAttention === 1 ? "PR needs review" : `${prAttention} PRs need review`,
    );

  const failed = task.children.filter(
    (child) => child.launch.state === "failed",
  ).length;
  if (failed)
    segments.push(failed === 1 ? "1 failed" : `${failed} failed`);

  const working = [...sessions].filter((id) =>
    opts.busySessionIds?.has(id),
  ).length;
  if (working && !opts.dropWorking)
    segments.push(working === 1 ? "1 working" : `${working} working`);
  else if (!working && ciRunning) segments.push("CI running");

  const preparing = task.children.filter(
    (child) => child.launch.state === "working",
  ).length;
  if (preparing)
    segments.push(
      preparing === 1 ? "1 preparing" : `${preparing} preparing`,
    );

  const unprepared = task.children.filter(
    (child) => !child.workingCopy && child.launch.state === "pending",
  ).length;
  if (unprepared)
    segments.push(
      unprepared === 1 ? "1 to prepare" : `${unprepared} to prepare`,
    );

  return segments;
}
