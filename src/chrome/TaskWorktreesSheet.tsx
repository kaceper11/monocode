import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { loadRecents } from "../lib/recents";
import { notifyGitChanged } from "../lib/fs";
import { isEqualOrInside, pathKey, prettyCwd } from "../lib/paths";
import { familyForRepository } from "../lib/projects";
import {
  getVerifiedFamilies,
  lastWorkingCopyUse,
  workingCopyAge,
  type RepositoryFamily,
} from "../lib/repositoryFamilies";
import {
  loadTaskWorkspaces,
  projectForTask,
  removeTask,
  repositoryForChild,
  subscribeTaskWorkspaces,
  taskChildRepoLabel,
  taskOwnsCheckout,
  taskWorkspacesSnapshot,
  type TaskChild,
} from "../lib/taskWorkspaces";
import {
  bulkRemovalPlan,
  executeWorktreeRemovals,
  openWorktreeManager,
  preflightWorktrees,
  removalFallbacks,
  type BulkSkip,
  type RemovalEntry,
  type WorktreeSafety,
} from "../lib/worktreeRemoval";
import { probeRepositoryFamily } from "../hooks/useRepositoryFamilies";
import { Modal } from "./Modal";
import { WorktreeRemovalBatch } from "./WorktreeRemovalBatch";
import { Check, GitBranch, Trash2 } from "./icons";

type BatchState = {
  phase: "confirm" | "removing" | "done";
  removable: WorktreeSafety[];
  skipped: BulkSkip[];
  removed: string[];
  failures: { entry: RemovalEntry; message: string }[];
  /** The record may already be gone when the results view renders. */
  taskName: string;
  /** Resolved per-target family context — Review reuses it to reopen the
   * manager inside the right repository. */
  contexts: Map<string, string>;
  /** Probed family per target — the survivors list for fallback picking. */
  familyByPath: Map<string, RepositoryFamily>;
};

/** A healthy family member that can host the next preflight/remove call —
 * never a missing copy, a prunable registration or any batch target (a
 * sibling removed earlier in the sequence is already gone). */
function healthyMember(
  family: RepositoryFamily | undefined,
  exclude: ReadonlySet<string>,
): string | undefined {
  const usable = (family?.worktrees ?? []).filter(
    (entry) =>
      !entry.missing && !entry.prunable && !exclude.has(pathKey(entry.path)),
  );
  return usable.find((entry) => entry.main)?.path ?? usable[0]?.path;
}

/** Task-children have no Git inventory entry until their family is probed —
 * the fabricated row only feeds preflight and skip-row display; the real
 * safety response supplies head/branch for removal. */
function removalEntryFor(child: TaskChild): RemovalEntry {
  return {
    path: child.workingCopy!,
    head: child.baseCommit ?? "",
    branch: child.branch ? `refs/heads/${child.branch}` : null,
    main: false,
    missing: false,
    locked: null,
    prunable: null,
    users: [],
  };
}

/**
 * Delete-task sheet: the task record goes either way — sessions and
 * branches stay — and the task-owned working copies can join a reviewed
 * batch removal through the same preflight pipeline as the worktree
 * manager. Borrowed copies (`existing`/`main` mode children) are never
 * listed.
 */
export function TaskWorktreesSheet({
  taskId,
  cwd,
  families,
  onClose,
}: {
  taskId: string;
  /** Active context — a copy containing it can never join the batch. */
  cwd: string;
  families: ReadonlyMap<string, RepositoryFamily>;
  onClose: () => void;
}) {
  useSyncExternalStore(subscribeTaskWorkspaces, taskWorkspacesSnapshot);
  const task = loadTaskWorkspaces().find((entry) => entry.id === taskId);
  const project = task ? projectForTask(task) : undefined;
  const recents = loadRecents();
  const owned =
    task?.children.filter(
      (child) => taskOwnsCheckout(child) && child.workingCopy,
    ) ?? [];
  const inUse = (child: TaskChild) =>
    !!child.workingCopy && isEqualOrInside(cwd, child.workingCopy);
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(owned.filter((child) => !inUse(child)).map((c) => c.id)),
  );
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");

  // The record can disappear from another surface — or from this sheet's
  // own delete — but an in-flight batch view must survive it so results
  // and Review handoffs stay reachable.
  useEffect(() => {
    if (!task && !batch) onClose();
  }, [task, batch, onClose]);
  if (!task && !batch) return null;

  const run = async (work: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(String(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const finishDelete = () => {
    removeTask(taskId);
    onClose();
  };
  const toggle = (child: TaskChild) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(child.id)) next.delete(child.id);
      else next.add(child.id);
      return next;
    });

  /** Cached-or-probed family context per selected child — the batch spans
   * families in a multi-repository task. */
  const resolveContexts = async (targets: TaskChild[]) => {
    const targetKeys = new Set(
      targets.map((child) => pathKey(child.workingCopy!)),
    );
    const contexts = new Map<string, string>();
    const familyByPath = new Map<string, RepositoryFamily>();
    for (const child of targets) {
      const path = child.workingCopy!;
      const repo = repositoryForChild(task!, child, project);
      let family: RepositoryFamily | undefined =
        getVerifiedFamilies().get(pathKey(path)) ??
        (repo ? familyForRepository(repo) : undefined);
      if (!family && repo)
        family = (await probeRepositoryFamily(repo.anchor)) ?? undefined;
      if (family) familyByPath.set(pathKey(path), family);
      contexts.set(
        pathKey(path),
        healthyMember(family, targetKeys) ??
          repo?.anchor ??
          family?.checkout ??
          path,
      );
    }
    return { contexts, familyByPath };
  };

  const beginCleanup = () =>
    void run(async () => {
      const targets = owned.filter(
        (child) => checked.has(child.id) && child.workingCopy,
      );
      if (!targets.length) return;
      const { contexts, familyByPath } = await resolveContexts(targets);
      const { results, failed } = await preflightWorktrees(
        targets.map(removalEntryFor),
        (path) => contexts.get(pathKey(path)) ?? path,
      );
      // The backend answers with the registered (canonical) path, which can
      // differ from the recorded child path — index by both so the removal
      // calls below always hit the right context and family.
      for (const { target, safety } of results) {
        const context = contexts.get(pathKey(target.path));
        if (context) contexts.set(pathKey(safety.entry.path), context);
        const family = familyByPath.get(pathKey(target.path));
        if (family) familyByPath.set(pathKey(safety.entry.path), family);
      }
      const plan = bulkRemovalPlan(results.map((row) => row.safety));
      plan.skipped.push(...failed);
      setBatch({
        phase: "confirm",
        ...plan,
        removed: [],
        failures: [],
        taskName: task?.name ?? "",
        contexts,
        familyByPath,
      });
    });

  const confirmCleanup = () =>
    void run(async () => {
      if (!batch) return;
      setBatch({ ...batch, phase: "removing" });
      const { removed, failures } = await executeWorktreeRemovals({
        removable: batch.removable,
        contextFor: (path) => batch.contexts.get(pathKey(path)) ?? path,
        fallbackFor: (path, removedPaths) => {
          const family = batch.familyByPath.get(pathKey(path));
          const survivors = (family?.worktrees ?? [])
            .filter(
              (copy) =>
                !removedPaths.some(
                  (removedPath) => pathKey(removedPath) === pathKey(copy.path),
                ),
            )
            .map((copy) => ({ ...copy, users: copy.users ?? [] }));
          return (
            removalFallbacks(path, survivors, recents)[0]?.path ??
            batch.contexts.get(pathKey(path)) ??
            path
          );
        },
      });
      for (const context of new Set(
        removed
          .map((path) => batch.contexts.get(pathKey(path)))
          .filter((value): value is string => !!value)
          .map(pathKey),
      ))
        notifyGitChanged(context);
      // Chosen policy: the record goes even when copies were skipped or
      // failed — leftovers stay listed for individual review.
      removeTask(taskId);
      if (!failures.length && !batch.skipped.length) {
        onClose();
        return;
      }
      setBatch({ ...batch, phase: "done", removed, failures });
    });

  /** Hand a skipped/failed row back to the full manager's reviewed flow.
   * Before the batch ran, the task record stays — the delete is simply
   * cancelled; after, it is already gone. */
  const reviewEntry = (entry: RemovalEntry) => {
    onClose();
    openWorktreeManager({
      cwd: batch?.contexts.get(pathKey(entry.path)) ?? entry.path,
      path: entry.path,
    });
  };

  return (
    <Modal
      size="sm"
      title={
        batch
          ? "Clean up task worktrees"
          : `Delete “${task?.name ?? ""}”?`
      }
      description={batch ? batch.taskName : undefined}
      onClose={() => {
        // "removing" only exists inside `run`, which already holds `busy` —
        // gating on the phase alone could strand the modal after a failure.
        if (!busy) onClose();
      }}
    >
      {batch ? (
        <WorktreeRemovalBatch
          phase={batch.phase}
          removable={batch.removable}
          skipped={batch.skipped}
          removed={batch.removed}
          failures={batch.failures}
          busy={busy}
          error={error}
          confirmLabel={`Remove ${batch.removable.length || ""} & delete task`}
          onCancel={() => setBatch(null)}
          onConfirm={confirmCleanup}
          // Review during confirm would silently abandon the pending delete
          // — the handoff only exists once the batch has run.
          onReview={batch.phase === "done" ? reviewEntry : undefined}
          onDone={onClose}
        />
      ) : task ? (
        <div className="space-y-2 px-4 py-3 text-[12px]">
          <p className="text-content/70">
            Its sessions and conversations stay.
            {owned.length > 0 &&
              " The worktrees this task created can be removed now."}
          </p>
          {owned.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-[11px] font-medium text-content/80">
                Worktrees created by this task
              </p>
              {owned.map((child) => {
                const disabled = inUse(child);
                const isChecked = checked.has(child.id);
                const family = child.workingCopy
                  ? families.get(pathKey(child.workingCopy))
                  : undefined;
                const copy = family?.worktrees.find(
                  (entry) => pathKey(entry.path) === pathKey(child.workingCopy!),
                );
                return (
                  <button
                    key={child.id}
                    type="button"
                    disabled={busy || disabled}
                    aria-pressed={isChecked}
                    title={
                      disabled
                        ? "In use — switch away before removing it"
                        : prettyCwd(child.workingCopy!)
                    }
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-content/5 disabled:opacity-45"
                    onClick={() => toggle(child)}
                  >
                    <span
                      aria-hidden="true"
                      className={`grid size-3.5 shrink-0 place-items-center rounded-[4px] border ${
                        isChecked
                          ? "border-accent bg-accent text-background-base"
                          : "border-content/30"
                      }`}
                    >
                      {isChecked ? (
                        <Check className="size-2.5" strokeWidth={2.5} />
                      ) : null}
                    </span>
                    <GitBranch
                      className="size-3 shrink-0 text-content/40"
                      strokeWidth={1.5}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {taskChildRepoLabel(task, child, project)}
                      <span className="block truncate font-sans text-[10px] text-content/60">
                        {copy
                          ? workingCopyAge(lastWorkingCopyUse(copy, recents))
                          : "Not yet probed"}
                        {disabled ? " · in use" : ""}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {error && (
            <p
              role="alert"
              className="whitespace-pre-wrap text-[11px] leading-4 text-red-400/90"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t border-content/10 pt-2.5">
            <button
              type="button"
              disabled={busy}
              className="rounded-md px-2.5 py-1.5 text-content/60 outline-none hover:bg-content/5 hover:text-content/85 focus-visible:ring-2 focus-visible:ring-content/30 disabled:opacity-40"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-md border border-content/10 px-2.5 py-1.5 text-content/70 outline-none hover:bg-content/5 focus-visible:ring-2 focus-visible:ring-content/30 disabled:opacity-40"
              onClick={finishDelete}
            >
              Delete task
            </button>
            {owned.length > 0 && (
              <button
                type="button"
                disabled={busy || !checked.size}
                className="inline-flex items-center gap-1.5 rounded-md bg-content/5 px-2.5 py-1.5 font-medium text-red-400 outline-none hover:bg-content/10 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background-base disabled:opacity-40 [.theme-light_&]:text-red-700"
                onClick={beginCleanup}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                Remove {checked.size || ""} &amp; delete…
              </button>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
