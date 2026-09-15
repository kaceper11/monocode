import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { pathKey, slash, wslLocation } from "./paths";

export type FsEntry = {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
};

export type ProjectFile = {
  name: string;
  path: string;
  relative: string;
  isDir?: boolean;
};

export function listDir(path: string): Promise<FsEntry[]> {
  return invoke<FsEntry[]>("list_dir", { path });
}

export type DiscoveredSkill = {
  name: string;
  description: string;
  path: string;
  scope: "project" | "user" | "builtin";
  source:
    | "agents"
    | "claude"
    | "cursor"
    | "codex"
    | "opencode"
    | "pi"
    | "omp"
    | "fx"
    | "grok"
    | "devin"
    | "copilot"
    | "monocode";
};

export function listSkills(
  cwd: string,
  disabledPaths?: readonly string[] | null,
): Promise<DiscoveredSkill[]> {
  return invoke<DiscoveredSkill[]>("list_skills", {
    cwd,
    disabledPaths: disabledPaths ?? null,
  });
}

export function listProjectFiles(cwd: string): Promise<ProjectFile[]> {
  return invoke<ProjectFile[]>("list_project_files", { cwd });
}

export type GitDiffStats = {
  files: number;
  additions: number;
  deletions: number;
  /** Head branch (or short HEAD when detached) — same as GitDiffIndex.branch. */
  branch: string | null;
};

export function gitDiffStats(cwd: string): Promise<GitDiffStats> {
  return invoke<GitDiffStats>("git_diff_stats", { cwd });
}

export type GitChangedFile = {
  path: string;
  relative: string;
  status: "modified" | "added" | "deleted" | "untracked" | string;
  additions: number;
  deletions: number;
  staged: boolean;
  unstaged: boolean;
};

export type GitDiffIndex = {
  /** The cwd sits inside a Git work tree — a plain folder produces the same
   * empty index as a clean repo without this flag. */
  isRepo: boolean;
  branch: string | null;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
  remote: string | null;
  upstream: string | null;
  defaultBranch: string | null;
  ahead: number;
  behind: number;
  aheadOfDefault: number;
  /** A merge, rebase, patch apply (`git am`), cherry-pick or revert is in progress. */
  opInProgress: boolean;
  /** "merge" | "rebase" | "am" | "cherry-pick" | "revert" — "" when none. */
  op: string;
  /** Unmerged paths while an operation is in progress (bounded). */
  conflicts: string[];
  /** Short SHA of MERGE_HEAD (or the rebased head) when known. */
  mergeHead: string | null;
  /** HEAD is detached — `branch` then holds a short SHA, not a branch. */
  detached: boolean;
  /** "Keep local" files — skip-worktree entries git hides from status and
   * refuses to stage or commit. Tracked entries are local edits; untracked
   * ones are parked intent-to-add files. */
  localOnly: GitChangedFile[];
};

export function gitDiffIndex(cwd: string): Promise<GitDiffIndex> {
  return invoke<GitDiffIndex>("git_diff_index", { cwd });
}

/** File list and counts only, for diff content views that do not need sync data. */
export function gitDiffFiles(cwd: string): Promise<GitDiffIndex> {
  return invoke<GitDiffIndex>("git_diff_files", { cwd });
}

export type GitFileDiff = {
  path: string;
  relative: string;
  status: string;
  original: string;
  current: string;
  binary: boolean;
  tooLarge: boolean;
};

export type GitFileDiffKind = "staged" | "unstaged";

export type GitDiffGuard = {
  kind: GitFileDiffKind;
  status: string;
  original: string;
  current: string;
};

export function gitFileDiff(
  cwd: string,
  relative: string,
  kind: GitFileDiffKind = "unstaged",
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_file_diff", {
    cwd,
    relative,
    staged: kind === "staged",
  });
}

export type GitHistoryRef = {
  name: string;
  kind: "local" | "remote" | "tag" | string;
};

export type GitHistoryCommit = {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  timestamp: number;
  subject: string;
  refs: GitHistoryRef[];
  head: boolean;
};

export type GitHistory = {
  head: string | null;
  commits: GitHistoryCommit[];
};

export function gitHistory(cwd: string, limit = 200): Promise<GitHistory> {
  return invoke<GitHistory>("git_history", { cwd, limit });
}

export function gitCommitFiles(
  cwd: string,
  sha: string,
): Promise<GitChangedFile[]> {
  return invoke<GitChangedFile[]>("git_commit_files", { cwd, sha });
}

export function gitCommitFileDiff(
  cwd: string,
  sha: string,
  relative: string,
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_commit_file_diff", { cwd, sha, relative });
}

export function gitStageContents(
  cwd: string,
  relative: string,
  contents: string,
  guard: GitDiffGuard,
): Promise<void> {
  return invoke<void>("git_stage_contents", {
    cwd,
    relative,
    contents,
    guard,
  });
}

export function gitStageFile(cwd: string, relative: string): Promise<void> {
  return invoke<void>("git_stage_file", { cwd, relative });
}

export function gitUnstageFile(cwd: string, relative: string): Promise<void> {
  return invoke<void>("git_unstage_file", { cwd, relative });
}

export function gitDiscardFile(cwd: string, relative: string): Promise<void> {
  return invoke<void>("git_discard_file", { cwd, relative });
}

export function gitDiscardAll(cwd: string): Promise<void> {
  return invoke<void>("git_discard_all", { cwd });
}

export function gitStageAll(cwd: string): Promise<void> {
  return invoke<void>("git_stage_all", { cwd });
}

export function gitUnstageAll(cwd: string): Promise<void> {
  return invoke<void>("git_unstage_all", { cwd });
}

/** Hide a file's local state from staging and commits (skip-worktree). */
export function gitKeepLocal(cwd: string, relative: string): Promise<void> {
  return invoke<void>("git_keep_local", { cwd, relative });
}

/** Remove the keep-local flag so the file's real state shows again. */
export function gitUnkeepLocal(cwd: string, relative: string): Promise<void> {
  return invoke<void>("git_unkeep_local", { cwd, relative });
}

export function gitCommit(cwd: string, message: string): Promise<void> {
  return invoke<void>("git_commit", { cwd, message });
}

export type GitStagedContext = {
  branch: string | null;
  summary: string;
  patch: string;
};

export function gitStagedContext(cwd: string): Promise<GitStagedContext> {
  return invoke<GitStagedContext>("git_staged_context", { cwd });
}

export function gitPush(cwd: string): Promise<void> {
  return invoke<void>("git_push", { cwd });
}

export function gitPull(cwd: string): Promise<void> {
  return invoke<void>("git_pull", { cwd });
}

export function gitSync(cwd: string): Promise<void> {
  return invoke<void>("git_sync", { cwd });
}

export type GitUpdateResult = {
  /** "updated" | "up-to-date" | "conflicts" */
  outcome: string;
  branch: string;
  updatedFrom: string;
  conflicts: string[];
};

/**
 * Fetch `base` (the PR's target branch, or the remote default when absent)
 * and merge or rebase it into the checkout. Refuses a dirty tree; conflicts
 * stay in progress for explicit resolution.
 */
export function gitUpdateFromDefault(
  cwd: string,
  mode: "merge" | "rebase",
  base?: string,
  expectedBranch?: string,
): Promise<GitUpdateResult> {
  return invoke<GitUpdateResult>("git_update_from_default", {
    cwd,
    mode,
    base,
    expectedBranch,
  });
}

/** Abort an in-progress merge, rebase, `git am`, cherry-pick or revert, leaving the checkout clean. */
export function gitMergeAbort(cwd: string): Promise<void> {
  return invoke<void>("git_merge_abort", { cwd });
}

export type GitSyncResult = {
  /** "merged" | "up-to-date" | "conflicted" | "refused" */
  outcome: string;
  branch: string;
  /** The remote ref merged, e.g. "origin/main". */
  syncedWith: string;
  /** Subjects of the incoming commits the merge brought in (bounded). */
  commits: string[];
  /** Total incoming commits — `commits` may be truncated. */
  commitCount: number;
  /** Conflicted paths when the merge stopped; left in progress. */
  conflicts: string[];
  /** Why a refused sync did not run. */
  reason: string;
};

/**
 * Fetch the remote default branch and merge `remote/<default>` into this
 * exact working copy on its own host. Merge only; never pushes. A dirty
 * tree, an operation already in progress, a branch that moved since
 * `expectedBranch` was confirmed, or a second concurrent sync is refused
 * as data — nothing is stashed or queued.
 */
export function gitSyncBranch(
  cwd: string,
  expectedBranch?: string,
): Promise<GitSyncResult> {
  return invoke<GitSyncResult>("git_sync_branch", { cwd, expectedBranch });
}

export type GitMergeContext = {
  /** A merge, rebase, patch apply (`git am`), cherry-pick or revert is in progress. */
  merging: boolean;
  /** "merge" | "rebase" | "am" | "cherry-pick" | "revert" — "" when none. */
  op: string;
  /** Unmerged paths (bounded). */
  conflicts: string[];
  /** Short SHA of the head being applied (MERGE_HEAD…) when known. */
  mergeHead: string | null;
  /** Remote-tracking ref verified to name MERGE_HEAD, e.g. "origin/main". */
  incomingRef: string | null;
  /** Bounded combined diff of the conflicted paths — both sides. */
  diff: string;
};

/** Live merge state — honest after restart, unlike a remembered result. */
export function gitMergeContext(cwd: string): Promise<GitMergeContext> {
  return invoke<GitMergeContext>("git_merge_context", { cwd });
}

export type GitRangeContext = {
  base: string;
  head: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
};

export function gitRangeContext(
  cwd: string,
  base?: string,
): Promise<GitRangeContext> {
  return invoke<GitRangeContext>("git_range_context", { cwd, base: base ?? null });
}

export type GitPr = {
  number: number;
  title: string;
  url: string;
  state: string;
  base?: string;
};

export function gitPrStatus(cwd: string): Promise<GitPr | null> {
  return invoke<GitPr | null>("git_pr_status", { cwd });
}

export function gitPrCreate(
  cwd: string,
  title: string,
  body: string,
  base: string,
  head: string,
  draft = false,
): Promise<string> {
  return invoke<string>("git_pr_create", { cwd, title, body, base, head, draft });
}

export function gitPrUpdate(
  cwd: string,
  url: string,
  body: string,
): Promise<void> {
  return invoke<void>("git_pr_update", { cwd, url, body });
}

export function gitPrBody(cwd: string, url: string): Promise<string> {
  return invoke<string>("git_pr_body", { cwd, url });
}

export type GitPrCheck = {
  branch: string | null;
  remote: string | null;
  upstream: string | null;
  defaultBranch: string | null;
  dirtyFiles: number;
  dirtyLimited: boolean;
  published: boolean;
  aheadOfRemote: number;
  targetExists: boolean;
  ahead: number;
  behind: number;
  commits: string[];
};

export function gitPrCheck(cwd: string, target: string): Promise<GitPrCheck> {
  return invoke<GitPrCheck>("git_pr_check", { cwd, target });
}

export type GitBranchInfo = {
  name: string;
  current: boolean;
  remote: string | null;
  worktree: string | null;
};

export type GitBranches = {
  current: string | null;
  detached: boolean;
  branches: GitBranchInfo[];
};

export function gitBranches(cwd: string): Promise<GitBranches> {
  return invoke<GitBranches>("git_branches", { cwd });
}

export function gitCheckout(
  cwd: string,
  name: string,
  remote?: string | null,
): Promise<{ branch: string; worktree: string | null }> {
  return invoke("git_checkout", { cwd, name, remote: remote ?? null });
}

export function gitCreateBranch(cwd: string, name: string): Promise<string> {
  return invoke<string>("git_create_branch", { cwd, name });
}

export function gitStash(cwd: string, message?: string): Promise<void> {
  return invoke<void>("git_stash", { cwd, message: message ?? null });
}

/** Git refused a checkout because the working tree would be overwritten. */
export function isCheckoutBlockedByChanges(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("would be overwritten") ||
    text.includes("commit your changes or stash") ||
    text.includes("please move or remove them before")
  );
}

/** Preserve the exact checkout and provider session when restoring old records. */
export function restoreSessionCheckout<
  T extends { cwd: string; branch?: string; worktreeCwd?: string; providerSessionId?: string },
>(session: T): T {
  return session;
}

const GIT_CHANGED = "monocode-git-changed";

/** Tell git UIs (diff pane, branch picker) to reload after a local git mutation. */
export function notifyGitChanged(cwd?: string) {
  window.dispatchEvent(new CustomEvent(GIT_CHANGED, { detail: cwd }));
}

export function subscribeGitChanged(listener: (changedCwd?: string) => void, cwd?: string): () => void {
  const onChange = (event: Event) => {
    const changed = (event as CustomEvent<string | undefined>).detail;
    if (cwd && changed) {
      const own = pathKey(cwd), target = pathKey(changed);
      if (own !== target && !own.startsWith(`${target}/`) && !target.startsWith(`${own}/`)) return;
    }
    listener(changed);
  };
  window.addEventListener(GIT_CHANGED, onChange);
  return () => window.removeEventListener(GIT_CHANGED, onChange);
}

export function createPath(
  parent: string,
  name: string,
  isDir: boolean,
): Promise<string> {
  return invoke<string>("create_path", { parent, name, isDir }).then(slash);
}

export function renamePath(path: string, name: string): Promise<string> {
  return invoke<string>("rename_path", { path, name }).then(slash);
}

export function deletePath(path: string): Promise<void> {
  return invoke<void>("delete_path", { path });
}

export function copyPath(from: string, destParent: string): Promise<string> {
  return invoke<string>("copy_path", { from, destParent }).then(slash);
}

export function movePath(from: string, destParent: string): Promise<string> {
  return invoke<string>("move_path", { from, destParent }).then(slash);
}

export function revealPath(path: string): Promise<void> {
  return invoke<void>("reveal_path", { path });
}

export function homeDir(cwd?: string): Promise<string> {
  return cwd && wslLocation(cwd) ? invoke<string>("home_dir", { cwd }) : invoke<string>("home_dir");
}

export async function pickFolder(title = "Open project", defaultPath?: string): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title,
    defaultPath,
  });
  return typeof selected === "string" && selected ? slash(selected) : null;
}

/** Multi-select variant of pickFolder — every chosen folder comes back. */
export async function pickFolders(title = "Open project", defaultPath?: string): Promise<string[] | null> {
  const selected = await open({
    directory: true,
    multiple: true,
    title,
    defaultPath,
  });
  const paths = (Array.isArray(selected) ? selected : selected ? [selected] : [])
    .filter((path): path is string => Boolean(path))
    .map(slash);
  return paths.length ? paths : null;
}

export async function pickFiles(title = "Attach files"): Promise<string[] | null> {
  const selected = await open({
    multiple: true,
    directory: false,
    title,
  });
  if (Array.isArray(selected)) {
    const paths = selected
      .filter((path): path is string => Boolean(path))
      .map(slash);
    return paths.length > 0 ? paths : null;
  }
  if (typeof selected === "string" && selected) return [slash(selected)];
  return null;
}

export function cloneRepo(url: string, parent: string): Promise<string> {
  return invoke<string>("clone_repo", { url, parent }).then(slash);
}

export function readFilePreview(
  path: string,
  maxLines = 6,
  startLine?: number,
): Promise<string[]> {
  return invoke<string[]>("read_file_preview", {
    path,
    maxLines,
    startLine,
  });
}

export type FileMtime = {
  path: string;
  mtimeMs: number | null;
};

export function statFiles(paths: string[]): Promise<FileMtime[]> {
  if (paths.length === 0) return Promise.resolve([]);
  return invoke<FileMtime[]>("stat_files", { paths });
}

export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/** Raw bytes for the image viewer. Arrives as an ArrayBuffer, not base64. */
export async function readBinaryFile(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_binary_file", { path });
  return new Uint8Array(buffer);
}

export function writeTextFile(path: string, content: string): Promise<void> {
  return invoke<void>("write_text_file", { path, content });
}

/** Last path segment, or `/` for the filesystem root. */
export function basename(path: string): string {
  const trimmed = slash(path).replace(/\/+$/, "") || "/";
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed;
  const parts = trimmed.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}
