import { TaskWorktreeManager } from "./TaskWorktreeControls";
import { assertTaskCopySelection, assertTaskWorktreeAvailable, detachTaskWorkingCopy, type TaskWorktreeActionHandler } from "./taskWorktrees";
import { UpdateBranchesDialog } from "./UpdateBranchesDialog";
import { TaskDeliveryPanel } from "./TaskDeliveryPanel";
import { EditTaskDialog } from "./EditTaskDialog";
import { TaskActionFeedback } from "./TaskActionFeedback";
import {
  TaskGitActions,
  withTaskGitLock,
} from "./TaskGitActions";
import { CiBadge, DeliverySettings } from "./DeliveryControls";
import type { HandoffKind } from "./handoff";
import {
  deliveryKey,
  snapshotIdentity,
  type SendToSession,
} from "./delivery";
import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { InboxProviderMark } from "../inbox/ui/InboxProviderMark";
import { Popover } from "../../shared/ui/Popover";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import {
  Archive,
  ArrowUp,
  Check,
  ChevronLeft,
  ArrowDownCircle,
  CheckCircle,
  ChevronRight,
  Download,
  ExternalLink,
  Folder,
  FolderTree,
  GitBranch,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Pencil,
  MoreHorizontal,
  Play,
  Plus,
  Trash2,
  WandSparkles,
  X,
} from "../../shared/ui/icons";
import { useDragResize } from "../../shared/hooks/useDragResize";
import { LAYER } from "../../shared/lib/layers";
import { formatRelativeTime, type InboxItem } from "../inbox/model/githubTasks";
import { pathKey, prettyCwd, projectName } from "../../shared/lib/paths";
import { gitTaskBranch, subscribeGitChanged } from "../../platform/tauri/fs";
import {
  storedBaseName,
} from "../source-control/hooks/useProjectBranches";
import { sameProjectPath, type RecentProject } from "../projects/model/recents";
import type { Session } from "../sessions/model/session";
import {
  linkedWorkItemInboxKey,
  sessionWorkItems,
} from "../sessions/model/sessionWorkItem";
import {
  cardAttentionLines,
  groupSwatch,
  lanePrSignal,
  sessionDotClass,
} from "./boardData";
import { LinkedIssueRow } from "./LinkedIssueRow";
import type {
  BoardCard,
  BoardWorkstreamRow,
  WorkstreamStatus,
} from "./boardData";
import { CreatePrsDialog, type PrSubmit } from "./CreatePrsDialog";
import {
  taskSessionIds,
  loadBoard,
  removeTask,
  renameLocalCard,
  updateTask,
  type TaskWorkstream,
} from "./boardStore";
import type { NewTaskSpec } from "./NewTaskDialog";
import {
  prIsOpen,
  resolveConflictPrompt,
  worktreeOnBranch,
  type WorkstreamResult,
} from "./taskOps";
import { attachTaskSession, detachTaskSession } from "./taskSession";

const ACTION =
  "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-content/55 hover:bg-content/8 hover:text-content disabled:opacity-40";

const SECONDARY_ACTION =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-content/10 bg-content/3 px-2.5 text-[11px] font-medium text-content/75 hover:bg-content/8 hover:text-content focus-visible:outline-accent disabled:opacity-40";

const WIDTH_KEY = "monocode.board.panelW";
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 272;

const savedPanelWidth = () => {
  const saved = localStorage.getItem(WIDTH_KEY);
  const value = saved === null ? DEFAULT_WIDTH : Number(saved);
  const cap = Math.max(MIN_WIDTH, window.innerWidth - 480);
  return Number.isFinite(value)
    ? Math.min(Math.max(value, MIN_WIDTH), cap)
    : DEFAULT_WIDTH;
};

function SectionLabel({ children }: { children: string }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
      {children}
    </h3>
  );
}

/** A lane — on ANY task — already bound to this worktree path. Two lanes on
 * one worktree share sessions' cwd and race every probe. Reads the store
 * fresh so a path claimed since render can't slip through. */
function laneClaimsPath(path: string, exceptId?: string): boolean {
  return loadBoard().tasks.some((entry) =>
    entry.workstreams.some(
      (ws) =>
        ws.id !== exceptId &&
        !!ws.worktreePath &&
        pathKey(ws.worktreePath) === pathKey(path),
    ),
  );
}

/** A worktree for the lane's branch already exists — confirm before binding
 * it (the create would fail in git anyway). */
function BindOfferBar({
  path,
  busy,
  onAccept,
  onDismiss,
}: {
  path: string;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="mt-1.5 flex items-center gap-1.5 rounded-md bg-accent/10 py-1 pl-1.5 pr-1 ring-1 ring-accent/20"
    >
      <FolderTree className="size-3 shrink-0 text-accent" strokeWidth={1.75} />
      <span
        className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-content/70"
        title={path}
      >
        Worktree exists — {prettyCwd(path)}
      </span>
      <button
        type="button"
        disabled={busy}
        title="Bind the lane to this worktree instead of creating a new one"
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
        onClick={onAccept}
      >
        Use it
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        disabled={busy}
        className="grid size-5 shrink-0 place-items-center rounded text-content/40 hover:bg-content/10 hover:text-content disabled:opacity-40"
        onClick={onDismiss}
      >
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}

/** Shared details-pane chrome: left-edge resize sash, collapse-to-strip,
 * header with title + collapse + close. Body/footer come from the caller. */
function PanelShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Right-edge pane — the sash sits on its left border, so dragging left
  // widens it (direction "left" inverts the delta).
  const resize = useDragResize({
    direction: "left",
    min: MIN_WIDTH,
    max: () => Math.max(MIN_WIDTH, window.innerWidth - 480),
    defaultWidth: DEFAULT_WIDTH,
    initial: savedPanelWidth(),
    onCommit: (width) => localStorage.setItem(WIDTH_KEY, String(width)),
  });

  if (collapsed) {
    // Slim strip keeps the selection alive — expand restores the saved width.
    // `key` matters: the resize hook writes pane width imperatively, and
    // without it React reuses this DOM node — the stale inline width would
    // override `w-9` and the strip would stay expanded.
    return (
      <aside
        key="collapsed"
        aria-label={`Details: ${title} (collapsed)`}
        className="flex w-9 shrink-0 flex-col items-center border-l border-stroke bg-content/[0.02] py-2"
      >
        <button
          type="button"
          aria-label="Expand details"
          onClick={() => setCollapsed(false)}
          className="grid size-6 place-items-center rounded-md text-content/45 outline-none hover:bg-content/8 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
        >
          <ChevronLeft className="size-3.5" strokeWidth={1.75} />
        </button>
        <span className="mt-3 min-h-0 flex-1 truncate text-[11px] text-content/40 [writing-mode:vertical-rl]">
          {title}
        </span>
      </aside>
    );
  }

  return (
    <aside
      ref={resize.setPaneRef}
      aria-label={`Details: ${title}`}
      className="relative flex shrink-0 flex-col border-l border-stroke bg-content/[0.02]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details panel"
        aria-valuenow={resize.width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={Math.max(MIN_WIDTH, window.innerWidth - 480)}
        className={`absolute inset-y-0 -left-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-content/15" : "hover:bg-content/10"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-stroke px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">
          {title}
        </span>
        <button
          type="button"
          aria-label="Collapse details"
          onClick={() => setCollapsed(true)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 outline-none hover:bg-content/8 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
        >
          <ChevronRight className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/8 hover:text-content"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      </header>
      {children}
    </aside>
  );
}

export function TaskDetailsPanel({
  card,
  lanes,
  items,
  recents,
  sessions,
  busyAction,
  results,
  onDismissResult,
  onClose,
  onOpenSession,
  onOpenWorkingCopy,
  onSessionCreated,
  onSendToSession,
  onHandoff,
  onSpawnSession,
  onPrepareWorktree,
  onTaskWorktreeAction,
  wsStatus,
  onUpdateBranches,
  onUpdateWorkstream,
  onSubmitPrs,
  onCleanupWorkstream,
  onGitDone,
}: {
  card: BoardCard;
  /** Every lane on the board, all tasks — ownership checks are board-wide:
   * a worktree or branch serves one lane, not one lane per task. */
  lanes: TaskWorkstream[];
  items: InboxItem[];
  recents: RecentProject[];
  sessions: Session[];
  /** Lane probe results — feeds the dialog's related-PR list. */
  wsStatus: ReadonlyMap<string, WorkstreamStatus>;
  /** Action currently running, e.g. "prs" | "merge" — disables buttons. */
  busyAction: ReadonlySet<string>;
  /** Latest bulk-action results, keyed by workstream id. */
  results: ReadonlyMap<string, WorkstreamResult>;
  /** Remove a lane's last action result (dismissed success/error banner). */
  onDismissResult: (workstreamId: string) => void;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenWorkingCopy?: (taskId: string, workstreamId: string) => void;
  onSessionCreated: (sessionId: string) => void;
  /** Open `sessionId` and submit `text` — used to hand a conflicted lane a
   * resolve prompt in a freshly spawned worktree session. */
  onSendToSession: SendToSession;
  onHandoff: (
    workstreamId: string,
    kind: HandoffKind,
    evidenceIds?: readonly string[],
  ) => void;
  onPrepareWorktree: (
    spec: NewTaskSpec["workstreams"][number],
  ) => Promise<string>;
  onTaskWorktreeAction?: TaskWorktreeActionHandler;
  onSpawnSession: (spec: NewTaskSpec["workstreams"][number]) => Promise<{
    sessionId: string;
    worktreePath: string;
  }>;
  onUpdateBranches: (refs: Record<string, string>) => void;
  onUpdateWorkstream: (workstreamId: string, ref: string) => void;
  /** Create-PR dialog submitted — `only` scopes the run to those lanes.
   * Resolves when the run finishes so the dialog can stay open on busy. */
  onSubmitPrs: (only: ReadonlySet<string>, opts: PrSubmit) => Promise<void>;
  /** Remove a merged lane's worktree via the App-level removal path and pin
   * its PR so the lane keeps probing it. Only called when offered. */
  onCleanupWorkstream: (workstreamId: string) => Promise<unknown>;
  onGitDone?: () => void;
}) {
  const task = card.task!;
  const [tab, setTab] = useState<"overview" | "pr" | "checks">("overview");
  const [repositoryId, setRepositoryId] = useState(
    task.workstreams[0]?.id ?? "",
  );
  const selectedRepository =
    task.workstreams.find((ws) => ws.id === repositoryId) ??
    task.workstreams[0];
  const [updateRows, setUpdateRows] = useState<TaskWorkstream[] | null>(null);
  const [editTask, setEditTask] = useState(false);
  const [taskMenu, setTaskMenu] = useState<HTMLElement | null>(null);
  const [removeArmed, setRemoveArmed] = useState(false);
  // An armed confirm must not survive the menu it lives in.
  useEffect(() => setRemoveArmed(false), [taskMenu]);
  const conversationIds = new Set(taskSessionIds(task));
  const conversations = [
    ...card.sessions,
    ...[...conversationIds]
      .filter((id) => !card.sessions.some((session) => session.id === id))
      .map((id) => ({
        id,
        title: "Saved conversation",
        busy: false,
        needsInput: false,
        live: false,
      })),
  ];
  // Links the user pinned — editable via the task dialog. Tickets resolved
  // from the inbox carry state; links are the authored identity.
  const linkedKeys = useMemo(
    () =>
      new Set(
        task.links.flatMap((link) =>
          sessionWorkItems({ linkedWorkItem: link }).map((item) =>
            linkedWorkItemInboxKey(item),
          ),
        ),
      ),
    [task.links],
  );
  useEffect(() => subscribeGitChanged(() => onGitDone?.()), [onGitDone]);
  const [editAt, setEditAt] = useState<{
    anchor: HTMLElement;
    workstreamId: string;
  } | null>(null);
  const [sourceLane, setSourceLane] = useState<string>();
  const [streamError, setStreamError] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  // Spawns a task-wide conversation on the first lane with a working copy —
  // spawn verifies the live checkout (missing copy, branch drift, git lock)
  // and attachTaskSession re-reads the task before writing the binding.
  const createConversation = async () => {
    if (creatingSession) return;
    const current = loadBoard().tasks.find((entry) => entry.id === task.id);
    if (!current) return;
    const ws = current.workstreams.find((row) => row.worktreePath);
    if (!ws) {
      setEditTask(true);
      return;
    }
    setCreatingSession(true);
    setStreamError("");
    try {
      const spawned = await onSpawnSession(ws);
      attachTaskSession(spawned.sessionId, ws, current.id, "task");
      onSessionCreated(spawned.sessionId);
    } catch (error) {
      setStreamError(String(error));
    } finally {
      setCreatingSession(false);
    }
  };
  /** A create that found a worktree already on the branch — confirm binds
   * that copy instead of failing. Always lane-scoped. */
  const [bindOffer, setBindOffer] = useState<{
    workstreamId: string;
    path: string;
  } | null>(null);
  /** Lanes the create-PR dialog is composing for — null when closed. */
  const [prDialog, setPrDialog] = useState<ReadonlySet<string> | null>(null);

  // Updater-form writes compose against the stored task — a render-time
  // copy goes stale while `onSpawnSession` awaits.
  const appendSession = (workstreamId: string, sessionId: string) =>
    updateTask(task.id, (current) => ({
      workstreams: current.workstreams.map((ws) =>
        ws.id === workstreamId && !(ws.sessionIds ?? []).includes(sessionId)
          ? { ...ws, sessionIds: [...(ws.sessionIds ?? []), sessionId] }
          : ws,
      ),
    }));

  /** A create that still hit "already has a working copy" — the probe raced
   * a worktree that appeared in between. Re-probe and offer the bind. */
  const offerOnCollision = async (
    error: unknown,
    projectPath: string,
    branch: string,
    offer: { workstreamId: string },
  ): Promise<boolean> => {
    if (!/already has a working copy/i.test(String(error))) return false;
    const tree = await worktreeOnBranch(projectPath, branch).catch(() => null);
    // Another lane already bound that worktree — a real error, not an offer.
    if (!tree || laneClaimsPath(tree.path, offer.workstreamId)) return false;
    setBindOffer({ path: tree.path, ...offer });
    return true;
  };

  /** Prepare or rebind a working copy without creating another conversation. */
  const prepareForRow = async (
    row: BoardWorkstreamRow,
    worktreePath?: string,
  ) => {
    const bound = worktreePath ?? row.worktreePath;
    const preparedPath = await onPrepareWorktree({
      projectPath: row.projectPath,
      branch: row.branch,
      base: row.base,
      remote: row.remote,
      ...(bound ? { worktreePath: bound } : {}),
    });
    updateTask(task.id, (current) => ({
      workstreams: current.workstreams.map((ws) =>
        ws.id === row.id
          ? {
              ...ws,
              // A rebind landed mid-prepare wins — writing the preparation's own
              // path would clobber the user's pick.
              worktreePath:
                ws.worktreePath === row.worktreePath
                  ? preparedPath
                  : ws.worktreePath,
            }
          : ws,
      ),
    }));
  };

  return (
    <PanelShell title={task.title} onClose={onClose}>
      <div className="@container flex shrink-0 items-center gap-3 border-b border-content/8 px-3">
        <div
          className="flex items-center gap-3"
          role="tablist"
          aria-label="Task details"
        >
          {(["overview", "pr", "checks"] as const).map((value) => (
            <button
              key={value}
              role="tab"
              id={`task-tab-${value}`}
              aria-controls={`task-pane-${value}`}
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onKeyDown={(event) => {
                const values = ["overview", "pr", "checks"] as const,
                  index = values.indexOf(value);
                const next =
                  event.key === "ArrowRight"
                    ? values[(index + 1) % 3]
                    : event.key === "ArrowLeft"
                      ? values[(index + 2) % 3]
                      : event.key === "Home"
                        ? values[0]
                        : event.key === "End"
                          ? values[2]
                          : undefined;
                if (next) {
                  event.preventDefault();
                  setTab(next);
                  document.getElementById(`task-tab-${next}`)?.focus();
                }
              }}
              className={`h-9 border-b-2 text-[12px] focus-visible:outline-accent ${tab === value ? "border-accent text-content" : "border-transparent text-content/50 hover:text-content"}`}
              onClick={() => setTab(value)}
            >
              {value === "overview"
                ? "Overview"
                : value === "checks"
                  ? "Checks"
                  : selectedRepository &&
                      wsStatus.get(selectedRepository.id)?.provider === "gitlab"
                    ? "Merge request"
                    : "Pull request"}
            </button>
          ))}
        </div>
        <button
          className={`ml-auto shrink-0 @max-[300px]:!px-2 ${SECONDARY_ACTION}`}
          aria-label="Edit task"
          title="Edit task"
          disabled={busyAction.size > 0}
          onClick={() => setEditTask(true)}
        >
          <Pencil className="size-3.5" />
          <span className="@max-[300px]:hidden">Edit task</span>
        </button>
      </div>
      {tab !== "overview" && (
        <div
          id={`task-pane-${tab}`}
          role="tabpanel"
          aria-labelledby={`task-tab-${tab}`}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
        >
          {task.workstreams.length > 1 && (
            <SearchableSelect
              label="Task repository"
              variant="row"
              value={selectedRepository?.id ?? ""}
              onChange={setRepositoryId}
              options={task.workstreams.map((ws) => ({
                value: ws.id,
                label: `${projectName(ws.projectPath)} · ${ws.branch}`,
              }))}
            />
          )}
          {selectedRepository ? (
            <TaskDeliveryPanel
              key={`${deliveryKey(selectedRepository)}:${tab}:${wsStatus.get(selectedRepository.id)?.delivery ? snapshotIdentity(wsStatus.get(selectedRepository.id)!.delivery!) : "pending"}`}
              task={task}
              ws={selectedRepository}
              status={wsStatus.get(selectedRepository.id)}
              tab={tab}
              sessions={sessions}
              onOpenSession={onOpenSession}
              onRefresh={onGitDone}
              onSources={() => setSourceLane(selectedRepository.id)}
              onHandoff={(kind, ids) =>
                onHandoff(selectedRepository.id, kind, ids)
              }
              onSend={onSendToSession}
              onSpawn={onSpawnSession}
            />
          ) : (
            <button className={ACTION} onClick={() => setEditTask(true)}>
              Add a repository
            </button>
          )}
        </div>
      )}
      {tab === "overview" && (
        <>
          <div
            id="task-pane-overview"
            role="tabpanel"
            aria-labelledby="task-tab-overview"
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-none px-3 py-3"
          >
            {/* Issues — the authored links first: they are what the task is
             * about. Resolved tickets add provider state. */}
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <SectionLabel>Issues</SectionLabel>
                {(card.tickets?.length ?? 0) > 0 && (
                  <span className="text-[10px] tabular-nums text-content/35">
                    {card.tickets!.length}
                  </span>
                )}
              </div>
              <button
                type="button"
                className={ACTION}
                onClick={() => setEditTask(true)}
              >
                <Plus className="size-3" strokeWidth={2} />
                Link
              </button>
            </div>
            <div className="flex flex-col">
              {(card.tickets ?? []).map((ticket) => (
                <LinkedIssueRow
                  key={ticket.key}
                  issue={ticket}
                  onEdit={
                    linkedKeys.has(ticket.key)
                      ? () => setEditTask(true)
                      : undefined
                  }
                />
              ))}
              {!card.tickets?.length ? (
                <p className="px-1.5 py-1 text-[12px] text-content/40">
                  No issues linked.
                </p>
              ) : null}
            </div>

            {/* Groups ---------------------------------------------------- */}
            <div className="mb-1.5 mt-5">
              <SectionLabel>Groups</SectionLabel>
            </div>
            <div className="flex flex-wrap items-center gap-1 px-1.5">
              {(card.groups ?? []).map((group) => {
                const swatch = groupSwatch(group.color);
                return (
                  <span
                    key={group.id}
                    className={`group inline-flex h-5 max-w-full items-center gap-1 rounded px-1.5 text-[11px] font-medium ${swatch.chip}`}
                  >
                    <span className="min-w-0 truncate">{group.name}</span>
                    <button
                      type="button"
                      aria-label={`Edit groups (${group.name} applied)`}
                      className="grid size-3 place-items-center rounded-sm opacity-0 hover:bg-content/15 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => setEditTask(true)}
                    >
                      <X className="size-2.5" strokeWidth={2.5} />
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                className="inline-flex h-5 items-center gap-0.5 rounded border border-dashed border-content/20 px-1.5 text-[10px] font-medium text-content/45 hover:border-content/40 hover:text-content"
                onClick={() => setEditTask(true)}
              >
                <Plus className="size-2.5" strokeWidth={2.5} />
                Group
              </button>
            </div>

            {/* Conversations ---------------------------------------------- */}
            <div className="mb-4 mt-5">
              <div className="mb-2 flex items-center justify-between">
                <SectionLabel>Conversations</SectionLabel>
                <span className="text-[10px] tabular-nums text-content/35">
                  {conversations.length}
                </span>
              </div>
              <ConversationList
                key={task.id}
                sessions={conversations}
                boundIds={conversationIds}
                primaryId={task.primarySessionId}
                onOpen={onOpenSession}
                onUnbind={detachTaskSession}
                onPrimary={(id) =>
                  updateTask(task.id, { primarySessionId: id })
                }
              />
              <button
                type="button"
                disabled={creatingSession || busyAction.size > 0}
                onClick={() => void createConversation()}
                className={ACTION}
              >
                <Plus className="size-3" />
                {creatingSession ? "Creating…" : "New conversation"}
              </button>
            </div>

            {/* Workstreams ---------------------------------------------- */}
            <div className="mb-2 mt-5">
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <SectionLabel>Repositories</SectionLabel>
                  {(card.workstreams?.length ?? 0) > 0 && (
                    <span className="ml-1.5 text-[10px] tabular-nums text-content/35">
                      {card.workstreams!.length}
                    </span>
                  )}
                </div>
                <TaskGitActions
                  all
                  disabled={busyAction.size > 0}
                  targets={task.workstreams}
                />
              </div>
            </div>
            {streamError && (
              <TaskActionFeedback
                title="Could not start the conversation"
                message={streamError}
                error
                onDismiss={() => setStreamError("")}
              />
            )}
            <div className="mt-1 flex flex-col gap-1.5">
              {(card.workstreams ?? []).map((row) => (
                <WorkstreamCard
                  key={row.id}
                  row={row}
                  onOpenWorkingCopy={onOpenWorkingCopy ? () => onOpenWorkingCopy(task.id, row.id) : undefined}
                  status={wsStatus.get(row.id)}
                  onHandoff={(kind) => onHandoff(row.id, kind)}
                  onChecks={() => {
                    setRepositoryId(row.id);
                    setTab("checks");
                  }}
                  result={results.get(row.id)}
                  onDismissResult={() => onDismissResult(row.id)}
                  busy={
                    busyAction.has("merge") ||
                    busyAction.has("prs") ||
                    busyAction.has(`merge:${row.id}`) ||
                    busyAction.has(`cleanup:${row.id}`)
                  }
                  onUpdate={() => {
                    const rows = task.workstreams.filter(
                      (ws) => ws.id === row.id && ws.worktreePath && ws.branch,
                    );
                    if (rows.length) setUpdateRows(rows);
                  }}
                  onPull={async () => {
                    const live = loadBoard()
                      .tasks.find((entry) => entry.id === task.id)
                      ?.workstreams.find((entry) => entry.id === row.id);
                    if (!live?.worktreePath)
                      throw new Error("This lane no longer has a worktree.");
                    // "update" = pull --ff-only; the backend re-verifies the
                    // checked-out branch and a clean tree before pulling.
                    await withTaskGitLock(
                      live.projectPath,
                      "pull",
                      () =>
                        gitTaskBranch(
                          live.worktreePath!,
                          live.branch,
                          "",
                          live.base,
                          "update",
                        ),
                    );
                  }}
                  gitBlocked={card.sessions.some((session) => session.busy)}
                  onCreatePr={() => setPrDialog(new Set([row.id]))}
                  onEdit={(anchor) =>
                    setEditAt({ anchor, workstreamId: row.id })
                  }
                  offer={
                    bindOffer?.workstreamId === row.id ? bindOffer : undefined
                  }
                  onOfferAccept={async () => {
                    const offer = bindOffer;
                    if (!offer) return;
                    // A sibling lane may have claimed this path since the
                    // offer rendered — binding it now would join two lanes
                    // on one worktree.
                    if (laneClaimsPath(offer.path, row.id))
                      throw new Error(
                        "That worktree already serves another lane",
                      );
                    await prepareForRow(row, offer.path);
                    setBindOffer(null);
                  }}
                  onOfferDismiss={() => setBindOffer(null)}
                  onPrepare={async () => {
                    if (!row.worktreePath) {
                      // A fresh worktree would collide with the branch's
                      // existing copy — offer to bind it instead of failing.
                      // A copy another lane already owns is a real error.
                      const clash = await worktreeOnBranch(
                        row.projectPath,
                        row.branch,
                      );
                      if (clash) {
                        if (laneClaimsPath(clash.path, row.id))
                          throw new Error(
                            "That worktree already serves another lane",
                          );
                        setBindOffer({
                          workstreamId: row.id,
                          path: clash.path,
                        });
                        return;
                      }
                    }
                    try {
                      await prepareForRow(row);
                    } catch (error) {
                      // The probe→create race can still collide — same offer,
                      // second chance instead of a dead-end error.
                      if (
                        await offerOnCollision(
                          error,
                          row.projectPath,
                          row.branch,
                          { workstreamId: row.id },
                        )
                      )
                        return;
                      throw error;
                    }
                  }}
                  onResolve={async () => {
                    // A fresh session bound to the conflicted worktree — bound
                    // sessions may run in the project root, but the merge state
                    // lives in the worktree, so the fix needs that cwd.
                    const spawned = await onSpawnSession({
                      projectPath: row.projectPath,
                      branch: row.branch,
                      base: row.base,
                      ...(row.worktreePath
                        ? { worktreePath: row.worktreePath }
                        : {}),
                    });
                    appendSession(row.id, spawned.sessionId);
                    if (
                      !(await onSendToSession(
                        spawned.sessionId,
                        resolveConflictPrompt(row),
                      ))
                    )
                      throw new Error("The agent did not accept the request.");
                  }}
                  onBind={() => setEditTask(true)}
                  onRemove={() => setEditTask(true)}
                  onCleanup={async () => {
                    await onCleanupWorkstream(row.id);
                  }}
                />
              ))}
              {!card.workstreams?.length ? (
                <p className="px-1.5 py-1 text-[12px] text-content/40">
                  Use Edit task to add a repository.
                </p>
              ) : null}
            </div>

            {/* Pull requests — lane PRs plus discovered items, one list so a
             * multi-repo task shows its whole PR surface. */}
            <RelatedPrs card={card} />
          </div>

          {/* Keep task actions on one row even in a narrow details panel. */}
          <div className="@container shrink-0 border-t border-stroke px-3 py-2">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-1.5">
              <button
                type="button"
                disabled={
                  busyAction.size > 0 ||
                  !(card.workstreams ?? []).some(
                    // A closed/merged PR doesn't block a replacement — only an
                    // open one does.
                    (row) => !row.pr || !prIsOpen(row.pr.state),
                  )
                }
                onClick={() =>
                  setPrDialog(
                    new Set(
                      (card.workstreams ?? [])
                        .filter((row) => !row.pr || !prIsOpen(row.pr.state))
                        .map((row) => row.id),
                    ),
                  )
                }
                title="Create PRs"
                className="inline-flex h-8 min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-accent/15 bg-accent/10 px-2.5 text-[11px] font-medium text-accent hover:bg-accent/20 focus-visible:outline-accent disabled:opacity-40"
              >
                {busyAction.has("prs") ? (
                  <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
                ) : (
                  <GitPullRequest className="size-3" strokeWidth={2} />
                )}
                Create PRs
              </button>
              <button
                type="button"
                disabled={
                  busyAction.size > 0 ||
                  !task.workstreams.some((ws) => ws.worktreePath && ws.branch)
                }
                onClick={() =>
                  setUpdateRows(
                    task.workstreams.filter((ws) => ws.worktreePath && ws.branch),
                  )
                }
                title="Merge into branches…"
                aria-label="Merge into branches…"
                className={`${SECONDARY_ACTION} min-w-0 whitespace-nowrap`}
              >
                {busyAction.has("merge") ? (
                  <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
                ) : (
                  <GitMerge className="size-3" strokeWidth={2} />
                )}
                <span className="@[360px]:hidden">Merge…</span>
                <span className="hidden @[360px]:inline">Merge into branches…</span>
              </button>
              <button
                type="button"
                aria-label="Task actions"
                title="Task actions"
                aria-haspopup="menu"
                aria-expanded={!!taskMenu}
                className={`!size-8 !px-0 ${SECONDARY_ACTION}`}
                onClick={(event) =>
                  setTaskMenu(taskMenu ? null : event.currentTarget)
                }
              >
                <MoreHorizontal className="size-4" />
              </button>
              {taskMenu && (
                <Popover
                  anchor={taskMenu}
                  align="end"
                  width={176}
                  role="menu"
                  aria-label="Task actions"
                  onDismiss={() => setTaskMenu(null)}
                  className="p-1"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[12px] text-red-600 hover:bg-red-500/8 focus-visible:outline-accent dark:text-red-400 ${removeArmed ? "bg-red-500/12" : ""}`}
                    onClick={() => {
                      if (!removeArmed) {
                        setRemoveArmed(true);
                        return;
                      }
                      removeTask(task.id);
                      onClose();
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    {removeArmed ? "Confirm removal" : "Remove task"}
                  </button>
                </Popover>
              )}
            </div>
          </div>
        </>
      )}
      {updateRows && (
        <UpdateBranchesDialog
          rows={updateRows}
          onClose={() => setUpdateRows(null)}
          onSubmit={(refs) => {
            if (updateRows.length === 1)
              onUpdateWorkstream(updateRows[0].id, refs[updateRows[0].id]);
            else onUpdateBranches(refs);
            setUpdateRows(null);
          }}
        />
      )}
      {editTask && (
        <EditTaskDialog
          task={task}
          recents={recents}
          items={items}
          sessions={sessions}
          onPrepareWorktree={onPrepareWorktree}
          onTaskWorktreeAction={onTaskWorktreeAction}
          onClose={() => setEditTask(false)}
        />
      )}
      {prDialog ? (
        <CreatePrsDialog
          task={task}
          rows={(card.workstreams ?? []).filter((row) => prDialog.has(row.id))}
          status={wsStatus}
          busy={busyAction.has("prs")}
          onSubmit={async (only, opts) => {
            // Stay open through the run — the busy state reports progress
            // and a failure's results are visible right after close.
            await onSubmitPrs(only, opts);
            setPrDialog(null);
          }}
          onCancel={() => setPrDialog(null)}
        />
      ) : null}
      {sourceLane &&
        (() => {
          const ws = task.workstreams.find((w) => w.id === sourceLane);
          return ws ? (
            <DeliverySettings
              ws={ws}
              snapshot={wsStatus.get(ws.id)?.delivery}
              onClose={() => setSourceLane(undefined)}
              onSave={(patch) =>
                updateTask(task.id, (current) => ({
                  workstreams: current.workstreams.map((w) =>
                    w.id === ws.id ? { ...w, ...patch } : w,
                  ),
                }))
              }
            />
          ) : null;
        })()}
      {editAt
        ? (() => {
            const editRow = card.workstreams?.find(
              (ws) => ws.id === editAt.workstreamId,
            );
            if (!editRow) return null;
            return (
              <WorkstreamEditor
                anchor={editAt.anchor}
                row={editRow}
                lanes={lanes}
                onPrepareWorktree={onPrepareWorktree}
                onTaskWorktreeAction={onTaskWorktreeAction}
                sessions={sessions}
                busy={
                  busyAction.has(`cleanup:${editRow.id}`) ||
                  card.sessions.some((session) => session.busy)
                }
                onPatch={(patch) =>
                  updateTask(task.id, (current) => ({
                    workstreams: current.workstreams.map((ws) =>
                      ws.id === editRow.id ? { ...ws, ...patch } : ws,
                    ),
                  }))
                }
                onRemoveWorktree={() => onCleanupWorkstream(editRow.id)}
                onClose={() => setEditAt(null)}
              />
            );
          })()
        : null}
    </PanelShell>
  );
}

/** Details for non-task cards — provider items and local notes. Read-mostly:
 * provider state, linked sessions, and the card's own actions at the bottom. */
export function CardDetailsPanel({
  card,
  onClose,
  onOpenSession,
  onStartItem,
  onPromote,
  onRemove,
}: {
  card: BoardCard;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onStartItem?: () => void;
  onPromote?: () => void;
  onRemove?: () => void;
}) {
  const lines = cardAttentionLines(card);
  const updated = card.updatedAt
    ? formatRelativeTime(new Date(card.updatedAt).toISOString())
    : "";
  return (
    <PanelShell title={card.title} onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-none px-3 py-3">
        {card.kind === "local" ? (
          <>
            <SectionLabel>Title</SectionLabel>
            <input
              key={card.id}
              defaultValue={card.title}
              aria-label="Card title"
              onBlur={(event) => renameLocalCard(card.id, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter")
                  (event.target as HTMLInputElement).blur();
              }}
              className="mt-1.5 w-full rounded-md bg-content/6 px-2 py-1.5 text-[12px] text-content outline-none focus:ring-1 focus:ring-accent/50"
            />
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {card.provider ? (
                <InboxProviderMark
                  provider={card.provider}
                  className="size-3.5 text-content/60"
                />
              ) : null}
              {card.identifier ? (
                <span className="max-w-full truncate rounded bg-content/8 px-1.5 py-0.5 text-[10px] font-medium text-content/60">
                  {card.identifier}
                </span>
              ) : null}
              {card.itemKind ? (
                <span className="rounded bg-content/8 px-1.5 py-0.5 text-[10px] font-medium text-content/60">
                  {card.itemKind === "pr" ? "Pull request" : "Issue"}
                </span>
              ) : null}
              {card.state ? (
                <span className="max-w-full truncate rounded bg-content/8 px-1.5 py-0.5 text-[10px] font-medium text-content/60">
                  {card.state}
                </span>
              ) : null}
              {card.draft ? (
                <span className="rounded bg-content/8 px-1.5 py-0.5 text-[10px] text-content/45">
                  Draft
                </span>
              ) : null}
            </div>
            {card.repo ? (
              <p className="mt-2 truncate text-[12px] text-content/50">
                {card.repo}
              </p>
            ) : null}
            {updated ? (
              <p className="mt-0.5 text-[11px] text-content/35">
                Updated {updated}
              </p>
            ) : null}
            {lines.length ? (
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {lines.map((line) => (
                  <span
                    key={line}
                    className="inline-flex max-w-full items-center rounded bg-accent/15 px-1.5 py-px text-[10px] font-medium text-accent"
                  >
                    <span className="min-w-0 truncate">{line}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        )}

        {card.sessions.length ? (
          <>
            <div className="mb-1.5 mt-5">
              <SectionLabel>Sessions</SectionLabel>
            </div>
            <div className="flex flex-col">
              {card.sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-content/4"
                  onClick={() => onOpenSession(session.id)}
                >
                  <span
                    aria-hidden
                    className={`size-1.5 shrink-0 rounded-full ${sessionDotClass(session)}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                    {session.title}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-stroke px-3 py-2">
        {card.url ? (
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-content/60 hover:bg-content/8 hover:text-content"
            onClick={() => void openUrl(card.url!)}
          >
            <ExternalLink className="size-3" strokeWidth={2} />
            Open in provider
          </button>
        ) : null}
        {card.kind === "item" && !card.sessions.length && onStartItem ? (
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent/15 px-2 text-[11px] font-medium text-accent hover:bg-accent/25"
            onClick={onStartItem}
          >
            <Play className="size-3" strokeWidth={2} />
            {card.itemKind === "pr" ? "Create review" : "Create task"}
          </button>
        ) : null}
        {card.kind === "local" && onPromote ? (
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-md bg-accent/15 px-2 text-[11px] font-medium text-accent hover:bg-accent/25"
            onClick={onPromote}
          >
            <ArrowUp className="size-3" strokeWidth={2} />
            Make task
          </button>
        ) : null}
        {card.kind === "local" && onRemove ? (
          <button
            type="button"
            aria-label="Remove card"
            className="ml-auto grid size-7 place-items-center rounded-md text-content/40 hover:bg-red-400/10 hover:text-red-300"
            onClick={() => {
              onRemove();
              onClose();
            }}
          >
            <Archive className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
    </PanelShell>
  );
}

function ConversationList({
  sessions,
  primaryId,
  boundIds,
  onOpen,
  onUnbind,
  onPrimary,
}: {
  sessions: BoardCard["sessions"];
  primaryId?: string;
  boundIds?: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onUnbind?: (id: string) => void;
  onPrimary?: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(
    primaryId ?? sessions[0]?.id ?? "",
  );
  const selected =
    sessions.find((session) => session.id === selectedId) ??
    sessions.find((session) => session.id === primaryId) ??
    sessions[0];
  if (!selected)
    return (
      <p className="mb-2 text-[11px] text-content/40">
        No conversations attached.
      </p>
    );
  const status = selected.needsInput
    ? "Needs input"
    : selected.busy
      ? "Working"
      : selected.live
        ? "Idle"
        : "Saved";
  return (
    <div className="mb-2 min-w-0">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <SearchableSelect
            label="Conversation"
            value={selected.id}
            options={sessions.map((session) => ({
              value: session.id,
              label: session.title,
              keywords: session.id === primaryId ? "task primary" : undefined,
            }))}
            onChange={setSelectedId}
            searchPlaceholder="Search conversations…"
            layer={LAYER.popover}
          />
        </div>
        <button
          type="button"
          onClick={() => onOpen(selected.id)}
          className="h-8 shrink-0 rounded-md bg-content/6 px-2.5 text-[11px] text-content/75 hover:bg-content/10"
        >
          Open
        </button>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 px-1 text-[10px] text-content/45">
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${sessionDotClass(selected)}`}
        />
        <span>
          {status}
          {selected.id === primaryId ? " · Task conversation" : ""}
        </span>
        {onPrimary &&
          boundIds?.has(selected.id) &&
          selected.id !== primaryId && (
            <button
              type="button"
              onClick={() => onPrimary(selected.id)}
              className="ml-auto rounded px-1 py-1 hover:bg-content/6 hover:text-content"
            >
              Use for task
            </button>
          )}
        {onUnbind &&
          boundIds?.has(selected.id) &&
          selected.id !== primaryId && (
            <button
              type="button"
              aria-label={`Detach ${selected.title}`}
              title="Detach conversation from task"
              onClick={() => onUnbind(selected.id)}
              className="grid size-6 shrink-0 place-items-center rounded hover:bg-content/6 hover:text-content"
            >
              <X className="size-3" />
            </button>
          )}
      </div>
    </div>
  );
}

/** Discovered pull requests not already shown on a lane — one list so a
 * multi-repo task surfaces its whole PR surface. */
function RelatedPrs({ card }: { card: BoardCard }) {
  const seen = new Set(
    (card.workstreams ?? []).map((row) => row.pr?.url).filter(Boolean),
  );
  const allPrs = (card.prs ?? [])
    .filter((pr) => !pr.url || !seen.has(pr.url))
    .map((pr) => ({ ...pr, lane: "" }));
  if (!allPrs.length) return null;
  return (
    <>
      <div className="mb-1.5 mt-5">
        <SectionLabel>Related pull requests</SectionLabel>
      </div>
      <div className="flex flex-col">
        {allPrs.map((pr) => (
          <div
            key={pr.id}
            className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-content/4"
          >
            <GitPullRequest
              className="size-3.5 shrink-0 text-content/50"
              strokeWidth={1.75}
            />
            <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
              {pr.title}
            </span>
            {pr.state ? (
              <span className="max-w-20 shrink-0 truncate text-[10px] capitalize text-content/40">
                {pr.state.toLowerCase()}
              </span>
            ) : null}
            {pr.url ? (
              <button
                type="button"
                aria-label={`Open pull request ${pr.title}`}
                className="grid size-5 shrink-0 place-items-center rounded text-content/35 hover:bg-content/10 hover:text-content"
                onClick={() => void openUrl(pr.url!)}
              >
                <ExternalLink className="size-3" strokeWidth={1.75} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

function WorkstreamCard({
  row,
  onOpenWorkingCopy,
  status,
  onHandoff,
  onChecks,
  result,
  onDismissResult,
  busy,
  onUpdate,
  onPull,
  gitBlocked,
  onCreatePr,
  onEdit,
  offer,
  onOfferAccept,
  onOfferDismiss,
  onPrepare,
  onResolve,
  onBind,
  onRemove,
  onCleanup,
}: {
  row: BoardWorkstreamRow;
  onOpenWorkingCopy?: () => void;
  status?: WorkstreamStatus;
  onHandoff: (kind: HandoffKind) => void;
  onChecks: () => void;
  result?: WorkstreamResult;
  onDismissResult: () => void;
  /** True while this lane's update or a task-wide op runs — sibling lanes
   * keep their own controls live. */
  busy: boolean;
  onUpdate: () => void;
  /** `git pull --ff-only` on the lane's own upstream — needs a bound copy. */
  onPull: () => Promise<void>;
  gitBlocked?: boolean;
  onCreatePr: () => void;
  onEdit: (anchor: HTMLElement) => void;
  /** A create found this branch's existing worktree — offer binds it. */
  offer?: { path: string };
  onOfferAccept: () => Promise<void>;
  onOfferDismiss: () => void;
  /** Prepare (or rebind) this lane's worktree — "Prepare worktree". */
  onPrepare: () => Promise<void>;
  onResolve: () => Promise<void>;
  onBind: () => void;
  onRemove: () => void;
  /** Remove the merged lane's worktree — only rendered when applicable. */
  onCleanup?: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<
    "spawn" | "resolve" | "cleanup" | "pull" | null
  >(null);
  const [armed, setArmed] = useState(false);
  const [actionError, setActionError] = useState("");
  const runAction = async (
    which: "spawn" | "resolve" | "cleanup" | "pull",
    fn: () => Promise<void>,
  ) => {
    setPending(which);
    setActionError("");
    try {
      await fn();
    } catch (error) {
      setActionError(String(error));
    } finally {
      setPending(null);
      setArmed(false);
    }
  };
  // MERGE_HEAD is the durable signal — probes refire right after an update
  // op and keep polling, so the banner clears once the merge concludes and
  // also covers conflicts created outside this flow.
  const conflicted = Boolean(row.merging);
  const mergeSignal = lanePrSignal(row);
  // Stored bases can be full `refs/remotes/…` refs from older builds — strip
  // to the `<remote>/<branch>` form anywhere the base is shown.
  const shownBase = row.base ? storedBaseName(row.base) : row.base;
  // A merged/closed lane keeps its worktree until cleaned up — offer it.
  const cleanupOffered =
    Boolean(row.worktreePath) && row.pr != null && !prIsOpen(row.pr.state);
  // Task-level ops (`busy`) and lane ops (`pending`) share the worktree —
  // neither may run while the other is in flight.
  const laneBusy = busy || pending !== null;
  // The banner hiding (PR reopened, worktree gone) must disarm the two-click
  // confirm — a stale "armed" state would turn the next render's first click
  // into an immediate delete.
  useEffect(() => {
    if (!cleanupOffered) setArmed(false);
  }, [cleanupOffered]);
  return (
    <div className="min-w-0 rounded-lg border border-content/8 px-2.5 py-2">
      <button
        type="button"
        aria-label={`${projectName(row.projectPath)} repository — ${row.branch}${row.sessions.length ? `, ${row.sessions.length} conversation${row.sessions.length === 1 ? "" : "s"}` : ""}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full items-center gap-2 rounded py-1 text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Folder
          className="size-3.5 shrink-0 text-content/40"
          strokeWidth={1.75}
        />
        <span
          className="min-w-0 flex-1 truncate text-[12px] font-medium text-content/85"
          title={row.projectPath}
        >
          {projectName(row.projectPath) || row.projectPath}
        </span>
        {row.sessions.length ? (
          <span
            className="flex shrink-0 items-center gap-0.5 text-[10px] text-content/40"
            title={`${row.sessions.length} bound conversation${row.sessions.length === 1 ? "" : "s"}`}
          >
            <MessageSquare className="size-3" strokeWidth={1.75} />
            {row.sessions.length}
          </span>
        ) : null}
        <ChevronRight
          className={`size-3.5 text-content/35 transition-transform group-hover:text-content/70 ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {onOpenWorkingCopy && <button type="button" className={ACTION} disabled={!row.worktreePath} onClick={onOpenWorkingCopy}>
        <FolderTree className="size-3" /> Open working copy
      </button>}
      <div
        className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-0.5 text-[11px] text-content/60"
        title={
          row.base
            ? `${row.branch} → ${storedBaseName(row.base)}`
            : row.branch
        }
      >
        <GitBranch
          className="size-3 shrink-0 text-content/40"
          strokeWidth={1.75}
        />
        <span className="min-w-0 truncate font-mono text-content/80">
          {row.branch}
        </span>
        {row.base ? (
          <span className="min-w-0 shrink truncate font-mono text-content/35">
            → {storedBaseName(row.base)}
          </span>
        ) : null}
      </div>
      {/* Status chips — the lane's PR + pipeline state at a glance. */}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {row.pr ? (
          <button
            type="button"
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset focus-visible:outline-accent ${
              row.pr.draft
                ? "bg-content/5 text-content/50 ring-content/10"
                : row.pr.state.toLowerCase() === "merged"
                  ? "bg-violet-500/12 text-violet-700 ring-violet-500/20 dark:text-violet-300"
                  : prIsOpen(row.pr.state)
                    ? "bg-emerald-500/12 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300"
                    : "bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300"
            } hover:brightness-110`}
            title={`${row.pr.title} — ${row.pr.state}`}
            onClick={() => void openUrl(row.pr!.url)}
          >
            {row.pr.state.toLowerCase() === "merged" ? (
              <GitMerge className="size-3" strokeWidth={1.75} />
            ) : (
              <GitPullRequest className="size-3" strokeWidth={1.75} />
            )}
            {row.pr.provider === "gitlab" ? "MR" : "PR"} #{row.pr.number} ·{" "}
            {row.pr.draft ? "Draft" : row.pr.state.toLowerCase()}
          </button>
        ) : null}
        {!row.pr && (
          <span className="px-1.5 text-[10px] text-content/40">
            {!status
              ? "Looking for PR…"
              : row.probeError
                ? "PR unavailable"
                : "No pull request"}
          </span>
        )}
        {row.pr && prIsOpen(row.pr.state) && (
          <button
            type="button"
            disabled={laneBusy}
            onClick={() => onHandoff("comments")}
            title="Review comments and hand off to an agent"
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ring-1 ring-inset hover:brightness-110 focus-visible:outline-accent disabled:opacity-40 ${row.pr.reviewDecision === "CHANGES_REQUESTED" ? "bg-amber-500/12 text-amber-700 ring-amber-500/20 dark:text-amber-300" : row.pr.reviewDecision === "APPROVED" ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/15 dark:text-emerald-300" : "bg-sky-500/10 text-sky-700 ring-sky-500/15 dark:text-sky-300"}`}
          >
            {row.pr.reviewDecision === "APPROVED" ? (
              <Check className="size-3" />
            ) : (
              <MessageSquare className="size-3" />
            )}
            {row.pr.reviewDecision === "CHANGES_REQUESTED"
              ? "Changes requested"
              : row.pr.reviewDecision === "APPROVED"
                ? "Approved"
                : "Review"}
            {!!row.pr.unresolvedThreads && (
              <span
                className="rounded bg-content/8 px-1 tabular-nums"
                title="Unresolved review threads"
              >
                {row.pr.unresolvedThreads}
              </span>
            )}
            <ChevronRight className="size-2.5 opacity-50" />
          </button>
        )}
        {mergeSignal === "ready" ? (
          <span
            className="flex items-center gap-1 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
            title="Approved, checks green, mergeable — land it on the provider"
          >
            <CheckCircle className="size-3" strokeWidth={1.75} />
            Ready
          </span>
        ) : mergeSignal === "conflicts" ? (
          <span
            className="rounded bg-red-400/15 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300"
            title="The provider reports merge conflicts"
          >
            Conflicts
          </span>
        ) : mergeSignal === "blocked" ? (
          <span
            className="rounded bg-red-400/15 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300"
            title="Merge blocked by branch policy/protection"
          >
            Blocked
          </span>
        ) : null}
        {mergeSignal === "behind" && !row.behind ? (
          <span
            className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300/90"
            title="The provider reports the PR is behind its base branch"
          >
            Behind base
          </span>
        ) : null}
        {row.behind ? (
          row.worktreePath ? (
            <button
              type="button"
              disabled={laneBusy}
              title={`${row.branch} is ${row.behind} commit${row.behind === 1 ? "" : "s"} behind ${shownBase} (last fetch) — click to merge`}
              aria-label={`${row.branch} is ${row.behind} commit${row.behind === 1 ? "" : "s"} behind ${shownBase} — merge`}
              className="flex items-center gap-0.5 rounded bg-content/8 px-1.5 py-0.5 text-[10px] font-medium text-content/55 hover:bg-content/12 hover:text-content disabled:opacity-40"
              onClick={onUpdate}
            >
              <ArrowDownCircle className="size-3" strokeWidth={1.75} />
              {row.behind}
            </button>
          ) : (
            <span
              title={`${row.branch} is ${row.behind} commit${row.behind === 1 ? "" : "s"} behind ${shownBase} (last fetch) — prepare a working copy to merge`}
              className="flex items-center gap-0.5 rounded bg-content/8 px-1.5 py-0.5 text-[10px] font-medium text-content/55"
            >
              <ArrowDownCircle className="size-3" strokeWidth={1.75} />
              {row.behind}
            </span>
          )
        ) : null}
        <CiBadge
          status={status}
          onFix={() => onHandoff("ci")}
          onDetails={onChecks}
        />
        {status?.delivery?.localHead &&
        status.delivery.localHead !== status.delivery.headSha ? (
          <span
            title={`The bound copy's HEAD ${status.delivery.localHead.slice(0, 8)} differs from the probed ${status.delivery.headSha.slice(0, 8)} — push or commit the difference`}
            className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300/90"
          >
            Local differs
          </span>
        ) : null}
      </div>
      <div className="mt-2.5 min-w-0 border-t border-content/6 pt-2">
        <TaskGitActions disabled={laneBusy} targets={[row]}>
          {row.worktreePath ? (
            <button
              type="button"
              disabled={laneBusy}
              onClick={(event) => onEdit(event.currentTarget)}
              title={prettyCwd(row.worktreePath)}
              className={`shrink-0 ${SECONDARY_ACTION}`}
            >
              <FolderTree className="size-3.5" />
              {pathKey(row.worktreePath) === pathKey(row.projectPath)
                ? "Main checkout"
                : "Worktree"}
              <ChevronRight className="size-3 text-content/30" />
            </button>
          ) : (
            <button
              type="button"
              disabled={laneBusy}
              onClick={() => void runAction("spawn", onPrepare)}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent/10 px-2 text-[11px] text-accent hover:bg-accent/20 disabled:opacity-40"
            >
              {pending === "spawn" ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              Prepare worktree
            </button>
          )}
        </TaskGitActions>
      </div>
      {row.merging && !expanded && (
        <button
          className="mt-1 text-[11px] text-red-500"
          onClick={() => setExpanded(true)}
        >
          Resolve merge conflict…
        </button>
      )}
      {expanded && (
        <div className="mt-2 border-t border-stroke pt-2">
          {row.pr && (
            <button
              type="button"
              onClick={() => void openUrl(row.pr!.url)}
              className="mb-2 flex w-full items-start gap-1.5 rounded text-left text-[11px] text-content/75 hover:text-content focus-visible:outline-accent"
            >
              <GitPullRequest className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{row.pr.title}</span>
              <ExternalLink className="mt-0.5 size-3 shrink-0 text-content/40" />
            </button>
          )}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[10px]">
            <dt className="text-content/40">Working copy</dt>
            <dd className="break-all text-content/65">
              {row.worktreePath ? prettyCwd(row.worktreePath) : "Not attached"}
            </dd>
            <dt className="text-content/40">Repository</dt>
            <dd className="break-all text-content/65">
              {prettyCwd(row.projectPath)}
            </dd>
          </dl>
          {/* Merge conflict — durable while MERGE_HEAD exists. Spawns a session
           * in this worktree with the resolve prompt. */}
          {conflicted ? (
            <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-red-400/10 py-1 pl-1.5 pr-1 ring-1 ring-red-400/20">
              <GitMerge
                className="size-3 shrink-0 text-red-700 dark:text-red-300"
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-red-700 dark:text-red-300">
                Merge conflict{shownBase ? ` — ${shownBase}` : ""}
              </span>
              <button
                type="button"
                disabled={laneBusy || !row.worktreePath}
                title={`Resolve the ${shownBase} merge with an agent in this worktree`}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
                onClick={() => void runAction("resolve", onResolve)}
              >
                {pending === "resolve" ? (
                  <LoaderCircle
                    className="size-3 animate-spin"
                    strokeWidth={2}
                  />
                ) : (
                  <WandSparkles className="size-3" strokeWidth={1.75} />
                )}
                Resolve
              </button>
            </div>
          ) : null}
          {/* Merged/closed PR — the worktree is litter. Two-click arm, then
           * `git worktree remove` (dirty worktrees still refuse). */}
          {cleanupOffered && onCleanup ? (
            <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-content/[0.04] py-1 pl-1.5 pr-1 ring-1 ring-content/10">
              <CheckCircle
                className="size-3 shrink-0 text-content/50"
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-content/60">
                PR {row.pr!.state} — worktree no longer needed
              </span>
              <button
                type="button"
                disabled={laneBusy}
                aria-pressed={armed}
                title={
                  armed
                    ? "Confirm — removes the worktree directory"
                    : "Remove this lane's worktree"
                }
                className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium disabled:opacity-40 ${
                  armed
                    ? "bg-red-400/15 text-red-300 hover:bg-red-400/25"
                    : "text-content/55 hover:bg-content/10 hover:text-content"
                }`}
                onClick={() =>
                  armed ? void runAction("cleanup", onCleanup) : setArmed(true)
                }
              >
                {pending === "cleanup" ? (
                  <LoaderCircle
                    className="size-3 animate-spin"
                    strokeWidth={2}
                  />
                ) : (
                  <Trash2 className="size-3" strokeWidth={1.75} />
                )}
                {armed ? "Remove?" : "Clean up"}
              </button>
            </div>
          ) : null}
          {/* Lane actions — separated from status by a hairline. */}
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1 border-t border-content/6 pt-1.5">
            <button
              type="button"
              disabled={laneBusy}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-40"
              title={`Merge ${shownBase} into ${row.branch}`}
              onClick={onUpdate}
            >
              <GitMerge className="size-3" strokeWidth={1.75} />
              Merge
            </button>

            {row.worktreePath ? (
              <button
                type="button"
                disabled={laneBusy || gitBlocked}
                className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-40"
                title={`Pull the upstream of ${row.branch} into this checkout — fast-forward only, refuses on a dirty copy`}
                onClick={() => void runAction("pull", onPull)}
              >
                {pending === "pull" ? (
                  <LoaderCircle
                    className="size-3 animate-spin"
                    strokeWidth={2}
                  />
                ) : (
                  <Download className="size-3" strokeWidth={1.75} />
                )}
                Pull
              </button>
            ) : null}

            <button
              type="button"
              disabled={laneBusy}
              className="rounded px-1 py-0.5 text-[11px] text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-40"
              onClick={onBind}
            >
              Attach conversation
            </button>
            {(!row.pr || !prIsOpen(row.pr.state)) && row.worktreePath ? (
              <button
                type="button"
                disabled={laneBusy}
                className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10 disabled:opacity-40"
                onClick={onCreatePr}
              >
                <GitPullRequest className="size-3" strokeWidth={1.75} />
                Create PR
              </button>
            ) : null}
          </div>
          <button
            disabled={laneBusy}
            className="mt-2 rounded text-[10px] text-content/35 hover:text-red-500 focus-visible:outline-accent disabled:opacity-40"
            onClick={onRemove}
          >
            Edit repository membership
          </button>
        </div>
      )}
      {row.probeError ? (
        <details className="mt-2 min-w-0 rounded-md bg-amber-500/8 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <summary className="cursor-pointer focus-visible:outline-accent">
            Worktree status unavailable
          </summary>
          <p className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {row.probeError}
          </p>
        </details>
      ) : null}
      {/* Bind offer — "create" found the branch's existing worktree. Rendered
       * outside the expanded block: Prepare worktree is a collapsed-state
       * action, so its offer must be too. */}
      {offer ? (
        <BindOfferBar
          path={offer.path}
          busy={laneBusy}
          onAccept={() => void runAction("spawn", onOfferAccept)}
          onDismiss={onOfferDismiss}
        />
      ) : null}
      {actionError && (
        <TaskActionFeedback
          title="Worktree action failed"
          message={actionError}
          error
          onDismiss={() => setActionError("")}
        />
      )}
      {result && (
        <TaskActionFeedback
          title={result.ok ? "Update completed" : "Update failed"}
          message={result.message}
          error={!result.ok}
          onDismiss={onDismissResult}
        />
      )}
    </div>
  );
}

/** Task details uses the same picker and management dialog as Edit task. */
export function WorkstreamEditor({
  row, lanes, busy, onPatch, onPrepareWorktree, onClose, onTaskWorktreeAction, sessions = [],
}: {
  anchor: HTMLElement;
  row: BoardWorkstreamRow;
  lanes: TaskWorkstream[];
  busy: boolean;
  onPatch: (patch: Partial<Pick<TaskWorkstream, "branch" | "base" | "worktreePath" | "prUrl">>) => void;
  onPrepareWorktree: (spec: NewTaskSpec["workstreams"][number]) => Promise<string>;
  onRemoveWorktree: () => Promise<unknown>;
  onClose: () => void;
  onTaskWorktreeAction?: TaskWorktreeActionHandler;
  sessions?: Session[];
}) {
  const [original] = useState(() => loadBoard().tasks.find(task => task.workstreams.some(lane => lane.id === row.id)));
  const target = {
    taskId: original?.id, laneId: row.id, projectPath: row.projectPath,
    path: row.worktreePath, branch: row.branch, base: row.base, prUrl: row.pr?.url, expectedTask: original,
  };
  const other = lanes.filter(lane => lane.id !== row.id);
  if (!onTaskWorktreeAction) return null;
  return <TaskWorktreeManager
    target={target} onAction={onTaskWorktreeAction} onApplied={() => {}}
    excludePaths={new Set(other.flatMap(lane => lane.worktreePath ? [pathKey(lane.worktreePath)] : []))}
    excludeBranches={new Set(other.filter(lane => sameProjectPath(lane.projectPath, row.projectPath)).map(lane => lane.branch))}
    sessionCount={row.sessions.length} disabled={busy}
    onPick={async tree => {
      assertTaskWorktreeAvailable(target, tree.path, tree.branch!);
      await assertTaskCopySelection(target, tree.path, sessions);
      const path = await onPrepareWorktree({ projectPath: row.projectPath, branch: tree.branch!, base: row.base, worktreePath: tree.path });
      assertTaskWorktreeAvailable(target, path, tree.branch!);
      await assertTaskCopySelection(target, path, sessions);
      onPatch({ branch: tree.branch!, worktreePath: path, prUrl: undefined });
    }}
    onDetach={async () => { await detachTaskWorkingCopy(target, sessions); }}
    onClose={onClose}
  />;
}
