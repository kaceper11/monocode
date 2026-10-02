import { useMemo, useState, useSyncExternalStore } from "react";
import {
  taskSessionIds,
  boardFromSnapshot,
  boardSnapshot,
  subscribeBoard,
  type BoardTask,
} from "./boardStore";
import { useSavedProjects } from "../projects/model/savedProjects";
import { pathKey, projectName } from "../../shared/lib/paths";
import { OPEN_TASK_EVENT } from "./taskSession";
import { ListBullet, ChevronRight, Plus } from "../../shared/ui/icons";
export const NEW_TASK_EVENT = "monocode:new-task";
export function tasksForProject(
  tasks: readonly BoardTask[],
  cwd: string,
  project?: { id: string; members: string[] },
) {
  const members = project?.members ?? [cwd];
  return tasks.filter(
    (task) =>
      !task.archived &&
      (project && task.projectId
        ? task.projectId === project.id
        : task.workstreams.some((ws) =>
            members.some((path) => pathKey(path) === pathKey(ws.projectPath)),
          )),
  );
}
export function SidebarTasksSection({
  cwd,
  activeSessionId,
  onSelectSession,
}: {
  cwd: string;
  activeSessionId?: string;
  onSelectSession: (id: string) => void;
}) {
  const raw = useSyncExternalStore(subscribeBoard, boardSnapshot);
  const { selected, projects } = useSavedProjects(cwd);
  const scopeKey = selected?.id ?? pathKey(cwd);
  const [allScope, setAllScope] = useState<string | null>(null);
  const allTasks = allScope === scopeKey;
  const boardTasks = useMemo(() => boardFromSnapshot(raw).tasks, [raw]);
  const tasks = allTasks
    ? boardTasks.filter((task) => !task.archived)
    : tasksForProject(boardTasks, cwd, selected);
  const details = (id: string) =>
    window.dispatchEvent(new CustomEvent(OPEN_TASK_EVENT, { detail: id }));
  return (
    <section
      className="mb-2 shrink-0 border-t border-content/6 px-2 pt-1"
      aria-label="Tasks"
    >
      <div className="flex items-center justify-between px-2 py-2 text-[11px] font-medium text-content/65">
        <span className="flex min-w-0 items-center gap-1">
          <span>Tasks</span>
          {selected && !allTasks && (
            <span
              className="max-w-20 truncate text-[10px] font-normal text-content/45"
              title={selected.name}
            >
              {selected.name}
            </span>
          )}
          {!!tasks.length && (
            <span className="text-[10px] font-normal text-content/50">
              {tasks.length}
            </span>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            aria-label={
              allTasks
                ? selected
                  ? "Show project tasks"
                  : "Show repository tasks"
                : "Show all tasks"
            }
            onClick={() => setAllScope(allTasks ? null : scopeKey)}
            className="rounded px-1 py-1 text-[10px] font-normal text-content/45 hover:bg-content/5 hover:text-content/80 focus-visible:outline-accent"
          >
            {allTasks ? (selected ? "Project only" : "Repo only") : "Show all"}
          </button>
          <button
            aria-label="New task"
            title="New task"
            className="grid size-6 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content focus-visible:outline-accent"
            onClick={() => window.dispatchEvent(new Event(NEW_TASK_EVENT))}
          >
            <Plus className="size-3" />
          </button>
        </div>
      </div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {tasks.map((task) => (
          <div
            key={task.id}
            className={`group flex items-center gap-1 rounded-lg ${activeSessionId && taskSessionIds(task).includes(activeSessionId) ? "bg-accent/8" : "hover:bg-content/5"}`}
          >
            <button
              title={`${task.title}${task.workstreams.length ? ` · ${task.workstreams.map((ws) => projectName(ws.projectPath)).join(" · ")}` : ""}`}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
              onClick={() =>
                task.primarySessionId
                  ? onSelectSession(task.primarySessionId)
                  : details(task.id)
              }
            >
              <ListBullet className="size-3.5 shrink-0 text-content/60" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-content/85">
                  {task.title}
                </span>
                {allTasks && (
                  <span className="block truncate text-[10px] text-content/45">
                    {projects.find((project) => project.id === task.projectId)
                      ?.name ??
                      (task.workstreams.length
                        ? [
                            ...new Set(
                              task.workstreams.map((lane) =>
                                projectName(lane.projectPath),
                              ),
                            ),
                          ].join(" · ")
                        : "No project")}
                  </span>
                )}
              </span>
            </button>
            <button
              aria-label={`${task.title} details`}
              title="Task details"
              className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-content/60 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-accent"
              onClick={() => details(task.id)}
            >
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      {!tasks.length && (
        <p className="px-2 pb-1 text-[11px] text-content/60">No tasks yet</p>
      )}
    </section>
  );
}
