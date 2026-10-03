import { TaskWorktreeManager } from "./TaskWorktreeControls";
import type { TaskWorktreeActionHandler, TaskWorktreeResult } from "./taskWorktrees";
import { taskWideSessionIds } from "./boardStore";
import { useRef, useState } from "react";
import { Modal } from "../../shared/ui/Modal";
import { Checkbox } from "../../shared/ui/Checkbox";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import { LAYER } from "../../shared/lib/layers";
import { pathKey, projectName } from "../../shared/lib/paths";
import type { RecentProject } from "../projects/model/recents";
import { sameProjectPath } from "../projects/model/recents";
import type { InboxItem } from "../inbox/model/githubTasks";
import { getSession } from "../sessions/data/sessionStore";
import { sessionWorkCwd, type Session } from "../sessions/model/session";
import { linkedWorkItemInboxKey } from "../sessions/model/sessionWorkItem";
import {
  WorkstreamFields,
  suggestedBranch,
  taskProjectOptions,
  type TaskWorkstreamSpec,
} from "./NewTaskDialog";
import { useSavedProjects } from "../projects/model/savedProjects";
import {
  loadBoard,
  MAX_WORKSTREAMS,
  newEntityId,
  updateTask,
  type BoardTask,
  type TaskWorkstream,
} from "./boardStore";
import { taskSessionCheckout, sessionTaskBindings } from "./taskSession";
import { deliveryKey } from "./delivery";
import { TaskTicketPicker } from "./TaskTicketPicker";
import { groupSwatch } from "./boardData";
import { Check, X } from "../../shared/ui/icons";
import { useTaskGitBusy, useTaskGitOperation } from "./TaskGitActions";

type EditLane = TaskWorkstream & { noWorktree?: boolean };
const action =
  "rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/5 focus-visible:outline-accent disabled:opacity-40";
const input =
  "h-9 w-full rounded-md border border-content/10 bg-background-base px-2.5 text-[13px] text-content outline-none placeholder:text-content/60 focus:border-content/25";

/** Validate staged membership against fresh Board and Git state before any preparation or save. */
export async function validateTaskEdit(
  original: BoardTask,
  draft: BoardTask,
  sessions: readonly Session[],
) {
  const tasks = loadBoard().tasks;
  const current = tasks.find(
    (task) => task.id === original.id && !task.archived,
  );
  if (!current || JSON.stringify(current) !== JSON.stringify(original))
    throw new Error(
      "Task changed while this editor was open. Reopen it before saving.",
    );
  if (
    !draft.title.trim() ||
    draft.title.length > 300 ||
    draft.workstreams.length > MAX_WORKSTREAMS
  )
    throw new Error("Enter a title and stay within the repository limit.");
  const copies = new Set<string>(),
    branches = new Set<string>(),
    members = new Set<string>();
  for (const lane of draft.workstreams) {
    if (!lane.projectPath || !lane.branch)
      throw new Error("Choose a repository and branch for each row.");
    const branch = JSON.stringify([pathKey(lane.projectPath), lane.branch]);
    if (
      branches.has(branch) ||
      (lane.worktreePath && copies.has(pathKey(lane.worktreePath)))
    )
      throw new Error(
        "A working copy or branch can belong to only one repository row.",
      );
    branches.add(branch);
    if (lane.worktreePath) copies.add(pathKey(lane.worktreePath));
    if (
      tasks.some(
        (task) =>
          task.id !== draft.id &&
          task.workstreams.some(
            (other) =>
              (lane.worktreePath &&
                other.worktreePath &&
                pathKey(lane.worktreePath) === pathKey(other.worktreePath)) ||
              (pathKey(lane.projectPath) === pathKey(other.projectPath) &&
                lane.branch === other.branch),
          ),
      )
    )
      throw new Error("Another task already owns this working copy or branch.");
    const before = original.workstreams.find((other) => other.id === lane.id);
    if (
      before &&
      (lane.branch !== before.branch ||
        lane.worktreePath !== before.worktreePath ||
        lane.projectPath !== before.projectPath) &&
      sessions.some(
        (session) =>
          (session.busy || session.worktreePreparing) &&
          (taskWideSessionIds(original).includes(session.id) ||
            (before.sessionIds ?? []).includes(session.id) ||
            (before.worktreePath &&
              pathKey(sessionWorkCwd(session)) ===
                pathKey(before.worktreePath))),
      )
    )
      throw new Error(
        "An agent is working in this copy. Wait before changing its binding.",
      );
    for (const id of lane.sessionIds ?? []) {
      if (
        members.has(id) ||
        sessionTaskBindings(
          tasks.filter((task) => task.id !== draft.id),
          id,
        ).length
      )
        throw new Error(
          "This conversation already belongs to another repository row or task.",
        );
      members.add(id);
      const session =
        sessions.find((session) => session.id === id) ?? (await getSession(id));
      if (!session)
        throw new Error("A selected conversation is no longer available.");
      const checkout = await taskSessionCheckout(session);
      if (
        !lane.worktreePath ||
        pathKey(checkout.worktreePath!) !== pathKey(lane.worktreePath) ||
        checkout.branch !== lane.branch
      )
        throw new Error(
          "A selected conversation does not match this working copy and branch. Detach it or keep its existing copy.",
        );
    }
  }
  for (const before of original.workstreams.filter(
    (lane) => !draft.workstreams.some((other) => other.id === lane.id),
  )) {
    if (
      sessions.some(
        (session) =>
          (session.busy || session.worktreePreparing) &&
          (taskWideSessionIds(original).includes(session.id) ||
            (before.sessionIds ?? []).includes(session.id) ||
            (before.worktreePath &&
              pathKey(sessionWorkCwd(session)) ===
                pathKey(before.worktreePath))),
      )
    )
      throw new Error(
        "Wait for the working agent before detaching its repository.",
      );
  }
  for (const id of taskWideSessionIds(draft)) {
    if (members.has(id)) continue;
    if (
      sessionTaskBindings(
        tasks.filter((task) => task.id !== draft.id),
        id,
      ).length
    )
      throw new Error("This conversation already belongs to another task.");
    const session =
      sessions.find((session) => session.id === id) ?? (await getSession(id));
    if (!session)
      throw new Error(
        id === draft.primarySessionId
          ? "The primary conversation is unavailable."
          : "A task-wide conversation is unavailable. Detach it before changing its checkout.",
      );
    const checkout = await taskSessionCheckout(session);
    if (
      !draft.workstreams.some(
        (lane) =>
          lane.worktreePath &&
          pathKey(lane.worktreePath) === pathKey(checkout.worktreePath!) &&
          lane.branch === checkout.branch,
      )
    )
      throw new Error(
        id === draft.primarySessionId
          ? "The primary conversation needs its original starting checkout. Keep it or choose another primary."
          : "A task-wide conversation needs its original starting checkout. Keep it or detach the conversation first.",
      );
    members.add(id);
  }
  if (draft.primarySessionId && !members.has(draft.primarySessionId))
    throw new Error(
      "Attach the primary conversation to a repository row first.",
    );
  // Recheck after awaited Git/session reads; another task may have claimed a selection.
  if (JSON.stringify(loadBoard().tasks) !== JSON.stringify(tasks))
    throw new Error(
      "Board membership changed. Reopen the editor before saving.",
    );
}

export function EditTaskDialog({
  task,
  recents,
  items,
  sessions,
  onPrepareWorktree,
  onTaskWorktreeAction,
  onClose,
}: {
  task: BoardTask;
  recents: RecentProject[];
  items: InboxItem[];
  sessions: Session[];
  onPrepareWorktree: (spec: TaskWorkstreamSpec) => Promise<string>;
  onTaskWorktreeAction?: TaskWorktreeActionHandler;
  onClose: () => void;
}) {
  const [original, setOriginal] = useState(task);
  const [managing, setManaging] = useState<string>();
  const liveSessions = useRef(sessions);
  liveSessions.current = sessions;
  const [title, setTitle] = useState(task.title);
  const [links, setLinks] = useState(task.links);
  const [groups, setGroups] = useState(task.groupIds ?? []);
  const [primary, setPrimary] = useState(task.primarySessionId);
  const [wideIds, setWideIds] = useState(() => taskWideSessionIds(task));
  const [lanes, setLanes] = useState<EditLane[]>(
    task.workstreams.map((lane) => ({
      ...lane,
      noWorktree: !lane.worktreePath,
      sessionIds: (lane.sessionIds ?? []).filter((id) => !wideIds.includes(id)),
    })),
  );
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState("");
  const gitBusy = useTaskGitBusy(lanes.map((lane) => lane.projectPath));
  const gitOp = useTaskGitOperation(lanes.map((lane) => lane.projectPath));
  const { projects: savedProjects } = useSavedProjects();
  const board = loadBoard();
  const projects = taskProjectOptions(recents, savedProjects);
  for (const lane of lanes)
    if (
      lane.projectPath &&
      !projects.some((project) =>
        sameProjectPath(project.value, lane.projectPath),
      )
    )
      projects.push({ value: lane.projectPath, label: lane.projectPath });
  const attached = new Set([
    ...wideIds,
    ...lanes.flatMap((lane) => lane.sessionIds ?? []),
  ]);
  const patchLane = (id: string, patch: Partial<EditLane>) =>
    setLanes((current) =>
      current.map((lane) => (lane.id === id ? { ...lane, ...patch } : lane)),
    );
  const applied = (laneId: string, result: TaskWorktreeResult) => {
    // Rebase only the action's lane metadata; title, tickets, groups and other row edits stay staged.
    if (result.task) {
      setOriginal(result.task);
      const removed = new Set(result.removedSessionIds ?? []);
      setWideIds(current => current.filter(id => !removed.has(id)));
      setPrimary(current => current && removed.has(current) ? undefined : current);
      setLanes(current => current.map(lane => {
        const savedBefore = original.workstreams.find(row => row.id === lane.id);
        const savedAfter = result.task!.workstreams.find(row => row.id === lane.id);
        const affected = savedBefore && savedAfter && (
          savedBefore.branch !== savedAfter.branch || savedBefore.worktreePath !== savedAfter.worktreePath
        );
        return {
          ...lane,
          ...(affected ? { branch: savedAfter.branch, worktreePath: savedAfter.worktreePath, base: savedAfter.base, prUrl: savedAfter.prUrl, noWorktree: !savedAfter.worktreePath } : {}),
          ...(lane.id === laneId && result.tree ? { branch: result.tree.branch!, worktreePath: result.tree.path, ...(result.base ? { base: result.base } : {}), prUrl: undefined } : {}),
          ...(lane.id === laneId && result.removedSessionIds ? { worktreePath: undefined, noWorktree: true } : {}),
          sessionIds: (lane.sessionIds ?? []).filter(id => !removed.has(id)),
        };
      }));
    }
  };
  const managedLane = lanes.find(lane => lane.id === managing);
  const targetFor = (lane: EditLane) => ({
    taskId: original.id, laneId: lane.id, projectPath: lane.projectPath,
    path: lane.worktreePath, branch: lane.branch, base: lane.base, expectedTask: original,
  });
  const claimedFor = (lane: EditLane) => {
    const other = [...loadBoard().tasks.filter(task => task.id !== original.id).flatMap(task => task.workstreams), ...lanes.filter(row => row.id !== lane.id)];
    return {
      paths: new Set(other.flatMap(row => row.worktreePath ? [pathKey(row.worktreePath)] : [])),
      branches: new Set(other.filter(row => sameProjectPath(row.projectPath, lane.projectPath)).map(row => row.branch)),
    };
  };
  const save = async () => {
    if (sending.current || gitBusy) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const prepared: string[] = [];
    try {
      const workstreams = lanes.map((lane) => {
        const before = original.workstreams.find((row) => row.id === lane.id);
        const repoChanged =
          before && !sameProjectPath(before.projectPath, lane.projectPath);
        // A pin belongs to the lane's old identity — a branch/copy retarget
        // must not keep probing the previous PR; a repo move drops the
        // provider and CI pins too.
        const stalePins =
          repoChanged ||
          (before &&
            (before.branch !== lane.branch ||
              before.worktreePath !== lane.worktreePath));
        return {
          ...lane,
          // A bound lane whose branch never synced must fail validation
          // with its own message — fabricating a suggested name would mask
          // it until mid-save bind verification.
          branch:
            lane.branch ||
            (lane.worktreePath ? "" : suggestedBranch(title, links)),
          base: lane.base || "HEAD",
          ...(stalePins
            ? {
                prUrl: undefined,
                ...(repoChanged ? { prProvider: undefined, ci: undefined } : {}),
              }
            : {}),
        };
      });
      const draft: BoardTask = {
        ...original,
        title: title.trim(),
        links,
        groupIds: groups,
        workstreams,
        primarySessionId: primary,
        taskSessionIds: wideIds,
      };
      await validateTaskEdit(original, draft, liveSessions.current);
      for (const lane of workstreams) {
        const before = original.workstreams.find((row) => row.id === lane.id);
        if (
          !lane.noWorktree &&
          (!before ||
            deliveryKey(before) !== deliveryKey(lane) ||
            !lane.worktreePath)
        ) {
          const creating = !lane.worktreePath;
          lane.worktreePath = await onPrepareWorktree(lane);
          // Only creates leave a stray copy on disk — binds reuse an
          // existing worktree, so they aren't "prepared" litter.
          if (creating) prepared.push(lane.worktreePath);
          // Preserve created copies if a later save fails, and make a retry bind them.
          patchLane(lane.id, { worktreePath: lane.worktreePath });
        }
      }
      await validateTaskEdit(original, draft, liveSessions.current);
      updateTask(original.id, {
        title: draft.title,
        links,
        groupIds: groups,
        primarySessionId: primary,
        taskSessionIds: wideIds,
        workstreams: workstreams.map(
          ({ noWorktree: _noWorktree, ...lane }) => lane,
        ),
      });
      onClose();
    } catch (reason) {
      setError(
        `${String(reason)}${prepared.length ? ` Prepared copies kept at: ${prepared.join(", ")}` : ""}`,
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
    <Modal
      title="Edit task"
      description="Update the tickets and working copies attached to this task."
      fitViewport
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="flex items-center justify-end gap-2 p-3">
          {gitOp ? (
            <p
              role="status"
              className="mr-auto min-w-0 truncate text-[11px] text-content/45"
            >
              Git is busy — {gitOp}
            </p>
          ) : null}
          <button className={action} disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className={`${action} bg-accent/10 text-accent`}
            disabled={busy || gitBusy || !title.trim()}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save task"}
          </button>
        </div>
      }
    >
      <fieldset disabled={busy} className="min-w-0 space-y-5 p-4">
        <label className="block space-y-1.5 text-[12px] text-content/70">
          Title
          <input
            aria-label="Task title"
            className={input}
            value={title}
            maxLength={300}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <section className="space-y-3">
          <h3 className="text-[12px] font-medium text-content/80">
            Repositories
          </h3>
          {lanes.map((lane) => {
            const otherLanes = [
              ...board.tasks
                .filter((task) => task.id !== original.id)
                .flatMap((task) => task.workstreams),
              ...lanes.filter((other) => other.id !== lane.id),
            ];
            const claimedCopies = new Set(
              otherLanes.flatMap((other) =>
                other.worktreePath ? [pathKey(other.worktreePath)] : [],
              ),
            );
            const claimedBranches = new Set(
              otherLanes
                .filter(
                  (other) =>
                    // "" is the auto-name sentinel, never a real claim.
                    other.branch &&
                    pathKey(other.projectPath) === pathKey(lane.projectPath),
                )
                .map((other) => other.branch),
            );
            const candidates = sessions.filter(
              (session) =>
                !wideIds.includes(session.id) &&
                !session.inboxAsk &&
                !session.orchestrationLeadId &&
                !session.worktreeRemoved &&
                !session.worktreePreparing &&
                lane.worktreePath &&
                pathKey(sessionWorkCwd(session)) ===
                  pathKey(lane.worktreePath) &&
                !sessionTaskBindings(
                  board.tasks.filter((task) => task.id !== original.id),
                  session.id,
                ).length &&
                (!attached.has(session.id) ||
                  lane.sessionIds?.includes(session.id)),
            );
            const ids = [
              ...new Set([
                ...(lane.sessionIds ?? []),
                ...candidates.map((session) => session.id),
              ]),
            ];
            const conversation = (id: string) => (
              <div key={id} className="px-2">
                <Checkbox
                  visibleLabel
                  label={
                    sessions.find((session) => session.id === id)?.title ||
                    `Saved conversation · ${id}`
                  }
                  checked={lane.sessionIds?.includes(id) ?? false}
                  onChange={() => {
                    patchLane(lane.id, {
                      sessionIds: lane.sessionIds?.includes(id)
                        ? lane.sessionIds.filter((entry) => entry !== id)
                        : [...(lane.sessionIds ?? []), id],
                    });
                    if (primary === id && lane.sessionIds?.includes(id))
                      setPrimary(undefined);
                  }}
                />
              </div>
            );
            return (
              <div key={lane.id} className="space-y-2">
                <WorkstreamFields
                  draft={lane}
                  management={onTaskWorktreeAction ? {
                    target: targetFor(lane), onAction: onTaskWorktreeAction,
                    onApplied: result => applied(lane.id, result),
                    onManage: () => setManaging(lane.id),
                    disabled: busy || liveSessions.current.some(session => (session.busy || session.worktreePreparing) && (taskWideSessionIds(original).includes(session.id) || lane.sessionIds?.includes(session.id))),
                  } : undefined}
                  onChange={(patch) => patchLane(lane.id, patch)}
                  layer={LAYER.dialogPopover}
                  excludeBranches={claimedBranches}
                  excludeWorktreePaths={claimedCopies}
                  tail={
                    <button
                      aria-label={`Detach ${projectName(lane.projectPath)}`}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/8 focus-visible:ring-1 focus-visible:ring-accent/60"
                      onClick={() =>
                        setLanes((current) =>
                          current.filter((row) => row.id !== lane.id),
                        )
                      }
                    >
                      <X className="size-3.5" />
                    </button>
                  }
                />
                {!!lane.sessionIds?.length && (
                  <p className="px-3 text-[11px] text-content/60">
                    Repository conversations
                  </p>
                )}
                {ids
                  .filter((id) => lane.sessionIds?.includes(id))
                  .map(conversation)}
                {ids.some((id) => !lane.sessionIds?.includes(id)) && (
                  <details className="px-3 text-[11px] text-content/60">
                    <summary className="cursor-pointer rounded py-1 hover:text-content focus-visible:outline-accent">
                      Add conversations (
                      {
                        ids.filter((id) => !lane.sessionIds?.includes(id))
                          .length
                      }
                      )
                    </summary>
                    <div className="space-y-1.5 pt-1">
                      {ids
                        .filter((id) => !lane.sessionIds?.includes(id))
                        .map(conversation)}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
          <SearchableSelect
            label="Add repository"
            value=""
            options={projects}
            placeholder="Add repository…"
            searchPlaceholder="Search repositories…"
            layer={LAYER.dialogPopover}
            disabled={lanes.length >= MAX_WORKSTREAMS}
            onChange={(projectPath) => {
              if (projectPath)
                setLanes((current) => [
                  ...current,
                  {
                    id: newEntityId("ws"),
                    projectPath,
                    worktreePath: projectPath,
                    branch: "",
                    base: "HEAD",
                  },
                ]);
            }}
          />
        </section>
        <div className="space-y-1.5">
          <p className="text-[12px] text-content/70">Primary conversation</p>
          <SearchableSelect
            label="Primary conversation"
            layer={LAYER.dialogPopover}
            value={primary ?? ""}
            onChange={(id) => setPrimary(id || undefined)}
            options={[
              { value: "", label: "No primary conversation" },
              ...[...new Set([...attached, ...(primary ? [primary] : [])])].map(
                (id) => ({
                  value: id,
                  label:
                    sessions.find((session) => session.id === id)?.title ||
                    `Saved conversation · ${id}`,
                }),
              ),
            ]}
          />
        </div>
        <TaskTicketPicker
          items={items}
          links={links}
          onToggle={(link) =>
            setLinks((current) =>
              current.some(
                (entry) =>
                  linkedWorkItemInboxKey(entry) ===
                  linkedWorkItemInboxKey(link),
              )
                ? current.filter(
                    (entry) =>
                      linkedWorkItemInboxKey(entry) !==
                      linkedWorkItemInboxKey(link),
                  )
                : [...current, link],
            )
          }
        />
        {!!board.groups.length && (
          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-content/60">
              Groups
            </h3>
            <div className="flex flex-wrap gap-1">
              {board.groups.map((group) => {
                const swatch = groupSwatch(group.color);
                const selected = groups.includes(group.id);
                return (
                  <button
                    key={group.id}
                    type="button"
                    aria-pressed={selected}
                    className={`inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${selected ? `${swatch.chip} ring-1 ring-current/30` : "bg-content/6 text-content/60 hover:bg-content/10"}`}
                    onClick={() =>
                      setGroups((current) =>
                        current.includes(group.id)
                          ? current.filter((id) => id !== group.id)
                          : [...current, group.id],
                      )
                    }
                  >
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${swatch.dot}`}
                    />
                    {group.name}
                    {selected && <Check className="size-2.5" />}
                  </button>
                );
              })}
            </div>
          </section>
        )}
        {error && (
          <p
            role="alert"
            className="whitespace-pre-wrap break-words text-[12px] text-red-700 dark:text-red-400"
          >
            {error}
          </p>
        )}
      </fieldset>
    </Modal>
    {managedLane && onTaskWorktreeAction && <TaskWorktreeManager
      key={`${managedLane.id}:${managedLane.worktreePath}:${managedLane.branch}`}
      target={targetFor(managedLane)} onAction={onTaskWorktreeAction}
      onApplied={result => applied(managedLane.id, result)}
      onPick={tree => patchLane(managedLane.id, { worktreePath: tree.path, branch: tree.branch!, noWorktree: false })}
      onDetach={() => patchLane(managedLane.id, { worktreePath: undefined, noWorktree: true })}
      excludePaths={claimedFor(managedLane).paths} excludeBranches={claimedFor(managedLane).branches}
      sessionCount={sessions.filter(session => managedLane.worktreePath && pathKey(sessionWorkCwd(session)) === pathKey(managedLane.worktreePath)).length}
      disabled={busy || sessions.some(session => (session.busy || session.worktreePreparing) && (taskWideSessionIds(original).includes(session.id) || managedLane.sessionIds?.includes(session.id)))}
      staged onClose={() => setManaging(undefined)} />}
    </>
  );
}
