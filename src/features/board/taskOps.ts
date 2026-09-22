import {
  gitBehindBase,
  gitBranches,
  gitMergeFrom,
  gitMergeInProgress,
  gitPrChecks,
  gitPrCreate,
  gitPrStatus,
  gitPrUpdate,
  gitPush,
  gitRemotes,
} from "../../platform/tauri/fs";
import {
  azureDevOpsPrCreate,
  azureDevOpsPrProbe,
  azureDevOpsPrUpdateBody,
  azureDevOpsRepoMatch,
} from "../inbox/model/azureDevOps";
import type { LinkedWorkItem } from "../sessions/model/session";
import type { BoardTask, TaskWorkstream } from "./boardStore";
import { prIsOpen, type WorkstreamStatus } from "./boardData";

export { prIsOpen };

/**
 * Task-level IO — workstream PR/CI probes and the bulk git operations the
 * details panel exposes. Everything else on the board stays a pure join.
 * PR/CI calls route per worktree: Azure DevOps remotes go through the
 * `azure_devops_*` commands, everything else through upstream's `gh`-backed
 * `git_pr_*` surface.
 */

/** The PR-create surface for one worktree — Azure when its remote resolves
 * to the configured org, GitHub/`gh` otherwise. An Azure-shaped remote that
 * isn't configured throws a readable error rather than falling to `gh`. */
async function prOps(cwd: string) {
  const azure = await azureDevOpsRepoMatch(cwd);
  return azure
    ? {
        // The probe surface is the one that honours a pinned `prUrl`.
        status: (path: string, prUrl?: string, branch?: string) =>
          azureDevOpsPrProbe(path, prUrl, branch).then((probe) => probe.pr),
        create: azureDevOpsPrCreate,
        // Azure PRs carry their id in the web url (`…/pullrequest/42`) —
        // patch that exact PR, not whatever is newest on the branch now.
        updateBody: (path: string, url: string, body: string) =>
          azureDevOpsPrUpdateBody(
            path,
            body,
            Number(/pullrequest\/(\d+)/.exec(url)?.[1]) || undefined,
          ),
      }
    : {
        status: gitPrStatus,
        create: gitPrCreate,
        updateBody: gitPrUpdate,
      };
}

/** Probe one workstream's PR + checks on the checked-out branch. A lane
 * whose worktree was cleaned up after merge keeps probing via the project
 * root — a pinned `prUrl` resolves against the repo, not the worktree. */
export async function probeWorkstream(
  workstream: TaskWorkstream,
): Promise<WorkstreamStatus | null> {
  // Review lanes pin their PR — the local `pr/<N>` branch never matches
  // the PR's real head name for a branch-based probe to find it.
  const prUrl = workstream.prUrl?.trim() || undefined;
  const worktree = workstream.worktreePath?.trim() || undefined;
  const cwd = worktree ?? (prUrl ? workstream.projectPath : undefined);
  if (!cwd) return null;
  try {
    // Local-worktree signals are meaningless against the project fallback.
    const merging = worktree
      ? gitMergeInProgress(cwd).catch(() => false)
      : Promise.resolve(false);
    // Behind-base is local refs only — it must never fetch per lane.
    const behind = worktree
      ? gitBehindBase(cwd, workstream.base).catch(() => 0)
      : Promise.resolve(0);
    if (await azureDevOpsRepoMatch(cwd)) {
      // PR + pipelines in one round trip; Azure branch builds exist pre-PR.
      // Pass the lane's branch — the cwd may be the project root after a
      // post-merge cleanup, whose checkout isn't this lane's branch.
      return {
        ...(await azureDevOpsPrProbe(cwd, prUrl, workstream.branch)),
        merging: await merging,
        behind: await behind,
      };
    }
    const pr = await gitPrStatus(cwd, prUrl);
    const checks = pr ? await gitPrChecks(cwd, prUrl).catch(() => []) : [];
    return { pr, checks, merging: await merging, behind: await behind };
  } catch (error) {
    // Keep a visible failure — a deleted worktree or missing `gh` must not
    // silently erase the row's PR/CI state.
    return {
      pr: null,
      checks: [],
      error: String(error).replace(/^Error:\s*/, "").split("\n")[0].slice(0, 120),
    };
  }
}

/** Provider-side ref that holds a PR's head — `git fetch <remote>
 * <ref>:refs/heads/pr/<N>` turns an inbox PR into a local branch for the
 * "review locally" lane. GitHub exposes `refs/pull/<N>/head` on the base
 * repo (fork PRs included); GitLab uses `refs/merge-requests/<N>/head`.
 * Azure advertises no head ref — the author's source branch is the real
 * head; `refs/pull/<N>/merge` is the fallback (absent under conflicts). */
export function prHeadRemoteRef(
  provider: "github" | "gitlab" | "azuredevops",
  number: number,
  sourceRefName?: string,
): string {
  if (provider === "gitlab") return `refs/merge-requests/${number}/head`;
  if (provider === "azuredevops") {
    // An empty sourceRefName isn't a ref — fall back to the merge ref.
    const source = sourceRefName?.trim();
    return source || `refs/pull/${number}/merge`;
  }
  return `refs/pull/${number}/head`;
}

export type WorkstreamResult = {
  workstreamId: string;
  ok: boolean;
  message: string;
  /** The update left the worktree mid-merge — offer agent resolution. */
  conflict?: boolean;
};

const shortError = (error: unknown) =>
  String(error).replace(/^Error:\s*/, "").split("\n")[0].slice(0, 160);

const branchMismatch = (workstream: TaskWorkstream, actual: string) =>
  `Worktree is on ${actual || "another branch"}, expected ${workstream.branch}`;

/** Current branch + configured remote names. `git remote` is authoritative —
 * a configured-but-never-fetched remote has no tracking refs to infer from. */
async function gitContext(cwd: string) {
  const [branches, remotes] = await Promise.all([
    gitBranches(cwd),
    gitRemotes(cwd),
  ]);
  return { branch: branches.current ?? "", remotes: new Set(remotes) };
}

/** Fetch + merge the workstream's base ref into its branch. Runs in the
 * worktree only — and only after proving the worktree is on the task's
 * branch, since the user may have switched it in a terminal. */
export async function updateWorkstreamFromBase(
  workstream: TaskWorkstream,
): Promise<WorkstreamResult> {
  const cwd = workstream.worktreePath;
  if (!cwd) {
    return {
      workstreamId: workstream.id,
      ok: false,
      message: "No worktree yet",
    };
  }
  try {
    const context = await gitContext(cwd);
    if (context.branch !== workstream.branch) {
      return {
        workstreamId: workstream.id,
        ok: false,
        message: branchMismatch(workstream, context.branch),
      };
    }
    await gitMergeFrom(cwd, workstream.base);
    return {
      workstreamId: workstream.id,
      ok: true,
      message: `Merged ${workstream.base}`,
    };
  } catch (error) {
    const message = shortError(error);
    // MERGE_HEAD is the authoritative conflict signal — error text alone
    // can't distinguish a real conflict from "uncommitted changes block
    // merge" or a fetch failure.
    const conflict = await gitMergeInProgress(cwd).catch(() => false);
    return {
      workstreamId: workstream.id,
      ok: false,
      conflict,
      message: conflict
        ? `Conflict merging ${workstream.base} — resolve in the worktree`
        : message,
    };
  }
}

/** Prompt sent to a lane's session to resolve an in-progress merge. Instructs
 * a real merge of both sides — not "ours" or "theirs" — so incoming base
 * changes and the branch's work both survive. */
export function resolveConflictPrompt(row: {
  branch: string;
  base: string;
}): string {
  return [
    `Merging \`${row.base}\` into \`${row.branch}\` left conflicts in this worktree.`,
    `Resolve each conflicted file by combining both sides — keep the current branch's changes and integrate the incoming \`${row.base}\` changes; don't just pick one side.`,
    "Then commit the merge with the default message and run the project's checks if they're quick. Report what you resolved and any judgment calls.",
  ].join(" ");
}

/** Pre-submit PR validation — turns the provider's create-time rejections
 * ("head sha can't be blank", "no commits between") into lane messages before
 * the user submits. Returns the problem text, or null when the lane can
 * produce a PR. */
export function laneProblem(
  row: { branch: string; worktreePath?: string },
  base: string,
  preflight: {
    head: string | null;
    baseRef: string | null;
    baseBranch: string;
    baseOnRemote: boolean;
    ahead: number;
    hasRemote: boolean;
  },
): string | null {
  if (!row.worktreePath) return "No worktree — spawn a session first";
  if (preflight.head !== row.branch)
    return `Worktree is on ${preflight.head || "a detached HEAD"}, expected ${row.branch}`;
  if (!preflight.hasRemote) return "No git remote — nowhere to create a PR";
  // `baseBranch` is the resolved name — a `HEAD` base becomes the remote's
  // default branch, so messages name the real target.
  const name = preflight.baseBranch || base;
  if (!preflight.baseRef)
    return preflight.baseBranch
      ? `Base branch ${preflight.baseBranch} doesn't exist`
      : "Couldn't resolve a base branch — pick one";
  if (!preflight.baseOnRemote)
    return `Base branch ${name} isn't on the remote — push it first`;
  // A remote-qualified pick of the lane's own branch resolves to itself.
  if (preflight.baseBranch === row.branch)
    return "Target is the same branch as the source";
  if (preflight.ahead === 0) return `No commits ahead of ${name}`;
  return null;
}

function ticketLine(link: LinkedWorkItem): string {
  const ref =
    link.identifier ||
    (link.provider === "azuredevops" && link.number
      ? `AB#${link.number}`
      : `#${link.number}`);
  return `- ${ref}${link.title ? ` — ${link.title}` : ""}${link.url ? ` (${link.url})` : ""}`;
}

/**
 * PR body template — `{task}` `{branch}` `{base}` substitute per lane;
 * `{tickets}` `{prs}` `{branches}` expand to headed bullet sections that drop
 * out entirely when empty. The default reproduces the generated body.
 */
export const DEFAULT_PR_TEMPLATE =
  "Part of task: **{task}**\n\n{tickets}\n\n{prs}\n\n{branches}";

export function renderPrBody(
  task: BoardTask,
  workstream: TaskWorkstream,
  siblings: readonly string[],
  base: string,
  template: string = DEFAULT_PR_TEMPLATE,
): string {
  const section = (heading: string, lines: string[]) =>
    lines.length ? `${heading}:\n${lines.join("\n")}` : "";
  const others = task.workstreams.filter((ws) => ws.id !== workstream.id);
  const values: Record<string, string> = {
    task: task.title,
    branch: workstream.branch,
    base,
    tickets: section(
      "Tickets",
      task.links.map(ticketLine),
    ),
    prs: section(
      "Related pull requests",
      siblings.map((s) => `- ${s}`),
    ),
    branches: section(
      "Related branches",
      others.map((ws) => `- \`${ws.branch}\``),
    ),
  };
  return template
    .replace(/\{(\w+)\}/g, (token, name: string) => values[name] ?? token)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Create a PR per workstream that doesn't have one, then patch bodies with
 * the sibling URLs (they only exist once creation returns). `only` restricts
 * creation to specific workstreams while keeping the full task context —
 * sibling branches and existing PR URLs — in the body. Each workstream
 * routes to its own provider (Azure DevOps or GitHub via `gh`).
 */
export type PrCreateOptions = {
  /** Override the task title used as every PR title. */
  title?: string;
  /** `renderPrBody` template — the dialog's editable body. */
  body?: string;
  /** Per-lane target branch overrides, keyed by workstream id. */
  bases?: ReadonlyMap<string, string>;
  /** Per-lane description text prepended to the rendered body. */
  descriptions?: ReadonlyMap<string, string>;
  /** Create as draft — GitHub `--draft`, Azure `isDraft`. */
  draft?: boolean;
};

/** One lane's PR body — the lane's own description ahead of the shared
 * template render. Sibling PR URLs always land in the body, even when a
 * custom template drops `{prs}` — the links are how lanes cross-reference. */
export function composePrBody(
  task: BoardTask,
  workstream: TaskWorkstream,
  siblings: readonly string[],
  base: string,
  opts?: PrCreateOptions,
): string {
  const description = opts?.descriptions?.get(workstream.id)?.trim();
  let body = renderPrBody(task, workstream, siblings, base, opts?.body);
  if (siblings.length && !siblings.some((url) => body.includes(url))) {
    body += `\n\nRelated pull requests:\n${siblings
      .map((url) => `- ${url}`)
      .join("\n")}`;
  }
  return description ? `${description}\n\n${body}` : body;
}

export async function createTaskPrs(
  task: BoardTask,
  status: ReadonlyMap<string, WorkstreamStatus>,
  only?: ReadonlySet<string>,
  opts?: PrCreateOptions,
): Promise<WorkstreamResult[]> {
  const results: WorkstreamResult[] = [];
  const created: { ws: TaskWorkstream; url: string; base: string }[] = [];
  // URLs found at submit time (a PR created outside since the last probe) —
  // they join the sibling links so bodies cross-link them too.
  const discovered = new Map<string, string>();
  // Every known sibling URL — probed PRs plus ones created earlier in this
  // run — so bodies cross-link even for a single-lane creation.
  const knownUrls = () => {
    const urls = new Map<string, string>();
    for (const ws of task.workstreams) {
      const existing = status.get(ws.id)?.pr?.url;
      if (existing) urls.set(ws.id, existing);
    }
    for (const entry of created) urls.set(entry.ws.id, entry.url);
    for (const [id, url] of discovered) urls.set(id, url);
    return urls;
  };
  for (const ws of task.workstreams) {
    if (only && !only.has(ws.id)) continue;
    const cwd = ws.worktreePath;
    if (!cwd) {
      results.push({
        workstreamId: ws.id,
        ok: false,
        message: "No worktree yet",
      });
      continue;
    }
    const probed = status.get(ws.id)?.pr;
    if (probed && prIsOpen(probed.state)) {
      results.push({ workstreamId: ws.id, ok: true, message: "PR exists" });
      continue;
    }
    try {
      // The worktree must still be on the task's branch — the push sends
      // whatever is checked out, so verify before pushing anything.
      const context = await gitContext(cwd);
      if (context.branch !== ws.branch)
        throw new Error(branchMismatch(ws, context.branch));
      if (!context.remotes.size) throw new Error("No git remote");
      const ops = await prOps(cwd);
      // Push-only: a pull mid-submit could leave merge commits (or a
      // conflicted MERGE_HEAD) nobody asked for. A rejected non-ff push
      // tells the user to Update the lane first.
      await gitPush(cwd);
      const found = await ops.status(cwd, ws.prUrl);
      if (found && prIsOpen(found.state)) {
        discovered.set(ws.id, found.url);
        results.push({
          workstreamId: ws.id,
          ok: true,
          message: "PR exists",
        });
        continue;
      }
      // The chosen target may be remote-qualified ("origin/main") or a
      // plain branch — including branches with slashes ("release/1.2").
      // Strip only a real remote prefix, never the first path segment.
      const chosenBase = opts?.bases?.get(ws.id) ?? ws.base;
      const base = [...context.remotes].some((remote) =>
        chosenBase.startsWith(`${remote}/`),
      )
        ? chosenBase.slice(chosenBase.indexOf("/") + 1)
        : chosenBase;
      if (!base || base === "HEAD")
        throw new Error("Pick a base branch for the pull request");
      const siblings = [...knownUrls().entries()]
        .filter(([id]) => id !== ws.id)
        .map(([, url]) => url);
      const url = await ops.create(
        cwd,
        opts?.title?.trim() || task.title,
        composePrBody(task, ws, siblings, base, opts),
        base,
        ws.branch,
        opts?.draft ?? false,
      );
      created.push({ ws, url, base });
      results.push({
        workstreamId: ws.id,
        ok: true,
        message: opts?.draft ? "Draft PR created" : "PR created",
      });
    } catch (error) {
      results.push({ workstreamId: ws.id, ok: false, message: shortError(error) });
    }
  }
  // Second pass: bodies get the real sibling URLs.
  const urls = knownUrls();
  if (urls.size > 1) {
    for (const entry of created) {
      const siblings = [...urls.entries()]
        .filter(([id]) => id !== entry.ws.id)
        .map(([, url]) => url);
      const cwd = entry.ws.worktreePath!;
      const ops = await prOps(cwd).catch(() => null);
      await ops
        ?.updateBody(
          cwd,
          entry.url,
          composePrBody(task, entry.ws, siblings, entry.base, opts),
        )
        .catch(() => undefined);
    }
  }
  return results;
}
