import {
  gitBranches,
  gitMergeFrom,
  gitPrChecks,
  gitPrCreate,
  gitPrStatus,
  gitPrUpdate,
  gitSync,
} from "../../platform/tauri/fs";
import type { LinkedWorkItem } from "../sessions/model/session";
import type { BoardTask, TaskWorkstream } from "./boardStore";
import type { WorkstreamStatus } from "./boardData";

/**
 * Task-level IO — workstream PR/CI probes and the bulk git operations the
 * details panel exposes. Everything else on the board stays a pure join.
 * PR/CI probing is upstream's `gh`-backed surface — GitHub remotes only;
 * Azure Repos workstreams surface their PRs as inbox cards instead.
 */

/** Probe one workstream's PR + checks on the checked-out branch. */
export async function probeWorkstream(
  workstream: TaskWorkstream,
): Promise<WorkstreamStatus | null> {
  const cwd = workstream.worktreePath;
  if (!cwd) return null;
  try {
    const pr = await gitPrStatus(cwd);
    const checks = pr ? await gitPrChecks(cwd).catch(() => []) : [];
    return { pr, checks };
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

export type WorkstreamResult = {
  workstreamId: string;
  ok: boolean;
  message: string;
};

const shortError = (error: unknown) =>
  String(error).replace(/^Error:\s*/, "").split("\n")[0].slice(0, 160);

const branchMismatch = (workstream: TaskWorkstream, actual: string) =>
  `Worktree is on ${actual || "another branch"}, expected ${workstream.branch}`;

/** Current branch + remote names in one call. */
async function gitContext(cwd: string) {
  const branches = await gitBranches(cwd);
  const remotes = new Set(
    branches.branches
      .map((branch) => branch.remote)
      .filter((remote): remote is string => Boolean(remote)),
  );
  return { branch: branches.current ?? "", remotes };
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
    return {
      workstreamId: workstream.id,
      ok: false,
      message: /conflict|merge|diverg/i.test(message)
        ? `Conflict merging ${workstream.base} — resolve in the worktree`
        : message,
    };
  }
}

function ticketLine(link: LinkedWorkItem): string {
  const ref =
    link.identifier ||
    (link.provider === "azuredevops" && link.number
      ? `AB#${link.number}`
      : `#${link.number}`);
  return `- ${ref}${link.title ? ` — ${link.title}` : ""}${link.url ? ` (${link.url})` : ""}`;
}

function prBody(
  task: BoardTask,
  workstream: TaskWorkstream,
  siblings: readonly string[],
): string {
  const parts = [`Part of task: **${task.title}**`];
  if (task.links.length) {
    parts.push("", "Tickets:", ...task.links.map(ticketLine));
  }
  if (siblings.length) {
    parts.push("", "Related pull requests:", ...siblings.map((s) => `- ${s}`));
  }
  const others = task.workstreams.filter((ws) => ws.id !== workstream.id);
  if (others.length) {
    parts.push(
      "",
      "Related branches:",
      ...others.map((ws) => `- \`${ws.branch}\``),
    );
  }
  return parts.join("\n");
}

/**
 * Create a PR per workstream that doesn't have one, then patch bodies with
 * the sibling URLs (they only exist once creation returns). `only` restricts
 * creation to specific workstreams while keeping the full task context —
 * sibling branches and existing PR URLs — in the body. GitHub remotes only:
 * upstream's `git_pr_*` commands route through `gh`.
 */
export async function createTaskPrs(
  task: BoardTask,
  status: ReadonlyMap<string, WorkstreamStatus>,
  only?: ReadonlySet<string>,
): Promise<WorkstreamResult[]> {
  const results: WorkstreamResult[] = [];
  const created: { ws: TaskWorkstream; url: string }[] = [];
  // Every known sibling URL — probed PRs plus ones created earlier in this
  // run — so bodies cross-link even for a single-lane creation.
  const knownUrls = () => {
    const urls = new Map<string, string>();
    for (const ws of task.workstreams) {
      const existing = status.get(ws.id)?.pr?.url;
      if (existing) urls.set(ws.id, existing);
    }
    for (const entry of created) urls.set(entry.ws.id, entry.url);
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
    if (status.get(ws.id)?.pr) {
      results.push({ workstreamId: ws.id, ok: true, message: "PR exists" });
      continue;
    }
    try {
      // The worktree must still be on the task's branch — `gitSync` pushes
      // whatever is checked out, so verify before pushing anything.
      const context = await gitContext(cwd);
      if (context.branch !== ws.branch)
        throw new Error(branchMismatch(ws, context.branch));
      if (!context.remotes.size) throw new Error("No git remote");
      await gitSync(cwd);
      if (await gitPrStatus(cwd)) {
        results.push({
          workstreamId: ws.id,
          ok: true,
          message: "PR exists",
        });
        continue;
      }
      // ws.base may be remote-qualified ("origin/main") or a plain branch —
      // including branches with slashes ("release/1.2"). Strip only a real
      // remote prefix, never the first path segment of a branch name.
      const base = [...context.remotes].some((remote) =>
        ws.base.startsWith(`${remote}/`),
      )
        ? ws.base.slice(ws.base.indexOf("/") + 1)
        : ws.base;
      if (!base || base === "HEAD")
        throw new Error("Pick a base branch for the pull request");
      const siblings = [...knownUrls().entries()]
        .filter(([id]) => id !== ws.id)
        .map(([, url]) => url);
      const url = await gitPrCreate(
        cwd,
        task.title,
        prBody(task, ws, siblings),
        base,
        ws.branch,
      );
      created.push({ ws, url });
      results.push({ workstreamId: ws.id, ok: true, message: "PR created" });
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
      await gitPrUpdate(
        entry.ws.worktreePath!,
        entry.url,
        prBody(task, entry.ws, siblings),
      ).catch(() => undefined);
    }
  }
  return results;
}
