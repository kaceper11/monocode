import { Bot, Check, CircleAlert, Loader, Minus } from "./icons";
import { DIALOG_ACTION } from "./controls";
import { Modal } from "./Modal";
import { prettyCwd } from "../lib/paths";
import type { TaskBranchSyncRow } from "../lib/syncDefault";

const STATE_META: Record<
  TaskBranchSyncRow["state"],
  { icon: React.ReactNode; text: string; tone: string }
> = {
  running: {
    icon: <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />,
    text: "Syncing…",
    tone: "text-content/60",
  },
  merged: {
    icon: <Check className="size-3.5" strokeWidth={2} />,
    text: "Merged",
    tone: "text-emerald-400/90",
  },
  "up-to-date": {
    icon: <Check className="size-3.5" strokeWidth={1.75} />,
    text: "Up to date",
    tone: "text-content/45",
  },
  "conflicts-sent": {
    icon: <Bot className="size-3.5" strokeWidth={1.75} />,
    text: "Conflicts → agent",
    tone: "text-accent",
  },
  conflicts: {
    icon: <CircleAlert className="size-3.5" strokeWidth={1.75} />,
    text: "Conflicts left",
    tone: "text-amber-400/90",
  },
  skipped: {
    icon: <Minus className="size-3.5" strokeWidth={1.75} />,
    text: "Skipped",
    tone: "text-amber-400/90",
  },
  failed: {
    icon: <CircleAlert className="size-3.5" strokeWidth={1.75} />,
    text: "Failed",
    tone: "text-rose-400/90",
  },
};

/** Live report of a task-level "sync all branches" run — streams each
 * working copy's outcome in as it resolves. */
export function TaskSyncSheet({
  taskName,
  rows,
  onClose,
}: {
  taskName: string;
  rows: readonly TaskBranchSyncRow[];
  onClose: () => void;
}) {
  const done = rows.filter((row) => row.state !== "running").length;
  const attention = rows.filter(
    (row) =>
      row.state === "conflicts" ||
      row.state === "failed" ||
      row.state === "skipped",
  ).length;
  const running = done < rows.length;
  const summary = running
    ? `Syncing ${done} of ${rows.length}…`
    : attention
      ? `Done — ${attention} need${attention === 1 ? "s" : ""} attention`
      : "Done";
  return (
    <Modal
      title="Sync with remote default"
      description={taskName}
      size="sm"
      trapFocus
      onClose={onClose}
    >
      <ul className="divide-y divide-content/5 px-4 py-2">
        {rows.map((row) => {
          const meta = STATE_META[row.state];
          return (
            <li key={row.cwd} className="flex items-start gap-2.5 py-2">
              <span className={`mt-px shrink-0 ${meta.tone}`}>{meta.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {row.label}
                  </span>
                  <span
                    className={`shrink-0 text-[11px] ${meta.tone}`}
                  >
                    {meta.text}
                  </span>
                </div>
                <p
                  className="truncate text-[11px] text-content/40"
                  title={row.cwd}
                >
                  {prettyCwd(row.cwd)}
                </p>
                {row.detail ? (
                  <p className="mt-0.5 break-words text-[11px] text-content/55">
                    {row.detail}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
        {!rows.length ? (
          <li className="py-2 text-content/45">
            No linked working copies to sync.
          </li>
        ) : null}
      </ul>
      <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-content/10 bg-background-base px-4 py-2.5">
        <span className="text-[11px] text-content/45">{summary}</span>
        <button
          type="button"
          onClick={onClose}
          className={DIALOG_ACTION.tonal}
        >
          {running ? "Close" : "Done"}
        </button>
      </div>
    </Modal>
  );
}
