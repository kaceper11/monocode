import { useRef, useState } from "react";
import { RefreshCw, FolderOpen, Trash2 } from "../../shared/ui/icons";
import { Modal } from "../../shared/ui/Modal";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import { LAYER } from "../../shared/lib/layers";
import { pathKey, prettyCwd } from "../../shared/lib/paths";
import { revealPath } from "../../platform/tauri/fs";
import { WorktreePicker } from "../source-control/ui/WorktreePicker";
import { DeleteWorktreeDialog } from "../source-control/ui/DeleteWorktreeDialog";
import {
  createWorktree,
  type Worktree,
} from "../source-control/model/worktrees";
import {
  taskBranchOptions,
  taskBranchChoice,
  useProjectBranchesState,
} from "../source-control/hooks/useProjectBranches";
import { useProjectWorktrees } from "../source-control/hooks/useProjectWorktrees";
import {
  useTaskGitBusy,
  useTaskGitOperation,
  withTaskGitLock,
} from "./TaskGitActions";
import {
  assertTaskWorktreeAvailable,
  type TaskWorktreeActionHandler,
  type TaskWorktreeResult,
  type TaskWorktreeTarget,
} from "./taskWorktrees";

const actionClass =
  "rounded-md border border-content/10 px-3 py-1.5 text-[12px] hover:bg-content/8 disabled:opacity-40";

/** Shared built-in picker with task ownership restrictions and staged selection. */
export function TaskWorkingCopyPicker({
  target,
  onPick,
  onTrackBranch,
  onAction,
  onApplied,
  onManage,
  excludePaths,
  excludeBranches,
  disabled = false,
  layer,
  noWorktree = false,
  initialBranch,
}: {
  target: TaskWorktreeTarget;
  onPick: (tree: Worktree) => void | Promise<void>;
  onTrackBranch?: () => void;
  onAction?: TaskWorktreeActionHandler;
  onApplied?: (result: TaskWorktreeResult) => void;
  onManage?: () => void;
  excludePaths?: ReadonlySet<string>;
  excludeBranches?: ReadonlySet<string>;
  disabled?: boolean;
  layer?: number;
  noWorktree?: boolean;
  initialBranch?: string;
}) {
  const { data } = useProjectWorktrees(
    target.projectPath,
    !!target.projectPath,
  );
  const bound = data?.worktrees.find(
    (tree) => target.path && pathKey(tree.path) === pathKey(target.path),
  );
  const disabledReason = (tree: Worktree) =>
    tree.missing || tree.prunable
      ? "Unavailable"
      : !tree.branch
        ? "Detached — select a named branch in project controls"
        : excludePaths?.has(pathKey(tree.path)) ||
            excludeBranches?.has(tree.branch)
          ? "Used by another task or repository row"
          : undefined;
  return (
    <WorktreePicker
      cwd={target.projectPath}
      executionCwd={target.path ?? target.projectPath}
      enabled={!!target.projectPath && !disabled}
      selectionLabel={
        target.path
          ? bound?.missing
            ? `${target.branch} · Missing`
            : bound && !bound.branch
              ? "Detached working copy"
              : target.branch || "Working copy"
          : noWorktree
            ? "No working copy"
            : "Choose working copy…"
      }
      worktreeRemoved={
        !!target.path && (!!bound?.missing || !!(data && !bound))
      }
      optionDisabledReason={disabledReason}
      layer={layer}
      initialBranch={initialBranch ?? target.branch}
      initialBase={target.base || "HEAD"}
      onSelect={async (tree) => {
        assertTaskWorktreeAvailable(target, tree.path, tree.branch!);
        await onPick(tree);
      }}
      onCreate={async (cwd, branch, base, existing) => {
        if (excludeBranches?.has(branch))
          throw new Error("Another row already tracks this branch.");
        if (onAction) {
          const result = await onAction({
            kind: "create",
            target,
            branch,
            base,
            existing,
          });
          onApplied?.(result);
          if (!result.tree)
            throw new Error(
              "Worktree was created but its state could not be read. Refresh before continuing.",
            );
          return result.tree;
        }
        // New task drafts have no saved ownership yet; keep creation on the same Git seam.
        return withTaskGitLock(cwd, "worktree creation", async () => {
          assertTaskWorktreeAvailable(target, undefined, branch);
          return createWorktree(cwd, branch, base, existing);
        });
      }}
      onManage={onManage}
      onSwitchBranch={onManage}
      allowBranchSwitch={!!onManage && !!target.path}
      onDetach={onTrackBranch}
    />
  );
}

/** Management changes Git immediately; copy selection remains the caller's responsibility. */
export function TaskWorktreeManager({
  target,
  onAction,
  onApplied,
  onPick,
  onDetach,
  onClose,
  excludePaths,
  excludeBranches,
  sessionCount = 0,
  disabled = false,
  staged = false,
}: {
  target: TaskWorktreeTarget;
  onAction: TaskWorktreeActionHandler;
  onApplied: (result: TaskWorktreeResult) => void;
  onPick: (tree: Worktree) => void | Promise<void>;
  onDetach: () => void | Promise<void>;
  onClose: () => void;
  excludePaths?: ReadonlySet<string>;
  excludeBranches?: ReadonlySet<string>;
  sessionCount?: number;
  disabled?: boolean;
  staged?: boolean;
}) {
  const { branches } = useProjectBranchesState(target.projectPath, true);
  const {
    data,
    error: loadError,
    refresh,
  } = useProjectWorktrees(target.projectPath);
  const tree = data?.worktrees.find(
    (tree) => target.path && pathKey(tree.path) === pathKey(target.path),
  );
  const location = target.path ? prettyCwd(target.path) : undefined;
  const locationLabel =
    location && location.length > 60
      ? `…/${location.replace(/\\/g, "/").split("/").slice(-2).join("/")}`
      : location;
  const gitBusy = useTaskGitBusy([target.projectPath]);
  const gitOp = useTaskGitOperation([target.projectPath]);
  const [mode, setMode] = useState<"switch" | "rename">("switch");
  const [branch, setBranch] = useState(target.branch);
  const [rename, setRename] = useState(target.branch);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const blocked = busy || gitBusy || disabled;
  const mutable =
    !!tree &&
    !tree.isMain &&
    !tree.missing &&
    !tree.prunable &&
    !tree.locked &&
    !!tree.branch &&
    !loadError;
  const options = taskBranchOptions(branches, excludeBranches ?? new Set());
  const choice = taskBranchChoice(branch);
  const occupied = data?.worktrees.find(
    (other) =>
      other.branch === choice.branch &&
      pathKey(other.path) !== pathKey(target.path ?? ""),
  );
  const run = async (work: () => Promise<void>, close = true) => {
    if (pending.current || blocked) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await work();
      if (close) onClose();
    } catch (cause) {
      setError(String(cause));
      throw cause;
    } finally {
      pending.current = false;
      setBusy(false);
      void refresh();
    }
  };
  const apply = async (kind: "switch" | "rename") => {
    const result = await onAction({
      kind,
      target,
      branch: kind === "rename" ? rename.trim() : branch,
    });
    onApplied(result);
  };
  return (
    <>
      <Modal
        title="Manage working copy"
        size="sm"
        fitViewport
        onClose={() => {
          if (!pending.current) onClose();
        }}
      >
        <div className="space-y-4 p-4 text-[12px]">
          <div className="rounded-xl border border-content/10 bg-content/[0.025] p-3">
            <div className="flex items-center justify-between gap-2">
              <TaskWorkingCopyPicker
                target={target}
                onAction={onAction}
                onApplied={onApplied}
                onPick={async (tree) => {
                  await onPick(tree);
                  onClose();
                }}
                excludePaths={excludePaths}
                excludeBranches={excludeBranches}
                disabled={blocked}
                layer={LAYER.dialogPopover}
              />
              <button
                type="button"
                aria-label="Refresh"
                title="Refresh working copy"
                className="rounded-md p-1.5 text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-40"
                disabled={blocked}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            <p
              className="mt-2 truncate text-[11px] text-content/45"
              title={target.path}
            >
              {locationLabel ?? "No working copy attached."}
            </p>
            {tree && (
              <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-medium">
                <span
                  className={`rounded-md px-2 py-1 ${tree.dirty === false && !tree.missing ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"}`}
                >
                  {tree.missing
                    ? "Missing folder"
                    : tree.dirty == null
                      ? "Status unavailable"
                      : tree.dirty
                        ? "Uncommitted changes"
                        : "Clean"}
                </span>
                {tree.isMain && (
                  <span className="rounded-md bg-content/5 px-2 py-1 text-content/55">
                    Main checkout
                  </span>
                )}
                {tree.locked && (
                  <span className="rounded-md bg-content/5 px-2 py-1 text-content/55">
                    Locked
                  </span>
                )}
                {!!tree.unpushed && (
                  <span className="rounded-md bg-content/5 px-2 py-1 text-content/55">
                    {tree.unpushed} unpublished{" "}
                    {tree.unpushed === 1 ? "commit" : "commits"}
                  </span>
                )}
              </div>
            )}
          </div>
          {tree?.isMain && (
            <p className="text-content/55">
              Use project controls to change the main checkout.
            </p>
          )}
          {target.path && !tree && data && (
            <p role="status">
              Working copy unavailable. Choose another copy or detach this
              binding.
            </p>
          )}
          <div
            role="tablist"
            aria-label="Branch action"
            className="flex rounded-lg bg-content/5 p-1"
          >
            {(["switch", "rename"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                aria-controls={`task-copy-${value}`}
                id={`task-copy-${value}-tab`}
                tabIndex={mode === value ? 0 : -1}
                onClick={() => setMode(value)}
                onKeyDown={(event) => {
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  ) {
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? "switch"
                        : event.key === "End"
                          ? "rename"
                          : mode === "switch"
                            ? "rename"
                            : "switch";
                    setMode(next);
                    event.currentTarget.parentElement
                      ?.querySelector<HTMLButtonElement>(
                        `#task-copy-${next}-tab`,
                      )
                      ?.focus();
                  }
                }}
                className={`flex-1 rounded-md px-3 py-1.5 transition-colors ${mode === value ? "bg-background-base text-content shadow-sm" : "text-content/50 hover:text-content"}`}
              >
                {value === "switch" ? "Switch branch" : "Rename branch"}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`task-copy-${mode}`}
            aria-labelledby={`task-copy-${mode}-tab`}
            className="space-y-3"
          >
            {mode === "switch" ? (
              <>
                <label className="block space-y-2">
                  <span className="text-content/55">Checkout branch</span>
                  <SearchableSelect
                    label="Checkout branch"
                    value={branch}
                    options={options}
                    onChange={setBranch}
                    creatable="New branch"
                    exclude={excludeBranches}
                    layer={LAYER.dialogPopover}
                    disabled={blocked || !mutable}
                  />
                </label>
                {occupied ? (
                  <button
                    type="button"
                    className={actionClass}
                    disabled={
                      blocked ||
                      occupied.missing ||
                      !!excludePaths?.has(pathKey(occupied.path)) ||
                      !!excludeBranches?.has(occupied.branch!)
                    }
                    onClick={() =>
                      void run(async () => {
                        await onPick(occupied);
                      }).catch(() => {})
                    }
                  >
                    Use existing copy · {prettyCwd(occupied.path)}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={actionClass}
                    disabled={
                      blocked ||
                      !mutable ||
                      tree?.dirty !== false ||
                      !choice.branch ||
                      choice.branch === target.branch
                    }
                    onClick={() =>
                      void run(() => apply("switch")).catch(() => {})
                    }
                  >
                    {choice.branch === target.branch
                      ? "Switch branch"
                      : `Switch to ${choice.branch || "branch"}`}
                  </button>
                )}
              </>
            ) : (
              <>
                <label className="block space-y-2">
                  <span className="text-content/55">New branch name</span>
                  <input
                    aria-label="Rename branch"
                    value={rename}
                    onChange={(e) => setRename(e.target.value)}
                    disabled={blocked || !mutable}
                    className="h-9 w-full rounded-md border border-content/10 bg-background-base px-2.5 outline-none focus:border-content/25 disabled:opacity-40"
                  />
                </label>
                <button
                  type="button"
                  className={actionClass}
                  disabled={
                    blocked ||
                    !mutable ||
                    !rename.trim() ||
                    rename.trim() === target.branch ||
                    !!excludeBranches?.has(rename.trim())
                  }
                  onClick={() =>
                    void run(() => apply("rename")).catch(() => {})
                  }
                >
                  Rename branch
                </button>
              </>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-content/10 pt-3">
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md py-1.5 text-[11px] text-content/55 hover:text-content disabled:opacity-40"
              disabled={blocked || !target.path || tree?.missing}
              onClick={() =>
                void run(() => revealPath(target.path!), false).catch(() => {})
              }
            >
              <FolderOpen size={13} /> Reveal folder
            </button>
            <button
              type="button"
              className="rounded-md py-1.5 text-[11px] text-content/55 hover:text-content disabled:opacity-40"
              disabled={blocked}
              onClick={() =>
                void run(async () => {
                  await onDetach();
                }).catch(() => {})
              }
            >
              Detach from task
            </button>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-40"
              disabled={blocked || !mutable}
              onClick={() => setDeleting(true)}
            >
              <Trash2 size={13} /> Delete worktree…
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-content/40">
            {staged ? "Copy selections wait for Save task. " : ""}Git actions
            apply immediately. Cancel does not undo them.
          </p>
          {(error || loadError) && (
            <p role="alert" className="break-words text-red-400">
              {error || loadError}
            </p>
          )}
          {(disabled || gitOp) && (
            <p role="status" className="text-content/55">
              {gitOp
                ? `Git is busy — ${gitOp}`
                : "Wait for the working agents before changing this copy."}
            </p>
          )}
        </div>
      </Modal>
      {deleting && tree && (
        <DeleteWorktreeDialog
          cwd={target.projectPath}
          tree={tree}
          sessionCount={Math.max(sessionCount, tree.sessionIds?.length ?? 0)}
          allowDeleteSessions={false}
          onClose={() => setDeleting(false)}
          onDeleted={onClose}
          onRemove={async () => {
            await run(async () => {
              const result = await onAction({ kind: "delete", target });
              onApplied(result);
            }, false);
          }}
        />
      )}
    </>
  );
}
