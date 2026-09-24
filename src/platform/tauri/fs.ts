import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { pathKey, slash, wslLocation } from "../../shared/lib/paths";
import type { InterjectionMeta } from "../../features/sessions/model/session";

export type OmpInterjectionAnchor = InterjectionMeta & {
  id: string;
  afterAssistantText: string;
  /** One-based occurrence among assistant messages with exactly this text. */
  afterOccurrence: number;
  /** Direct-concat live representation, with its own exact-text occurrence. */
  afterAssistantTextConcat?: string;
  afterConcatOccurrence?: number;
  text: string;
  /** Full text of a directly following text-only answer, if present. */
  followingAssistantText?: string | null;
  followingAssistantTextConcat?: string | null;
};

export function ompSessionInterjections(
  providerSessionId: string,
): Promise<OmpInterjectionAnchor[]> {
  return invoke<OmpInterjectionAnchor[]>("omp_session_interjections", {
    providerSessionId,
  });
}

/** One active-path assistant message in source order. Its newline and concat
 * representations are alternative forms of the same message, not two messages.
 */
export interface OmpAssistantText {
  text: string;
  concat: string;
}

export function ompActiveAssistantTexts(providerSessionId: string): Promise<OmpAssistantText[]> {
  return invoke<OmpAssistantText[]>("omp_active_assistant_texts", { providerSessionId });
}

export type FsEntry = {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
};

export type ProjectLocation = {
  path: string;
  identity: string;
};

export function resolveProjectLocation(
  path: string,
  identity?: string,
): Promise<ProjectLocation | null> {
  return invoke<ProjectLocation | null>("resolve_project_location", {
    path,
    identity: identity ?? null,
  });
}

export type ExternalEditor = {
  id: string;
  name: string;
};

export function listExternalEditors(): Promise<ExternalEditor[]> {
  return invoke<ExternalEditor[]>("list_external_editors");
}

export function openInExternalEditor(
  editorId: string,
  cwd: string,
): Promise<void> {
  return invoke<void>("open_in_external_editor", { editorId, cwd });
}

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
    | "hermes"
    | "devin"
    | "copilot"
    | "muse"
    | "antigravity"
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
  branch: string | null;
  head: string | null;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
  remote: string | null;
  upstream: string | null;
  defaultBranch: string | null;
  ahead: number;
  behind: number;
  aheadOfDefault: number;
  headPushed: boolean;
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
export type GitDiffGuard = { kind: GitFileDiffKind; status: string; original: string; current: string };

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

export function gitCommit(
  cwd: string,
  message: string,
  amend = false,
): Promise<void> {
  return invoke<void>("git_commit", { cwd, message, amend });
}

export function gitHeadMessage(cwd: string): Promise<string> {
  return invoke<string>("git_head_message", { cwd });
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

export type GitRangeContext = {
  base: string;
  head: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
};

export function gitRangeContext(cwd: string): Promise<GitRangeContext> {
  return invoke<GitRangeContext>("git_range_context", { cwd });
}

export type GitPr = {
  number: number;
  title: string;
  url: string;
  state: string;
  /** `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED` — GitHub
   * reviewDecision or Azure reviewer-vote rollup. */
  reviewDecision?: string;
  /** Review threads still unresolved — undefined when unprobed. */
  unresolvedThreads?: number;
  draft?: boolean;
  /** Provider-side update time (ISO) — orders "recently merged". */
  updatedAt?: string;
  /** Provider mergeability — `clean` | `behind` | `blocked` | `conflicts` |
   * `unstable` (GitHub mergeStateStatus, Azure mergeStatus). */
  mergeState?: string;
};

export function gitPrStatus(
  cwd: string,
  prUrl?: string,
): Promise<GitPr | null> {
  return invoke<GitPr | null>("git_pr_status", { cwd, prUrl });
}

export function gitPrCreate(
  cwd: string,
  title: string,
  body: string,
  base: string,
  head: string,
  draft: boolean,
): Promise<string> {
  return invoke<string>("git_pr_create", { cwd, title, body, base, head, draft });
}

export type GitPrCheck = {
  name: string;
  state: string;
  /** pass | fail | pending | skipping | cancel — gh's rollup bucket. */
  bucket: string;
  url: string;
};

/** Check runs on the current branch's GitHub pull request — or the exact
 * `prUrl` when a lane pins one (review lanes check out `pr/<N>`). */
export function gitPrChecks(
  cwd: string,
  prUrl?: string,
): Promise<GitPrCheck[]> {
  return invoke<GitPrCheck[]>("git_pr_checks", { cwd, prUrl });
}

/** Replace a GitHub pull request body. */
export function gitPrUpdate(
  cwd: string,
  url: string,
  body: string,
): Promise<void> {
  return invoke<void>("git_pr_update", { cwd, url, body });
}

/** Fetch and merge a base ref (e.g. `main`, `origin/main`) into the
 * checked-out branch of `cwd`. */
export function gitMergeFrom(cwd: string, ref: string): Promise<void> {
  return invoke<void>("git_merge_from", { cwd, gitRef: ref });
}

/** Whether `cwd` has an unfinished merge (`MERGE_HEAD` present) — the board
 * offers conflict resolution on those workstreams. */
export function gitMergeInProgress(cwd: string): Promise<boolean> {
  return invoke<boolean>("git_merge_in_progress", { cwd });
}

export type GitPrPreflight = {
  /** Checked-out branch — null on a detached HEAD. */
  head: string | null;
  /** Ref used for the ahead count — remote-tracking preferred. */
  baseRef: string | null;
  /** The branch name the PR targets (remote prefix stripped). */
  baseBranch: string;
  /** Base exists remote-tracked — required for a server-side PR. */
  baseOnRemote: boolean;
  /** Commits on HEAD not reachable from the base. */
  ahead: number;
  /** HEAD is contained in a remote-tracking ref — already pushed. */
  headPushed: boolean;
  hasRemote: boolean;
};

/** Pre-submit check for the PR composer — validates base, ahead count, and
 * checked-out branch so provider rejections surface before submit. */
export function gitPrPreflight(cwd: string, base: string): Promise<GitPrPreflight> {
  return invoke<GitPrPreflight>("git_pr_preflight", { cwd, base });
}

/** Configured remote names — authoritative, unlike inferring them from
 * fetched tracking refs (a never-fetched remote has none). */
export function gitRemotes(cwd: string): Promise<string[]> {
  return invoke<string[]>("git_remotes", { cwd });
}

/** Commits the resolved base has that `cwd`'s HEAD lacks — the "behind
 * main" count on a lane badge. Pure local refs, no fetch. */
export function gitBehindBase(cwd: string, base: string): Promise<number> {
  return invoke<number>("git_behind_base", { cwd, base });
}

/** Fetch a provider-side ref into a local branch without checking it out
 * (`git fetch <remote> <remoteRef>:refs/heads/<branch>`) — how "review
 * locally" turns an inbox PR into a worktree-able branch. */
export function gitFetchBranch(
  cwd: string,
  remote: string,
  remoteRef: string,
  branch: string,
): Promise<void> {
  return invoke<void>("git_fetch_branch", { cwd, remote, remoteRef, branch });
}

export type GitBranchInfo = {
  name: string;
  current: boolean;
  remote: string | null;
};

export type GitBranches = {
  current: string | null;
  detached: boolean;
  branches: GitBranchInfo[];
};

export function gitBranches(cwd: string): Promise<GitBranches> {
  return invoke<GitBranches>("git_branches", { cwd });
}

/** The checked-out branch only — one `symbolic-ref` subprocess; null on a
 * detached HEAD or a path that isn't a work tree. Cheaper than
 * `gitBranches` for per-lane probe cycles. */
export function gitCurrentBranch(cwd: string): Promise<string | null> {
  return invoke<string | null>("git_current_branch", { cwd });
}

export function gitCheckout(
  cwd: string,
  name: string,
  remote?: string | null,
): Promise<string> {
  return invoke<string>("git_checkout", { cwd, name, remote: remote ?? null });
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

const GIT_CHANGED = "monocode-git-changed";

/** Tell git UIs (diff pane, branch picker) to reload after a local git mutation. */
export function notifyGitChanged(cwd?: string) {
  window.dispatchEvent(new CustomEvent(GIT_CHANGED, { detail: cwd }));
}

export function subscribeGitChanged(
  listener: (changedCwd?: string) => void,
  cwd?: string,
): () => void {
  const onChange = (event: Event) => {
    const changed = (event as CustomEvent<string | undefined>).detail;
    if (cwd && changed) {
      const own = pathKey(cwd),
        target = pathKey(changed);
      if (
        own !== target &&
        !own.startsWith(`${target}/`) &&
        !target.startsWith(`${own}/`)
      )
        return;
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

/** macOS only. Other platforms return an empty list. */
export function clipboardFilePaths(): Promise<string[]> {
  return invoke<string[]>("clipboard_file_paths").then((paths) =>
    paths.map(slash),
  );
}

/** Put the original file on the macOS clipboard, preserving its name and type. */
export function copyFileToClipboard(path: string): Promise<void> {
  return invoke<void>("copy_file_to_clipboard", { path });
}

export function revealPath(path: string): Promise<void> {
  return invoke<void>("reveal_path", { path });
}

export function openPathWithDefaultApp(path: string): Promise<void> {
  return invoke<void>("open_path_with_default_app", { path });
}

export function homeDir(cwd?: string): Promise<string> {
  return cwd && wslLocation(cwd)
    ? invoke<string>("home_dir", { cwd })
    : invoke<string>("home_dir");
}

export async function pickFolder(
  title = "Open project",
  defaultPath?: string,
): Promise<string[] | null> {
  const selected = await open({
    directory: true,
    multiple: true,
    title,
    defaultPath,
  });
  const paths = (Array.isArray(selected) ? selected : selected ? [selected] : [])
    .filter((path): path is string => Boolean(path))
    .map(slash);
  return paths.length > 0 ? paths : null;
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

export async function gitRefreshBranches(cwd: string): Promise<void> {
  await invoke("git_refresh_branches", { cwd });
  notifyGitChanged();
}
export async function gitTaskBranch(cwd: string, expectedBranch: string, name: string, base: string, action: "switch" | "update"): Promise<string> {
  const branch = await invoke<string>("git_task_branch", { cwd, expectedBranch, name, base, action });
  notifyGitChanged();
  return branch;
}
