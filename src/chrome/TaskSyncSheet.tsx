import { Bot, Check, CircleAlert, Loader, Minus } from "./icons";
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
    icon: <Minus className="size-3.5" strokeWidth={1.75} />,
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
  const running = rows.some((row) => row.state === "running");
  return (
    <Modal
      title="Sync with remote default"
      description={`${taskName} · ${running ? "merging into each linked working copy" : "done"}`}
      size="sm"
      onClose={onClose}
    >
      <ul className="space-y-1.5 px-4 py-3">
        {rows.map((row) => {
          const meta = STATE_META[row.state];
          return (
            <li
              key={row.cwd}
              className="rounded-md border border-content/10 px-2.5 py-2"
            >
              <div className="flex items-center gap-2">
                <span className={meta.tone}>{meta.icon}</span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {row.label}
                </span>
                <span className={`shrink-0 ${meta.tone}`}>{meta.text}</span>
              </div>
              <p className="mt-0.5 truncate text-content/40" title={row.cwd}>
                {prettyCwd(row.cwd)}
              </p>
              {row.detail ? (
                <p className="mt-0.5 break-words text-content/55">
                  {row.detail}
                </p>
              ) : null}
            </li>
          );
        })}
        {!rows.length ? (
          <li className="text-content/45">No linked working copies to sync.</li>
        ) : null}
      </ul>
    </Modal>
  );
}
