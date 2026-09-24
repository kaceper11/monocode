import { TaskGitActions, useTaskGitBusy } from "./TaskGitActions";
import { CiBadge, DeliverySettings } from "./DeliveryControls";
import type { HandoffKind } from "./AgentHandoffDialog";
import { PROVIDER_NAMES, type SendToSession } from "./delivery";
import { useEffect, useMemo, useRef, useState } from "react";
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
  ExternalLink,
  Folder,
  FolderTree,
  GitBranch,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Play,
  Plus,
  Search,
  Trash2,
  WandSparkles,
  X,
} from "../../shared/ui/icons";
import { useDragResize } from "../../shared/hooks/useDragResize";
import { LAYER } from "../../shared/lib/layers";
import {
  formatRelativeTime,
  inboxItemRef,
  type InboxItem,
} from "../inbox/model/githubTasks";
import { pathKey, prettyCwd, projectName } from "../../shared/lib/paths";
import { gitBranches, gitTaskBranch, subscribeGitChanged } from "../../platform/tauri/fs";
import {
  taskBranchOptions,
  taskBranchChoice,
  useProjectBranchesState,
} from "../source-control/hooks/useProjectBranches";
import { useProjectWorktrees } from "../source-control/hooks/useProjectWorktrees";
import { bindableWorktrees } from "../source-control/model/worktrees";
import { sameProjectPath, type RecentProject } from "../projects/model/recents";
import type { LinkedWorkItem, Session } from "../sessions/model/session";
import {
  linkedWorkItemInboxKey,
  sessionWorkItems,
} from "../sessions/model/sessionWorkItem";
import {
  boardTicketOptions,
  cardAttentionLines,
  groupSwatch,
  lanePrSignal,
  linkBundleFromLinks,
  providerStage,
  sessionDotClass,
} from "./boardData";
import type {
  BoardCard,
  BoardWorkstreamRow,
  WorkstreamStatus,
} from "./boardData";
import { CreatePrsDialog, type PrSubmit } from "./CreatePrsDialog";
import {
  createGroup,
  loadBoard,
  MAX_TASK_GROUPS,
  MAX_WORKSTREAMS,
  newEntityId,
  removeTask,
  renameLocalCard,
  updateTask,
  type BoardGroup,
  type TaskWorkstream,
} from "./boardStore";
import {
  baseBranchOptions,
  resolveLaneBranch,
  suggestedBranch,
  WorkstreamFields,
  worktreeLaneOptions,
  workstreamProjectOptions,
  type NewTaskSpec,
} from "./NewTaskDialog";
import {
  prIsOpen,
  resolveConflictPrompt,
  shortError,
  worktreeOnBranch,
  type WorkstreamResult,
} from "./taskOps";


const ACTION =
  "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-content/55 hover:bg-content/8 hover:text-content disabled:opacity-40";

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

/** Ticket picker popover — inbox items not already linked to the task. */
function TicketPicker({
  anchor,
  items,
  exclude,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  items: InboxItem[];
  exclude: Set<string>;
  onPick: (linked: LinkedWorkItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const options = boardTicketOptions(items, query, exclude, 40);
  return (
    <Popover
      anchor={anchor}
      width={300}
      maxHeight={320}
      onDismiss={onClose}
      className="flex flex-col overflow-hidden p-1"
    >
      <label className="relative mb-1 flex items-center">
        <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tickets…"
          aria-label="Search tickets"
          className="h-7 w-full rounded-md bg-content/6 pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/40"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
        {options.map(({ item, linked }) => (
          <button
            key={linkedWorkItemInboxKey(linked)}
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-content/6"
            onClick={() => {
              onPick(linked);
              onClose();
            }}
          >
            <InboxProviderMark
              provider={item.provider}
              className="size-3.5 shrink-0 text-content/60"
            />
            <span className="max-w-28 shrink-0 truncate rounded bg-content/8 px-1 py-px text-[10px] font-medium text-content/55">
              {inboxItemRef(item)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
              {item.title}
            </span>
          </button>
        ))}
        {!options.length ? (
          <p className="px-2 py-2 text-[12px] text-content/40">
            No matching inbox items.
          </p>
        ) : null}
      </div>
    </Popover>
  );
}

/** Session picker — live sessions in a project that aren't task-bound. */
function SessionPicker({
  anchor,
  sessions,
  projectPath,
  bound,
  linkKeys,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  sessions: Session[];
  projectPath: string;
  /** Session ids already bound to a workstream — excluded so a pick
   * can't silently steal one from another lane. */
  bound: ReadonlySet<string>;
  /** Inbox keys of this task's tickets — a session linked to work outside
   * this set would lose its link bundle if bound here. */
  linkKeys: ReadonlySet<string>;
  onPick: (sessionId: string) => void;
  onClose: () => void;
}) {
  const options = sessions.filter((session) => {
    if (
      session.inboxAsk ||
      session.orchestrationLeadId ||
      bound.has(session.id) ||
      !sameProjectPath(session.cwd, projectPath)
    )
      return false;
    // Binding overwrites the session's link bundle — a session carrying
    // items this task doesn't have would silently lose that association.
    const linked = sessionWorkItems(session);
    return linked.every((item) =>
      linkKeys.has(linkedWorkItemInboxKey(item)),
    );
  });
  return (
    <Popover
      anchor={anchor}
      width={280}
      maxHeight={280}
      onDismiss={onClose}
      className="overflow-y-auto overscroll-none p-1"
    >
      {options.map((session) => (
        <button
          key={session.id}
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-content/6"
          onClick={() => {
            onPick(session.id);
            onClose();
          }}
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${
              session.busy ? "bg-emerald-400" : "bg-content/25"
            }`}
          />
          <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
            {session.title}
          </span>
        </button>
      ))}
      {!options.length ? (
        <p className="px-2 py-2 text-[12px] text-content/40">
          No conversations in this project.
        </p>
      ) : null}
    </Popover>
  );
}

/** Group assign picker — toggle which groups this task carries. Group
 * management (rename/delete) lives in the board header's Groups popover. */
function GroupAssign({
  anchor,
  groups,
  assigned,
  onToggle,
  onClose,
}: {
  anchor: HTMLElement;
  groups: BoardGroup[];
  assigned: string[];
  onToggle: (groupId: string) => void;
  onClose: () => void;
}) {
  const [newName, setNewName] = useState("");
  const assignedSet = new Set(assigned);
  const submitNew = () => {
    const id = createGroup(newName);
    if (id) {
      onToggle(id);
      setNewName("");
    }
  };
  return (
    <Popover
      anchor={anchor}
      width={220}
      maxHeight={280}
      onDismiss={onClose}
      className="flex flex-col overflow-hidden p-1"
      aria-label="Assign groups"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
        {groups.map((group) => {
          const swatch = groupSwatch(group.color);
          const isAssigned = assignedSet.has(group.id);
          return (
            <button
              key={group.id}
              type="button"
              aria-pressed={isAssigned}
              aria-label={`${isAssigned ? "Remove" : "Assign"} group ${group.name}`}
              className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-content/6"
              onClick={() => onToggle(group.id)}
            >
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${swatch.dot}`}
              />
              <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                {group.name}
              </span>
              {isAssigned ? (
                <Check
                  className="size-3.5 shrink-0 text-accent"
                  strokeWidth={2.5}
                />
              ) : null}
            </button>
          );
        })}
        {!groups.length ? (
          <p className="px-2 py-2 text-[12px] text-content/40">
            No groups yet — create one below.
          </p>
        ) : null}
      </div>
      <label className="mt-1 flex h-7 shrink-0 items-center gap-1.5 border-t border-stroke px-1.5 pt-1 text-content/40 focus-within:text-content/60">
        <Plus className="size-3 shrink-0" strokeWidth={2} />
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitNew();
          }}
          placeholder="New group…"
          aria-label="New group name"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/40"
        />
      </label>
    </Popover>
  );
}

/** Add-workstream row — the dialog's fields with a compact submit tail. */
function AddWorkstreamRow({
  recents,
  lanes,
  busy,
  onAdd,
  onCancel,
}: {
  recents: RecentProject[];
  /** All board lanes — claimed worktree paths are hidden from the picker
   * (a pick that can only fail at submit is worse than no option). */
  lanes: TaskWorkstream[];
  busy: boolean;
  onCancel: () => void;
  onAdd: (spec: {
    projectPath: string;
    branch: string;
    base: string;
    worktreePath?: string;
  }) => void;
}) {
  const [draft, setDraft] = useState<{
    projectPath: string;
    branch: string;
    base: string;
    worktreePath?: string;
  }>({
    projectPath: "",
    branch: "",
    base: "",
  });
  const projects = useMemo(() => workstreamProjectOptions(recents), [recents]);
  const claimedPaths = useMemo(
    () =>
      new Set(
        lanes
          .filter(
            (ws) =>
              !!ws.worktreePath &&
              sameProjectPath(ws.projectPath, draft.projectPath),
          )
          .map((ws) => pathKey(ws.worktreePath!)),
      ),
    [lanes, draft.projectPath],
  );
  const claimedBranches = useMemo(
    () =>
      new Set(
        lanes
          .filter((ws) => sameProjectPath(ws.projectPath, draft.projectPath))
          .map((ws) => ws.branch),
      ),
    [lanes, draft.projectPath],
  );
  return (
    <div className="mt-1.5">
      <WorkstreamFields
        draft={draft}
        projects={projects}
        compact
        excludeWorktreePaths={claimedPaths}
        excludeBranches={claimedBranches}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        tail={
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" disabled={busy} onClick={onCancel}
              className="rounded-md px-3 py-1.5 text-[12px] hover:bg-content/8 disabled:opacity-40">Cancel</button>
            <button type="button" disabled={busy || !draft.projectPath}
              onClick={() => onAdd({ ...draft, base: draft.base || "HEAD" })}
              className="rounded-md bg-accent/15 px-3 py-1.5 text-[12px] text-accent hover:bg-accent/25 disabled:opacity-40">
              {busy ? "Preparing…" : "Add repository"}
            </button>
          </div>
        }
      />
    </div>
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
    <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-accent/10 py-1 pl-1.5 pr-1 ring-1 ring-accent/20">
      <FolderTree
        className="size-3 shrink-0 text-accent"
        strokeWidth={1.75}
      />
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
  onRenameTitle,
  onClose,
  children,
}: {
  title: string;
  /** Commit a renamed title — the header becomes an editable input. */
  onRenameTitle?: (title: string) => void;
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
        {onRenameTitle ? (
          <input
            key={title}
            defaultValue={title}
            aria-label="Task title"
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next && next !== title) onRenameTitle(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                // Revert-and-blur is this keypress's whole job — don't let
                // the board-level handler read it as "close the board".
                event.preventDefault();
                event.currentTarget.value = title;
                event.currentTarget.blur();
              }
            }}
            className="-mx-1 min-w-0 flex-1 truncate rounded bg-transparent px-1 text-[13px] font-medium text-content outline-none focus:bg-content/6"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">
            {title}
          </span>
        )}
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
  onClose,
  onOpenSession,
  onSessionCreated,
  onSendToSession,
  onHandoff,
  onSpawnSession,
  onPrepareWorktree,
  onBindSession,
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
  busyAction: string;
  /** Latest bulk-action results, keyed by workstream id. */
  results: ReadonlyMap<string, WorkstreamResult>;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onSessionCreated: (sessionId: string) => void;
  /** Open `sessionId` and submit `text` — used to hand a conflicted lane a
   * resolve prompt in a freshly spawned worktree session. */
  onSendToSession: SendToSession;
  onHandoff: (workstreamId: string, kind: HandoffKind) => void;
  onPrepareWorktree: (spec: NewTaskSpec["workstreams"][number]) => Promise<string>;
  onSpawnSession: (spec: NewTaskSpec["workstreams"][number]) => Promise<{
    sessionId: string;
    worktreePath: string;
  }>;
  onBindSession: (sessionId: string, linked: LinkedWorkItem | null) => void;
  onUpdateBranches: () => void;
  onUpdateWorkstream: (workstreamId: string) => void;
  /** Create-PR dialog submitted — `only` scopes the run to those lanes.
   * Resolves when the run finishes so the dialog can stay open on busy. */
  onSubmitPrs: (only: ReadonlySet<string>, opts: PrSubmit) => Promise<void>;
  /** Remove a merged lane's worktree via the App-level removal path and pin
   * its PR so the lane keeps probing it. Only called when offered. */
  onCleanupWorkstream: (workstreamId: string) => Promise<unknown>;
  onGitDone?: () => void;
}) {
  const task = card.task!;
  const conversationIds = new Set([task.primarySessionId, ...task.workstreams.flatMap(ws => ws.sessionIds ?? [])].filter((id): id is string => !!id));
  const conversations = [...card.sessions, ...[...conversationIds].filter(id => !card.sessions.some(session => session.id === id)).map(id => ({ id, title: "Saved conversation", busy: false, needsInput: false, live: false }))];
  useEffect(() => subscribeGitChanged(() => onGitDone?.()), [onGitDone]);
  const [addTicketAt, setAddTicketAt] = useState<HTMLElement | null>(null);
  const [groupMenuAt, setGroupMenuAt] = useState<HTMLElement | null>(null);
  const [bindAt, setBindAt] = useState<{
    anchor: HTMLElement;
    workstreamId: string;
  } | null>(null);
  const [editAt, setEditAt] = useState<{
    anchor: HTMLElement;
    workstreamId: string;
  } | null>(null);
  const [showAddStream, setShowAddStream] = useState(false);
  const [sourceLane, setSourceLane] = useState<string>();
  const [addingStream, setAddingStream] = useState(false);
  const [streamError, setStreamError] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const createPrimarySession = async () => {
    if (creatingSession) return;
    const current = loadBoard().tasks.find((entry) => entry.id === task.id);
    if (!current) return;
    if (current.primarySessionId) { onOpenSession(current.primarySessionId); return; }
    const ws = current.workstreams.find((row) => row.worktreePath);
    if (!ws) { setShowAddStream(true); return; }
    setCreatingSession(true);
    setStreamError("");
    try {
      const spawned = await onSpawnSession(ws);
      updateTask(task.id, { primarySessionId: spawned.sessionId });
      onSessionCreated(spawned.sessionId);
    } catch (error) {
      setStreamError(shortError(error));
    } finally {
      setCreatingSession(false);
    }
  };
  /** A create that found a worktree already on the branch — confirm binds
   * that copy instead of failing. Lane-scoped when `workstreamId` is set. */
  const [bindOffer, setBindOffer] = useState<{
    workstreamId?: string;
    path: string;
    /** Add-row offers re-run the full spec on accept. */
    spec?: { projectPath: string; branch: string; base: string };
  } | null>(null);
  /** Lanes the create-PR dialog is composing for — null when closed. */
  const [prDialog, setPrDialog] = useState<ReadonlySet<string> | null>(null);

  const linkKeys = useMemo(
    () => new Set(task.links.map((link) => linkedWorkItemInboxKey(link))),
    [task.links],
  );
  // Fresh read — `task` gets a new identity on every store write, and
  // `groupMenuAt` re-reads on each picker open, so renames/deletes from the
  // board header can't leave this stale.
  const allGroups = useMemo(() => loadBoard().groups, [task, groupMenuAt]);
  // Session ids already owned by any task workstream — read fresh when the
  // picker opens so a pick can't steal a binding from another task.
  const boundSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of loadBoard().tasks) {
      if (entry.primarySessionId) ids.add(entry.primarySessionId);
      for (const ws of entry.workstreams)
        for (const id of ws.sessionIds ?? []) ids.add(id);
    }
    return ids;
  }, [bindAt]);
  // Bound sessions carry the same link bundle spawned sessions get.
  const linkBundle = useMemo(
    () => linkBundleFromLinks(task.links),
    [task.links],
  );

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

  const toggleGroup = (groupId: string) =>
    updateTask(task.id, (current) => ({
      groupIds: current.groupIds?.includes(groupId)
        ? current.groupIds.filter((id) => id !== groupId)
        : [...(current.groupIds ?? []), groupId].slice(0, MAX_TASK_GROUPS),
    }));

  /** A lane — on ANY task — already bound to this worktree path. Two lanes
   * on one worktree share sessions' cwd and race every probe. Reads the
   * store fresh so a path claimed since render can't slip through. */
  const laneOwnsPath = (path: string, exceptId?: string) =>
    loadBoard().tasks.some((entry) =>
      entry.workstreams.some(
        (ws) =>
          ws.id !== exceptId &&
          !!ws.worktreePath &&
          pathKey(ws.worktreePath) === pathKey(path),
      ),
    );

  const addWorkstream = async (spec: {
    projectPath: string;
    branch: string;
    base: string;
    worktreePath?: string;
  }) => {
    setAddingStream(true);
    setStreamError("");
    const resolved = spec.worktreePath
      ? spec.branch
      : resolveLaneBranch(
          spec.projectPath,
          spec.branch,
          // Fresh list — the cache can lag a branch created outside the
          // app; wrapping a real branch in `mc/` would silently fork it.
          await gitBranches(spec.projectPath).catch(() => null),
        ) || suggestedBranch(task.title, task.links);
    try {
      // Cap check before spawn — `updateTask` failing after the worktree +
      // session exist would orphan both.
      if (task.workstreams.length >= MAX_WORKSTREAMS)
        throw new Error(`A task can hold at most ${MAX_WORKSTREAMS} lanes.`);
      // A branch lives in at most one worktree — two lanes on it would
      // race every spawn and probe, same bound worktree the same story.
      // Claims are board-wide: another task's lane owns it just as much.
      if (
        loadBoard().tasks.some((entry) =>
          entry.workstreams.some(
            (ws) =>
              sameProjectPath(ws.projectPath, spec.projectPath) &&
              (ws.branch === resolved ||
                (!!spec.worktreePath &&
                  !!ws.worktreePath &&
                  pathKey(ws.worktreePath) === pathKey(spec.worktreePath))),
          ),
        )
      ) {
        throw new Error(`A lane already tracks ${resolved}`);
      }
      if (!spec.worktreePath) {
        // "New" can collide with a worktree already on this branch — offer
        // to bind that copy instead of erroring out. Unless another lane
        // already owns it — then there's nothing to offer.
        const clash = await worktreeOnBranch(spec.projectPath, resolved);
        if (clash) {
          if (laneOwnsPath(clash.path))
            throw new Error(`A lane already tracks ${resolved}`);
          setBindOffer({
            path: clash.path,
            spec: { ...spec, branch: resolved },
          });
          return;
        }
      }
      const worktreePath = await onPrepareWorktree({
        projectPath: spec.projectPath,
        branch: resolved,
        base: spec.base,
        ...(spec.worktreePath ? { worktreePath: spec.worktreePath } : {}),
      });
      updateTask(task.id, (current) => ({
        workstreams: [
          ...current.workstreams,
          {
            id: newEntityId("ws"),
            projectPath: spec.projectPath,
            branch: resolved,
            base: spec.base,
            worktreePath,
          },
        ],
      }));
      setBindOffer(null);
      setShowAddStream(false);
    } catch (error) {
      // The probe→create race can still collide — turn the backend's
      // collision error into the bind offer rather than a dead end.
      if (
        await offerOnCollision(error, spec.projectPath, resolved, {
          spec: { ...spec, branch: resolved },
        })
      )
        return;
      setStreamError(shortError(error));
    } finally {
      setAddingStream(false);
    }
  };

  /** A create that still hit "already has a working copy" — the probe raced
   * a worktree that appeared in between. Re-probe and offer the bind. */
  const offerOnCollision = async (
    error: unknown,
    projectPath: string,
    branch: string,
    offer: {
      workstreamId?: string;
      spec?: { projectPath: string; branch: string; base: string };
    },
  ): Promise<boolean> => {
    if (!/already has a working copy/i.test(String(error))) return false;
    const tree = await worktreeOnBranch(projectPath, branch).catch(
      () => null,
    );
    // Another lane already bound that worktree — a real error, not an offer.
    if (!tree || laneOwnsPath(tree.path, offer.workstreamId)) return false;
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
    <PanelShell
      title={task.title}
      onRenameTitle={(title) =>
        updateTask(task.id, { title: title.slice(0, 300) })
      }
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-none px-3 py-3">
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between"><SectionLabel>Conversations</SectionLabel><span className="text-[10px] tabular-nums text-content/35">{conversations.length}</span></div>
          <ConversationList key={task.id} sessions={conversations} boundIds={conversationIds} primaryId={task.primarySessionId} onOpen={onOpenSession}
            onUnbind={sessionId => {
              if (sessionId === task.primarySessionId) return;
              onBindSession(sessionId, null);
              updateTask(task.id, current => ({ workstreams: current.workstreams.map(ws => ({ ...ws, sessionIds: (ws.sessionIds ?? []).filter(id => id !== sessionId) })) }));
            }}
            onPrimary={sessionId => {
              if (!task.workstreams.some(ws => ws.sessionIds?.includes(sessionId))) return;
              if (loadBoard().tasks.some(entry => entry.id !== task.id && (entry.primarySessionId === sessionId || entry.workstreams.some(ws => ws.sessionIds?.includes(sessionId))))) {
                setStreamError("This conversation already belongs to another task."); return;
              }
              updateTask(task.id, { primarySessionId: sessionId });
            }}
          />
          {!task.primarySessionId && <button type="button" disabled={creatingSession || !!busyAction} onClick={() => void createPrimarySession()} className={ACTION}>
            <Plus className="size-3" />{creatingSession ? "Creating…" : "New conversation"}
          </button>}
        </div>
        {/* Tickets -------------------------------------------------- */}
        <div className="mb-1.5 flex items-center justify-between">
          <SectionLabel>Tickets</SectionLabel>
          <button
            type="button"
            className={ACTION}
            onClick={(event) =>
              setAddTicketAt(event.currentTarget as HTMLElement)
            }
          >
            <Plus className="size-3" strokeWidth={2} />
            Link
          </button>
        </div>
        <div className="flex flex-col">
          {(card.tickets ?? []).map((ticket) => (
            <div
              key={ticket.key}
              className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-content/4"
            >
              {ticket.provider ? (
                <InboxProviderMark
                  provider={ticket.provider}
                  className="size-3.5 shrink-0 text-content/60"
                />
              ) : null}
              <span className="max-w-28 shrink-0 truncate rounded bg-content/8 px-1 py-px text-[10px] font-medium text-content/55">
                {ticket.identifier ?? ticket.kind ?? "item"}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                {ticket.title}
              </span>
              {ticket.state ? (
                <span
                  className={`max-w-20 shrink-0 truncate text-[10px] ${
                    providerStage(ticket) === "done"
                      ? "text-content/35"
                      : "text-emerald-300/80"
                  }`}
                >
                  {ticket.state}
                </span>
              ) : null}
              {ticket.url ? (
                <button
                  type="button"
                  aria-label={`Open ${ticket.title} in browser`}
                  className="grid size-5 shrink-0 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
                  onClick={() => void openUrl(ticket.url!)}
                >
                  <ExternalLink className="size-3" strokeWidth={1.75} />
                </button>
              ) : null}
              {task.links.flatMap(link => sessionWorkItems({ linkedWorkItem: link })).some(link => linkedWorkItemInboxKey(link) === ticket.key) && (
              <button
                type="button"
                aria-label={`Unlink ${ticket.title}`}
                className="grid size-5 shrink-0 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
                onClick={() =>
                  updateTask(task.id, (current) => ({
                    links: current.links.flatMap(link => sessionWorkItems({ linkedWorkItem: link }))
                      .filter(link => linkedWorkItemInboxKey(link) !== ticket.key)
                      .map(({ additionalItems: _additionalItems, ...link }) => link),
                  }))
                }
              >
                <X className="size-3" strokeWidth={1.75} />
              </button>
              )}
            </div>
          ))}
          {!card.tickets?.length ? (
            <p className="px-1.5 py-1 text-[12px] text-content/40">
              No tickets linked.
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
                  aria-label={`Remove group ${group.name}`}
                  className="grid size-3 place-items-center rounded-sm opacity-0 hover:bg-content/15 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => toggleGroup(group.id)}
                >
                  <X className="size-2.5" strokeWidth={2.5} />
                </button>
              </span>
            );
          })}
          <button
            type="button"
            className="inline-flex h-5 items-center gap-0.5 rounded border border-dashed border-content/20 px-1.5 text-[10px] font-medium text-content/45 hover:border-content/40 hover:text-content"
            onClick={(event) =>
              setGroupMenuAt(event.currentTarget as HTMLElement)
            }
          >
            <Plus className="size-2.5" strokeWidth={2.5} />
            Group
          </button>
        </div>

        {/* Pull requests — lane PRs plus discovered items, one list so a
         * multi-repo task shows its whole PR surface. */}
        {(() => {
          const seen = new Set((card.workstreams ?? []).map(row => row.pr?.url).filter(Boolean));
          const allPrs = (card.prs ?? []).filter(pr => !pr.url || !seen.has(pr.url)).map(pr => ({...pr, lane: ""}));
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
                      {pr.lane ? `${pr.lane} — ` : ""}
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
        })()}

        {/* Workstreams ---------------------------------------------- */}
        <div className="mb-2 mt-5 flex items-center gap-1">
          <div className="min-w-0 flex-1"><SectionLabel>Repositories</SectionLabel></div>
          <TaskGitActions all disabled={!!busyAction} targets={task.workstreams.map(ws => ({ ...ws, blocked: card.sessions.some(session => session.busy) }))} />
          <button
            type="button"
            aria-label="Add repository"
            title="Add repository"
            className="grid size-7 shrink-0 place-items-center rounded-md text-content/55 hover:bg-content/6 hover:text-content"
            onClick={() => {
              // Closing the row abandons its pending bind offer.
              setBindOffer((current) =>
                current && !current.workstreamId ? null : current,
              );
              setShowAddStream((open) => !open);
            }}
          >
            <Plus className="size-3" strokeWidth={2} />
          </button>
        </div>
        {showAddStream ? (
          <AddWorkstreamRow
            recents={recents}
            lanes={lanes}
            busy={addingStream}
            onAdd={addWorkstream}
            onCancel={() => { setShowAddStream(false); setStreamError(""); setBindOffer(null); }}
          />
        ) : null}
        {bindOffer && !bindOffer.workstreamId ? (
          <BindOfferBar
            path={bindOffer.path}
            busy={addingStream}
            onAccept={() => {
              const spec = bindOffer.spec;
              if (!spec) return;
              void addWorkstream({ ...spec, worktreePath: bindOffer.path });
            }}
            onDismiss={() => setBindOffer(null)}
          />
        ) : null}
        {streamError ? (
          <p role="alert" className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-[11px] text-red-300">
            {streamError}
          </p>
        ) : null}
        <div className="mt-1 flex flex-col gap-1.5">
          {(card.workstreams ?? []).map((row) => (
            <WorkstreamCard
              key={row.id}
              row={row}
              status={wsStatus.get(row.id)}
              onHandoff={(kind) => onHandoff(row.id, kind)}
              onSources={() => setSourceLane(row.id)}
              result={results.get(row.id)}
              busy={
                busyAction === "merge" ||
                busyAction === "prs" ||
                busyAction === `merge:${row.id}` ||
                busyAction === `cleanup:${row.id}`
              }
              onUpdate={() => onUpdateWorkstream(row.id)}
              gitBlocked={card.sessions.some(session => session.busy)}
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
                if (laneOwnsPath(offer.path, row.id))
                  throw new Error("That worktree already serves another lane");
                await prepareForRow(row, offer.path);
                setBindOffer(null);
              }}
              onOfferDismiss={() => setBindOffer(null)}
              onSpawnSession={async () => {
                if (!row.worktreePath) {
                  // A fresh worktree would collide with the branch's
                  // existing copy — offer to bind it instead of failing.
                  // A copy another lane already owns is a real error.
                  const clash = await worktreeOnBranch(
                    row.projectPath,
                    row.branch,
                  );
                  if (clash) {
                    if (laneOwnsPath(clash.path, row.id))
                      throw new Error(
                        "That worktree already serves another lane",
                      );
                    setBindOffer({ workstreamId: row.id, path: clash.path });
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
                if (!await onSendToSession(spawned.sessionId, resolveConflictPrompt(row))) throw new Error("The agent did not accept the request.");
              }}
              onBind={(anchor) =>
                setBindAt({ anchor, workstreamId: row.id })
              }
              onRemove={() => {
                // Open popovers anchored on this lane would dangle — their
                // anchor element is about to unmount.
                setBindAt((current) =>
                  current?.workstreamId === row.id ? null : current,
                );
                setEditAt((current) =>
                  current?.workstreamId === row.id ? null : current,
                );
                setBindOffer((current) =>
                  current?.workstreamId === row.id ? null : current,
                );
                // Detach bound sessions' ticket links so they don't
                // rejoin this task via the link join.
                for (const sessionId of row.sessionIds)
                  onBindSession(sessionId, null);
                updateTask(task.id, (current) => ({
                  workstreams: current.workstreams.filter(
                    (ws) => ws.id !== row.id,
                  ),
                }));
              }}
              onCleanup={async () => {
                await onCleanupWorkstream(row.id);
              }}
            />
          ))}
          {!card.workstreams?.length ? (
            <p className="px-1.5 py-1 text-[12px] text-content/40">
              Add a repository to start work.
            </p>
          ) : null}
        </div>
      </div>

      {/* Pinned footer — task-level actions grouped: work actions left,
       * destructive right. flex-wrap so a narrow panel wraps instead of
       * clipping. */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-stroke px-3 py-2">
        <button
          type="button"
          disabled={
            !!busyAction ||
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
          className="flex h-7 items-center gap-1.5 rounded-md bg-accent/15 px-2 text-[11px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
        >
          {busyAction === "prs" ? (
            <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
          ) : (
            <GitPullRequest className="size-3" strokeWidth={2} />
          )}
          Create PRs
        </button>
        <button
          type="button"
          disabled={!!busyAction || !card.workstreams?.length}
          onClick={onUpdateBranches}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-content/60 hover:bg-content/8 hover:text-content disabled:opacity-40"
        >
          {busyAction === "merge" ? (
            <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
          ) : (
            <GitMerge className="size-3" strokeWidth={2} />
          )}
          Update branches
        </button>
        <button
          type="button"
          aria-label="Remove task"
          onClick={() => {
            removeTask(task.id);
            onClose();
          }}
          className="ml-auto grid size-7 place-items-center rounded-md text-content/40 hover:bg-red-400/10 hover:text-red-300"
        >
          <Archive className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {addTicketAt ? (
        <TicketPicker
          anchor={addTicketAt}
          items={items}
          exclude={linkKeys}
          onPick={(linked) =>
            updateTask(task.id, (current) => ({
              links: [...current.links, linked],
            }))
          }
          onClose={() => setAddTicketAt(null)}
        />
      ) : null}
      {prDialog ? (
        <CreatePrsDialog
          task={task}
          rows={(card.workstreams ?? []).filter((row) => prDialog.has(row.id))}
          status={wsStatus}
          busy={busyAction === "prs"}
          onSubmit={async (only, opts) => {
            // Stay open through the run — the busy state reports progress
            // and a failure's results are visible right after close.
            await onSubmitPrs(only, opts);
            setPrDialog(null);
          }}
          onCancel={() => setPrDialog(null)}
        />
      ) : null}
      {groupMenuAt ? (
        <GroupAssign
          anchor={groupMenuAt}
          groups={allGroups}
          assigned={task.groupIds ?? []}
          onToggle={toggleGroup}
          onClose={() => setGroupMenuAt(null)}
        />
      ) : null}
      {bindAt ? (
        <SessionPicker
          anchor={bindAt.anchor}
          sessions={sessions}
          bound={boundSessionIds}
          linkKeys={linkKeys}
          projectPath={
            card.workstreams?.find((ws) => ws.id === bindAt.workstreamId)
              ?.projectPath ?? ""
          }
          onPick={(sessionId) => {
            appendSession(bindAt.workstreamId, sessionId);
            if (linkBundle) onBindSession(sessionId, linkBundle);
          }}
          onClose={() => setBindAt(null)}
        />
      ) : null}
      {sourceLane && (() => {
        const ws = task.workstreams.find(w => w.id === sourceLane);
        return ws ? <DeliverySettings ws={ws} snapshot={wsStatus.get(ws.id)?.delivery} onClose={() => setSourceLane(undefined)} onSave={patch => updateTask(task.id, current => ({workstreams: current.workstreams.map(w => w.id === ws.id ? {...w,...patch} : w)}))}/> : null;
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
                busy={busyAction === `cleanup:${editRow.id}` || card.sessions.some(session => session.busy)}
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

function ConversationList({ sessions, primaryId, boundIds, onOpen, onUnbind, onPrimary }: {
  sessions: BoardCard["sessions"]; primaryId?: string; boundIds?: ReadonlySet<string>; onOpen: (id: string) => void; onUnbind?: (id: string) => void; onPrimary?: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(primaryId ?? sessions[0]?.id ?? "");
  const selected = sessions.find(session => session.id === selectedId) ?? sessions.find(session => session.id === primaryId) ?? sessions[0];
  if (!selected) return <p className="mb-2 text-[11px] text-content/40">No conversations attached.</p>;
  const status = selected.needsInput ? "Needs input" : selected.busy ? "Working" : selected.live ? "Idle" : "Saved";
  return <div className="mb-2 min-w-0">
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1"><SearchableSelect label="Conversation" value={selected.id} options={sessions.map(session => ({ value: session.id, label: session.title, keywords: session.id === primaryId ? "task primary" : undefined }))} onChange={setSelectedId} searchPlaceholder="Search conversations…" layer={LAYER.popover} /></div>
      <button type="button" onClick={() => onOpen(selected.id)} className="h-8 shrink-0 rounded-md bg-content/6 px-2.5 text-[11px] text-content/75 hover:bg-content/10">Open</button>
    </div>
    <div className="mt-1 flex min-w-0 items-center gap-1.5 px-1 text-[10px] text-content/45">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${sessionDotClass(selected)}`} />
      <span>{status}{selected.id === primaryId ? " · Task conversation" : ""}</span>
      {onPrimary && boundIds?.has(selected.id) && selected.id !== primaryId && <button type="button" onClick={() => onPrimary(selected.id)} className="ml-auto rounded px-1 py-1 hover:bg-content/6 hover:text-content">Use for task</button>}
      {onUnbind && boundIds?.has(selected.id) && selected.id !== primaryId && <button type="button" aria-label={`Detach ${selected.title}`} title="Detach conversation from task" onClick={() => onUnbind(selected.id)} className="grid size-6 shrink-0 place-items-center rounded hover:bg-content/6 hover:text-content"><X className="size-3" /></button>}
    </div>
  </div>;
}

function WorkstreamCard({
  row,
  status,
  onHandoff,
  onSources,
  result,
  busy,
  onUpdate,
  gitBlocked,
  onCreatePr,
  onEdit,
  offer,
  onOfferAccept,
  onOfferDismiss,
  onSpawnSession,
  onResolve,
  onBind,
  onRemove,
  onCleanup,
}: {
  row: BoardWorkstreamRow;
  status?: WorkstreamStatus;
  onHandoff: (kind: HandoffKind) => void;
  onSources: () => void;
  result?: WorkstreamResult;
  /** True while this lane's update or a task-wide op runs — sibling lanes
   * keep their own controls live. */
  busy: boolean;
  onUpdate: () => void;
  gitBlocked?: boolean;
  onCreatePr: () => void;
  onEdit: (anchor: HTMLElement) => void;
  /** A create found this branch's existing worktree — offer binds it. */
  offer?: { path: string };
  onOfferAccept: () => Promise<void>;
  onOfferDismiss: () => void;
  onSpawnSession: () => Promise<void>;
  onResolve: () => Promise<void>;
  onBind: (anchor: HTMLElement) => void;
  onRemove: () => void;
  /** Remove the merged lane's worktree — only rendered when applicable. */
  onCleanup?: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<
    "spawn" | "resolve" | "cleanup" | null
  >(null);
  const [armed, setArmed] = useState(false);
  const [actionError, setActionError] = useState("");
  const runAction = async (
    which: "spawn" | "resolve" | "cleanup",
    fn: () => Promise<void>,
  ) => {
    setPending(which);
    setActionError("");
    try {
      await fn();
    } catch (error) {
      setActionError(shortError(error));
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
        aria-label={`Repository details for ${projectName(row.projectPath)}`}
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
        <ChevronRight
          className={`size-3.5 text-content/35 transition-transform group-hover:text-content/70 ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      <div
        className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-content/50"
        title={`${row.branch} → ${row.base}`}
      >
        <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 truncate font-mono">{row.branch}</span>
        {row.base && (
          <span className="min-w-0 shrink truncate text-content/35">
            → {row.base}
          </span>
        )}
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
          <button
            type="button"
            disabled={laneBusy}
            title={`${row.branch} is ${row.behind} commit${row.behind === 1 ? "" : "s"} behind ${row.base} (last fetch) — click to merge`}
            className="flex items-center gap-0.5 rounded bg-content/8 px-1.5 py-0.5 text-[10px] font-medium text-content/55 hover:bg-content/12 hover:text-content disabled:opacity-40"
            onClick={onUpdate}
          >
            <ArrowDownCircle className="size-3" strokeWidth={1.75} />
            {row.behind}
          </button>
        ) : null}
        <CiBadge status={status} onFix={() => onHandoff("ci")} />
      </div>
      <div className="mt-2.5 flex min-w-0 flex-row-reverse items-start justify-between gap-2 border-t border-content/6 pt-2">
        <TaskGitActions disabled={laneBusy} targets={[{ ...row, blocked: gitBlocked || row.sessions.some(session => session.busy) }]} />
        {row.worktreePath ? (
          <button type="button" disabled={laneBusy} onClick={(event) => onEdit(event.currentTarget)} title={prettyCwd(row.worktreePath)} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-content/55 hover:bg-content/6 hover:text-content disabled:opacity-40">
            <FolderTree className="size-3" /> Worktree <ChevronRight className="size-3 text-content/30" />
          </button>
        ) : (
          <button type="button" disabled={laneBusy} onClick={() => void runAction("spawn", onSpawnSession)} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent/10 px-2 text-[11px] text-accent hover:bg-accent/20 disabled:opacity-40">
            {pending === "spawn" ? <LoaderCircle className="size-3 animate-spin" /> : <Plus className="size-3" />}
            Prepare worktree
          </button>
        )}
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
            {status?.delivery && (
              <>
                <dt className="text-content/40">Pull requests</dt>
                <dd className="break-words text-content/65">
                  {PROVIDER_NAMES[status.delivery.source.provider]}
                  <span className="block text-content/40">
                    {status.delivery.source.repo}
                  </span>
                </dd>
                <dt className="text-content/40">Checks</dt>
                <dd className="break-words text-content/65">
                  {status.delivery.ciSource
                    ? PROVIDER_NAMES[status.delivery.ciSource.provider]
                    : "Unavailable"}
                  <span className="block text-content/40">
                    {status.delivery.ciSource?.repo}
                  </span>
                </dd>
                <dt className="text-content/40">Revision</dt>
                <dd
                  className="font-mono text-content/55"
                  title={status.delivery.headSha}
                >
                  {status.delivery.headSha.slice(0, 8)}
                  {status.delivery.localHead !== status.delivery.headSha && (
                    <span className="ml-1 font-sans text-amber-700 dark:text-amber-300">
                      · local differs
                    </span>
                  )}
                </dd>
              </>
            )}
          </dl>
          <div className="my-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <button disabled={laneBusy} className={ACTION} onClick={onSources}>
              PR / CI sources
            </button>
          </div>
          {/* Bind offer — "create" found the branch's existing worktree. */}
          {offer ? (
            <BindOfferBar
              path={offer.path}
              busy={laneBusy}
              onAccept={() => void runAction("spawn", onOfferAccept)}
              onDismiss={onOfferDismiss}
            />
          ) : null}
          {/* Merge conflict — durable while MERGE_HEAD exists. Spawns a session
           * in this worktree with the resolve prompt. */}
          {conflicted ? (
            <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-red-400/10 py-1 pl-1.5 pr-1 ring-1 ring-red-400/20">
              <GitMerge
                className="size-3 shrink-0 text-red-700 dark:text-red-300"
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-red-700 dark:text-red-300">
                Merge conflict{row.base ? ` — ${row.base}` : ""}
              </span>
              <button
                type="button"
                disabled={laneBusy || !row.worktreePath}
                title={`Resolve the ${row.base} merge with an agent in this worktree`}
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
              title={`Merge ${row.base} into ${row.branch}`}
              onClick={onUpdate}
            >
              <GitMerge className="size-3" strokeWidth={1.75} />
              Update
            </button>

            <button
              type="button"
              disabled={laneBusy}
              className="rounded px-1 py-0.5 text-[11px] text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-40"
              onClick={(event) => onBind(event.currentTarget as HTMLElement)}
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
            Detach repository from task
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
      {actionError ? (
        <p
          role="alert"
          className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-[10px] text-red-700 dark:text-red-300"
        >
          {actionError}
        </p>
      ) : null}
      {result ? (
        <p
          className={`mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-[10px] ${
            result.ok ? "text-content/40" : "text-red-700 dark:text-red-300"
          }`}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

/** Lane editor — rebind an existing worktree, retarget branch/base, or drop
 * the lane's worktree. Branch picks wait for an explicit checkout action. */
export function WorkstreamEditor({
  anchor,
  row,
  lanes,
  busy,
  onPatch,
  onRemoveWorktree,
  onPrepareWorktree,
  onClose,
}: {
  anchor: HTMLElement;
  row: BoardWorkstreamRow;
  /** All board lanes — the editor derives this row's siblings from it. */
  lanes: TaskWorkstream[];
  /** Lane-level cleanup in flight — the remove button waits on it. */
  busy: boolean;
  onPatch: (
    patch: Partial<
      Pick<TaskWorkstream, "branch" | "base" | "worktreePath" | "prUrl">
    >,
  ) => void;
  onPrepareWorktree: (spec: NewTaskSpec["workstreams"][number]) => Promise<string>;
  onRemoveWorktree: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { branches } = useProjectBranchesState(row.projectPath, true);
  const { data: worktrees, refresh, error: worktreeError } = useProjectWorktrees(
    row.projectPath,
    true,
  );
  const [branchBusy, setBranchBusy] = useState(false);
  const [targetBranch, setTargetBranch] = useState<string>();
  const [bindPath, setBindPath] = useState<string>();
  const inFlight = useRef(false);
  const gitBusy = useTaskGitBusy([row.projectPath]);
  const blocked = busy || branchBusy || gitBusy || row.sessions.some(session => session.busy);
  const blockedRef = useRef(busy);
  blockedRef.current = busy || gitBusy || row.sessions.some(session => session.busy);
  useEffect(() => {
    setTargetBranch(undefined);
    setBindPath(undefined);
  }, [row.branch, row.worktreePath]);
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  // The shared cache can lag a worktree created/removed elsewhere — the
  // editor's whole job is correctness, so ask git again on open.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // An armed confirm must not survive a rebind — it would remove the new
  // pick's worktree instead of the one the user armed against.
  useEffect(() => setArmed(false), [row.worktreePath]);
  // Other lanes on the same repo — their branches and bound worktrees are
  // claimed; a branch lives in one worktree and a worktree serves one lane.
  const siblings = useMemo(
    () =>
      lanes.filter(
        (ws) =>
          ws.id !== row.id &&
          pathKey(ws.projectPath) === pathKey(row.projectPath),
      ),
    [lanes, row.id, row.projectPath],
  );
  const claimedPaths = useMemo(
    () =>
      new Set(
        siblings
          .map((ws) => ws.worktreePath)
          .filter((path): path is string => !!path)
          .map(pathKey),
      ),
    [siblings],
  );
  const claimedBranches = useMemo(
    () => new Set(siblings.map((ws) => ws.branch)),
    [siblings],
  );
  const worktreeOptions = useMemo(
    () =>
      worktreeLaneOptions(
        (worktrees?.worktrees ?? []).filter(
          // A bound pick syncs the lane's branch to the tree's — a tree on a
          // sibling-claimed branch would claim that branch too, so both
          // claims must exclude it here, not just its path.
          (tree) =>
            !claimedPaths.has(pathKey(tree.path)) &&
            !(tree.branch && claimedBranches.has(tree.branch)),
        ),
        row.worktreePath,
      ),
    [worktrees, row.worktreePath, claimedPaths, claimedBranches],
  );
  const baseOptions = useMemo(() => baseBranchOptions(branches, row.base), [branches, row.base]);
  const branchOptions = useMemo(
    () =>
      taskBranchOptions(branches, claimedBranches),
    [branches, claimedBranches],
  );
  // Siblings are render-time — a claim can land between render and pick.
  // Re-read the store at patch time so a race can't write a duplicate
  // branch or worktree binding.
  const storeClaim = (patch: {
    branch?: string;
    worktreePath?: string;
  }): string => {
    for (const entry of loadBoard().tasks) {
      for (const ws of entry.workstreams) {
        if (ws.id === row.id) continue;
        if (!sameProjectPath(ws.projectPath, row.projectPath)) continue;
        if (patch.branch && ws.branch === patch.branch)
          return `A lane already tracks ${patch.branch}`;
        if (
          patch.worktreePath &&
          ws.worktreePath &&
          pathKey(ws.worktreePath) === pathKey(patch.worktreePath)
        )
          return "That worktree already serves another lane";
      }
    }
    return "";
  };
  const applyBranch = async (action: "switch" | "create", existingPath?: string) => {
    if (!targetBranch || inFlight.current || blocked) return;
    const choice = taskBranchChoice(targetBranch);
    let preparedPath: string | undefined;
    const validate = (path?: string) => {
      const current = loadBoard().tasks.flatMap(task => task.workstreams).find(ws => ws.id === row.id);
      if (!current || current.branch !== row.branch || current.base !== row.base ||
          current.worktreePath !== row.worktreePath || !sameProjectPath(current.projectPath, row.projectPath))
        throw new Error("Working copy settings changed. Reopen the editor before retrying.");
      const claim = storeClaim({ branch: choice.branch, worktreePath: path });
      if (claim) throw new Error(claim);
    };
    inFlight.current = true;
    setBranchBusy(true);
    setError("");
    try {
      validate(existingPath);
      if (action === "switch") {
        if (!row.worktreePath) throw new Error("Select a working copy first.");
        const branch = await gitTaskBranch(row.worktreePath, row.branch, targetBranch, row.base, "switch");
        validate(row.worktreePath);
        onPatch({ branch, prUrl: undefined });
      } else {
        if (!existingPath) {
          const tree = await worktreeOnBranch(row.projectPath, choice.branch);
          validate(tree?.path);
          if (tree) { setBindPath(tree.path); return; }
        }
        // Reuse the app's normal preparation path; the old checkout is untouched.
        try {
          preparedPath = await onPrepareWorktree({
            projectPath: row.projectPath,
            branch: choice.branch,
            base: choice.base ?? row.base,
            ...(existingPath ? { worktreePath: existingPath } : {}),
          });
        } catch (cause) {
          if (!existingPath && /already has a working copy/i.test(String(cause))) {
            const tree = await worktreeOnBranch(row.projectPath, choice.branch);
            validate(tree?.path);
            if (tree) { setBindPath(tree.path); return; }
          }
          throw cause;
        }
        validate(preparedPath);
        // A running agent may have started while preparation was awaiting IO.
        if (blockedRef.current)
          throw new Error("An agent is working. Reopen the editor after it finishes.");
        onPatch({ branch: choice.branch, worktreePath: preparedPath, prUrl: undefined });
      }
      setTargetBranch(undefined);
      setBindPath(undefined);
      void refresh();
    } catch (cause) {
      setError(`${String(cause)}${preparedPath ? ` Working copy kept at ${preparedPath}.` : ""}`);
    } finally {
      inFlight.current = false;
      setBranchBusy(false);
    }
  };
  const boundTree = row.worktreePath
    ? worktrees?.worktrees.find(
        (tree) => pathKey(tree.path) === pathKey(row.worktreePath!),
      )
    : undefined;
  return (
    <Popover
      anchor={anchor}
      width={360}
      onDismiss={() => { if (!inFlight.current) onClose(); }}
      // SearchableSelect menus portal out of this popover — they aren't
      // "outside" clicks.
      ignore="[data-dialog-popover]"
      className="flex flex-col gap-2 p-2"
      aria-label="Manage worktree"
    >
      <div className="flex flex-col gap-1 text-[11px] font-medium text-content/45">
        <div className="flex items-center justify-between"><span>Attach existing working copy</span><button type="button" disabled={blocked} onClick={() => void refresh()}>Refresh copies</button></div>
        {worktreeError && <p role="alert" className="text-red-400">{worktreeError}</p>}
        {!worktrees && !worktreeError && <p role="status">Loading working copies…</p>}
        <SearchableSelect
          label="Worktree"
          disabled={blocked}
          value={row.worktreePath ?? ""}
          options={[
            { value: "", label: "No working copy attached" },
            ...worktreeOptions,
          ]}
          onChange={(path) => {
            const tree = bindableWorktrees(worktrees?.worktrees ?? []).find(
              (entry) => entry.path === path,
            );
            const patch = {
              worktreePath: path || undefined,
              ...(tree?.branch ? { branch: tree.branch } : {}),
              // Unbinding keeps the lane's probed PR alive — a lane without
              // a worktree only tracks a PR when one's pinned.
              ...(!path && row.pr?.url ? { prUrl: row.pr.url } : {}),
            };
            const claim = storeClaim(patch);
            if (claim) {
              setError(claim);
              return;
            }
            setError("");
            onPatch(patch);
          }}
          placeholder="No worktree attached"
          searchPlaceholder="Search worktrees…"
          emptyLabel="No working copies"
          layer={LAYER.submenu}
          minMenuWidth={280}
        />
      </div>
      <div className="flex items-start gap-1.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] font-medium text-content/45">
          <span>Branch</span>
          <SearchableSelect
            label="Branch"
            value={targetBranch ?? row.branch}
            options={branchOptions}
            onChange={(value) => {
              setTargetBranch(value);
              setBindPath(undefined);
              setError("");
            }}
            searchPlaceholder="Pick or type a branch…"
            creatable="New branch"
            exclude={claimedBranches}
            disabled={blocked}
            layer={LAYER.submenu}
            minMenuWidth={220}
          />
        </div>
        <div className="flex w-28 shrink-0 flex-col gap-1 text-[11px] font-medium text-content/45">
          <span>Base</span>
          <SearchableSelect
            label="Base branch"
            disabled={blocked}
            value={row.base}
            options={baseOptions}
            onChange={(base) => onPatch({ base })}
            searchPlaceholder="Branches…"
            layer={LAYER.submenu}
            minMenuWidth={220}
          />
        </div>
      </div>
      {targetBranch && (
        <div className="flex flex-col gap-2 text-[11px]">
          <div className="flex flex-wrap gap-2 text-accent">
            <button type="button" disabled={blocked || !row.worktreePath} onClick={() => void applyBranch("switch")}>Switch current worktree</button>
            <button type="button" disabled={blocked} onClick={() => void applyBranch("create")}>Create separate worktree</button>
          </div>
          <p className="text-content/50">A separate worktree keeps your current files and sessions in place.</p>
          {bindPath && <BindOfferBar path={bindPath} busy={blocked} onAccept={() => void applyBranch("create", bindPath)} onDismiss={() => setBindPath(undefined)} />}
        </div>
      )}
      {row.worktreePath && !boundTree?.isMain ? (
        <button
          type="button"
          disabled={blocked || removing}
          aria-pressed={armed}
          title={
            armed
              ? "Confirm — removes the worktree directory; live sessions bound to it are detached"
              : "Remove this lane's worktree"
          }
          onClick={() => {
            if (!armed) {
              setArmed(true);
              return;
            }
            setRemoving(true);
            setError("");
            void onRemoveWorktree()
              .catch((cause) => setError(shortError(cause, 120)))
              .finally(() => {
                setRemoving(false);
                setArmed(false);
              });
          }}
          className={`flex h-7 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium disabled:opacity-40 ${
            armed
              ? "bg-red-400/15 text-red-300 hover:bg-red-400/25"
              : "text-content/55 hover:bg-content/8 hover:text-content"
          }`}
        >
          {removing ? (
            <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
          ) : (
            <Trash2 className="size-3" strokeWidth={1.75} />
          )}
          {armed
            ? row.sessions.length
              ? `Detach ${row.sessions.length} & remove`
              : "Confirm removal"
            : "Delete worktree…"}
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[10px] text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </Popover>
  );
}
