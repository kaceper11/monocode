import { prettyCwd } from "../lib/paths";
import type {
  BulkSkip,
  RemovalEntry,
  WorktreeSafety,
} from "../lib/worktreeRemoval";
import { Loader, Trash2 } from "./icons";

/**
 * The reviewed batch-removal view shared by the worktree panel's select
 * mode and task-scoped cleanup: the preflighted removable list, the
 * per-row "needs individual review" split, and the results screen.
 * Presentational only — callers own preflight, removal and phase changes.
 */
export function WorktreeRemovalBatch({
  phase,
  removable,
  skipped,
  removed,
  failures,
  busy,
  error,
  confirmLabel,
  labelFor,
  onCancel,
  onConfirm,
  onReview,
  onDone,
}: {
  phase: "confirm" | "removing" | "done";
  removable: WorktreeSafety[];
  skipped: BulkSkip[];
  removed: string[];
  failures: { entry: RemovalEntry; message: string }[];
  busy: boolean;
  /** An operation error the caller couldn't render elsewhere. */
  error?: string;
  /** Extra destructive framing, e.g. "Remove 3 & delete" — defaults to
   * "Remove N". */
  confirmLabel?: string;
  /** Optional row context — e.g. the owning repository when a batch can
   * span several — prefixed onto the branch·path line. */
  labelFor?: (entry: RemovalEntry) => string | undefined;
  onCancel: () => void;
  onConfirm: () => void;
  /** Review handoff for skipped/failed rows — receives the full row so the
   * caller can route leftover work (dirty files, bound processes) straight
   * to the guarded removal confirmation. Omit to hide the buttons. */
  onReview?: (skip: BulkSkip | { entry: RemovalEntry }) => void;
  onDone: () => void;
}) {
  return (
    <div className="space-y-2 px-3 py-2.5">
      <p className="flex items-center gap-2 font-medium">
        {phase === "removing" ? (
          <Loader
            className="size-4 shrink-0 animate-spin text-content/50"
            aria-hidden="true"
          />
        ) : (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-600">
            <Trash2 className="size-3.5" aria-hidden="true" />
          </span>
        )}
        {phase === "removing"
          ? `Removing ${removable.length} ${
              removable.length === 1 ? "worktree" : "worktrees"
            }…`
          : phase === "done"
            ? `Removed ${removed.length} ${
                removed.length === 1 ? "worktree" : "worktrees"
              }`
            : `Remove ${removable.length} ${
                removable.length === 1 ? "worktree" : "worktrees"
              }?`}
      </p>
      {phase === "confirm" && removable.length > 0 && (
        <div className="space-y-0.5">
          {removable.map((safety) => (
            <p
              key={safety.entry.path}
              title={prettyCwd(safety.entry.path)}
              className="truncate font-mono text-[11px] text-content/70"
            >
              {labelFor?.(safety.entry)
                ? `${labelFor(safety.entry)} · `
                : ""}
              {safety.entry.branch?.replace("refs/heads/", "")} ·{" "}
              {prettyCwd(safety.entry.path)}
              {safety.entry.users.length
                ? ` · keeps ${safety.entry.users.length} ${
                    safety.entry.users.length === 1
                      ? "conversation"
                      : "conversations"
                  }`
                : ""}
            </p>
          ))}
          <p className="pt-1 text-[11px] leading-4 text-content/60">
            Branches and conversations stay. Each worktree is checked again
            before removal.
          </p>
        </div>
      )}
      {phase === "confirm" && removable.length === 0 && (
        <p className="text-[11px] text-content/60">
          None of the selected worktrees can be removed without individual
          review.
        </p>
      )}
      {phase !== "removing" && skipped.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-content/80">
            Needs individual review
          </p>
          {skipped.map((skip) => (
            <div key={skip.entry.path} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p
                  title={prettyCwd(skip.entry.path)}
                  className="truncate font-mono text-[11px] text-content/70"
                >
                  {labelFor?.(skip.entry) ? `${labelFor(skip.entry)} · ` : ""}
                  {skip.entry.branch?.replace("refs/heads/", "") ??
                    `Detached ${skip.entry.head.slice(0, 8)}`}
                </p>
                <p className="truncate text-[10px] text-content/45">
                  {skip.reason}
                </p>
              </div>
              {onReview ? (
                <button
                  type="button"
                  className="shrink-0 rounded border border-content/10 px-1.5 py-0.5 text-[11px] hover:bg-content/5"
                  onClick={() => onReview(skip)}
                >
                  Review
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {phase === "done" && failures.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-red-400">
            {failures.length}{" "}
            {failures.length === 1 ? "removal" : "removals"} failed
          </p>
          {failures.map((failure) => (
            <div key={failure.entry.path} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[11px] text-content/70">
                  {failure.entry.branch?.replace("refs/heads/", "") ??
                    failure.entry.path}
                </p>
                <p className="truncate text-[10px] text-red-400/80">
                  {failure.message}
                </p>
              </div>
              {onReview ? (
                <button
                  type="button"
                  className="shrink-0 rounded border border-content/10 px-1.5 py-0.5 text-[11px] hover:bg-content/5"
                  onClick={() => onReview(failure)}
                >
                  Review
                </button>
              ) : null}
            </div>
          ))}
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
        {phase === "confirm" ? (
          <>
            <button
              type="button"
              disabled={busy}
              className="rounded-md border border-content/10 px-2.5 py-1.5 text-content/70 outline-none hover:bg-content/5 focus-visible:ring-2 focus-visible:ring-content/30 disabled:opacity-40"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !removable.length}
              className="inline-flex items-center gap-1.5 rounded-md bg-content/5 px-2.5 py-1.5 font-medium text-red-400 outline-none hover:bg-content/10 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background-base disabled:opacity-40 [.theme-light_&]:text-red-700"
              onClick={onConfirm}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {confirmLabel ?? `Remove ${removable.length || ""}`}
            </button>
          </>
        ) : phase === "done" ? (
          <button
            type="button"
            className="rounded-md border border-content/10 px-2.5 py-1.5 text-content/70 outline-none hover:bg-content/5 focus-visible:ring-2 focus-visible:ring-content/30"
            onClick={onDone}
          >
            Done
          </button>
        ) : null}
      </div>
    </div>
  );
}
