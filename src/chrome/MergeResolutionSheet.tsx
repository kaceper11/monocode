import { Modal, modalSwap } from "./Modal";
import { GitMerge, Wrench } from "./icons";
import { opLabel, type MergeResolutionRequest } from "../lib/syncDefault";
import { displayPath } from "../lib/paths";

/**
 * In-app conflict-resolution sheet — one choice, three exits. Replaces the
 * chained native asks (send? → abort?) where a cancel opened the next dialog
 * and the flow felt impossible to leave. Esc, backdrop and Close all mean
 * "keep conflicts" — the tree already holds the real state.
 */
export function MergeResolutionSheet({
  request,
}: {
  request: MergeResolutionRequest;
}) {
  const op = opLabel(request.op);
  const action =
    request.op === "rebase"
      ? `Rebasing onto ${request.syncedWith}`
      : `Merging ${request.syncedWith}`;
  const count = request.conflicts.length;
  const shown = request.conflicts.slice(0, 50);
  const choose = (choice: "agent" | "abort" | "keep") => request.choose(choice);
  return (
    <Modal
      onClose={() => choose("keep")}
      title="Merge conflicts"
      description={`${request.title ? `${request.title} · ` : ""}${action} · ${displayPath(request.cwd)}`}
      size="sm"
    >
      <div className="space-y-3 px-4 pb-4 pt-1 text-[12px]">
        <p className="text-content/60">
          {action} left {count} conflicted file{count === 1 ? "" : "s"}. The
          state is preserved in the working copy — nothing is lost by keeping
          it.
        </p>
        {shown.length ? (
          <ul className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-content/10 px-2 py-1.5 font-mono text-[11px] text-content/70">
            {shown.map((path) => (
              <li key={path} className="truncate" title={path}>
                {path}
              </li>
            ))}
            {count > shown.length ? (
              <li className="text-content/40">
                … and {count - shown.length} more
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="flex flex-col gap-1.5 pt-1">
          <button
            type="button"
            className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent/15 text-[12px] font-medium text-accent hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => {
              // The destination picker may follow within the swap window —
              // keep the backdrop dimmed between the two modals.
              modalSwap();
              choose("agent");
            }}
          >
            <Wrench className="size-3.5" strokeWidth={1.75} />
            {request.sessionId ? "Send to owning agent" : "Send to an agent"}
          </button>
          <button
            type="button"
            className="flex h-8 items-center justify-center gap-1.5 rounded-md text-[12px] text-rose-300 hover:bg-rose-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
            onClick={() => choose("abort")}
          >
            Abort {op.toLowerCase()} and restore
          </button>
          <button
            type="button"
            className="flex h-8 items-center justify-center gap-1.5 rounded-md text-[12px] text-content/70 hover:bg-content/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => choose("keep")}
          >
            <GitMerge className="size-3.5" strokeWidth={1.75} />
            Resolve manually
          </button>
        </div>
      </div>
    </Modal>
  );
}
