import { useMemo, useSyncExternalStore } from "react";
import type { InboxItem } from "../inbox/model/githubTasks";
import {
  inboxItemMatchesLinkedWorkItem,
  sessionWorkItems,
} from "../sessions/model/sessionWorkItem";
import { Plus, ChevronRight, ListBullet } from "../../shared/ui/icons";
import { boardFromSnapshot, boardSnapshot, subscribeBoard } from "./boardStore";
import { boardLinkFromInboxItem } from "./boardData";
import { OPEN_TASK_EVENT } from "./taskSession";

export const CREATE_TASK_EVENT = "monocode:create-task-from-inbox";

/** Board-owned links in the shared Inbox detail surface; creating only opens a draft. */
export function InboxTaskLinks({ item }: { item: InboxItem }) {
  const snapshot = useSyncExternalStore(
    subscribeBoard,
    boardSnapshot,
    boardSnapshot,
  );
  const tasks = useMemo(
    () =>
      boardFromSnapshot(snapshot).tasks.filter((task) =>
        task.links.some((link) =>
          sessionWorkItems({ linkedWorkItem: link }).some((ref) =>
            inboxItemMatchesLinkedWorkItem(item, ref),
          ),
        ),
      ),
    [snapshot, item],
  );
  if (!boardLinkFromInboxItem(item)) return null;
  return (
    <section
      className="min-w-0 rounded-lg border border-content/10"
      aria-label="Linked tasks"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-[11px] font-medium text-content/60">
          Tasks{tasks.length ? ` · ${tasks.length}` : ""}
        </span>
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(CREATE_TASK_EVENT, { detail: item }),
            )
          }
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/10 focus-visible:outline-accent"
        >
          <Plus className="size-3" />
          {tasks.length ? "Start another task" : "Start task"}
        </button>
      </div>
      {tasks.length ? (
        <div
          className={
            tasks.length > 3
              ? "max-h-48 overflow-y-auto overscroll-contain"
              : undefined
          }
        >
          {tasks.map((task) => {
            const detail = task.archived
              ? "Archived"
              : [
                  task.workstreams.length
                    ? `${task.workstreams.length} ${task.workstreams.length === 1 ? "working copy" : "working copies"}`
                    : "No working copies",
                  task.primarySessionId
                    ? "Agent session linked"
                    : "Ready to set up",
                ].join(" · ");
            const content = (
              <>
                <ListBullet className="size-3.5 shrink-0 text-content/40" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">
                    {task.title}
                  </span>
                  <span className="block truncate text-[10px] text-content/45">
                    {detail}
                  </span>
                </span>
                {!task.archived && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-content/45">
                    Open
                    <ChevronRight className="size-3" />
                  </span>
                )}
              </>
            );
            const className =
              "flex w-full min-w-0 items-center gap-2 border-t border-content/8 px-3 py-2 text-left text-content/75";
            return task.archived ? (
              <div key={task.id} className={className}>
                {content}
              </div>
            ) : (
              <button
                key={task.id}
                type="button"
                title={task.title}
                aria-label={`Open task: ${task.title}`}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent(OPEN_TASK_EVENT, { detail: task.id }),
                  )
                }
                className={`${className} hover:bg-content/5 hover:text-content focus-visible:outline-accent`}
              >
                {content}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="px-3 pb-2 text-[11px] text-content/40">
          Keep the agent and working copies for this item together.
        </p>
      )}
    </section>
  );
}
