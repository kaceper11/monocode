import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { InboxProviderMark } from "../inbox/ui/InboxProviderMark";
import { Popover } from "../../shared/ui/Popover";
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
  GitBranch,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  Play,
  Plus,
  Search,
  Trash2,
  WandSparkles,
  X,
} from "../../shared/ui/icons";
import { useDragResize } from "../../shared/hooks/useDragResize";
import {
  formatRelativeTime,
  inboxItemRef,
  type InboxItem,
} from "../inbox/model/githubTasks";
import { projectName } from "../../shared/lib/paths";
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
} from "./boardStore";
import {
  resolveLaneBranch,
  suggestedBranch,
  WorkstreamFields,
  workstreamProjectOptions,
  type NewTaskSpec,
} from "./NewTaskDialog";
import {
  prIsOpen,
  resolveConflictPrompt,
  type WorkstreamResult,
} from "./taskOps";


const ACTION =
  "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-content/55 hover:bg-content/8 hover:text-content disabled:opacity-40";

const WIDTH_KEY = "monocode.board.panelW";
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 272;

const savedPanelWidth = () => {
  const value = Number(localStorage.getItem(WIDTH_KEY));
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
          No sessions in this project.
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
  busy,
  onAdd,
}: {
  recents: RecentProject[];
  busy: boolean;
  onAdd: (projectPath: string, branch: string, base: string) => void;
}) {
  const [draft, setDraft] = useState({
    projectPath: "",
    branch: "",
    base: "",
  });
  const projects = useMemo(() => workstreamProjectOptions(recents), [recents]);
  return (
    <div className="mt-1.5">
      <WorkstreamFields
        draft={draft}
        projects={projects}
        compact
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        tail={
          <button
            type="button"
            disabled={busy || !draft.projectPath}
            onClick={() => {
              onAdd(draft.projectPath, draft.branch, draft.base || "HEAD");
              setDraft((current) => ({ ...current, branch: "" }));
            }}
            className="grid size-7 shrink-0 place-items-center rounded-md bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40"
            aria-label="Add workstream"
          >
            <Plus className="size-3.5" strokeWidth={2} />
          </button>
        }
      />
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
  items,
  recents,
  sessions,
  busyAction,
  results,
  onClose,
  onOpenSession,
  onSendToSession,
  onSpawnSession,
  onBindSession,
  wsStatus,
  onUpdateBranches,
  onUpdateWorkstream,
  onSubmitPrs,
  onCleanupWorkstream,
}: {
  card: BoardCard;
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
  /** Open `sessionId` and submit `text` — used to hand a conflicted lane a
   * resolve prompt in a freshly spawned worktree session. */
  onSendToSession: (sessionId: string, text: string) => void;
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
}) {
  const task = card.task!;
  const [addTicketAt, setAddTicketAt] = useState<HTMLElement | null>(null);
  const [groupMenuAt, setGroupMenuAt] = useState<HTMLElement | null>(null);
  const [bindAt, setBindAt] = useState<{
    anchor: HTMLElement;
    workstreamId: string;
  } | null>(null);
  const [showAddStream, setShowAddStream] = useState(false);
  const [addingStream, setAddingStream] = useState(false);
  const [streamError, setStreamError] = useState("");
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
    for (const entry of loadBoard().tasks)
      for (const ws of entry.workstreams)
        for (const id of ws.sessionIds ?? []) ids.add(id);
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

  const addWorkstream = async (
    projectPath: string,
    branch: string,
    base: string,
  ) => {
    setAddingStream(true);
    setStreamError("");
    try {
      // Cap check before spawn — `updateTask` failing after the worktree +
      // session exist would orphan both.
      if (task.workstreams.length >= MAX_WORKSTREAMS)
        throw new Error(`A task can hold at most ${MAX_WORKSTREAMS} lanes.`);
      const resolved =
        resolveLaneBranch(projectPath, branch) ||
        suggestedBranch(task.title, task.links);
      const spawned = await onSpawnSession({
        projectPath,
        branch: resolved,
        base,
      });
      updateTask(task.id, (current) => ({
        workstreams: [
          ...current.workstreams,
          {
            id: newEntityId("ws"),
            projectPath,
            branch: resolved,
            base,
            worktreePath: spawned.worktreePath,
            sessionIds: [spawned.sessionId],
          },
        ],
      }));
      setShowAddStream(false);
    } catch (error) {
      setStreamError(
        String(error).replace(/^Error:\s*/, "").split("\n")[0].slice(0, 160),
      );
    } finally {
      setAddingStream(false);
    }
  };

  return (
    <PanelShell title={task.title} onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-none px-3 py-3">
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
              <button
                type="button"
                aria-label={`Unlink ${ticket.title}`}
                className="grid size-5 shrink-0 place-items-center rounded text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
                onClick={() =>
                  updateTask(task.id, (current) => ({
                    links: current.links.filter(
                      (link) => linkedWorkItemInboxKey(link) !== ticket.key,
                    ),
                  }))
                }
              >
                <X className="size-3" strokeWidth={1.75} />
              </button>
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
          const multiLane = (card.workstreams?.length ?? 0) > 1;
          const lanePrs = (card.workstreams ?? [])
            .filter((row) => row.pr)
            .map((row) => ({
              id: `ws:${row.id}`,
              title: row.pr!.title,
              url: row.pr!.url,
              state: row.pr!.state,
              lane: multiLane
                ? projectName(row.projectPath) || row.projectPath
                : "",
            }));
          const seen = new Set(lanePrs.map((pr) => pr.url));
          const allPrs = [
            ...lanePrs,
            ...(card.prs ?? [])
              .filter((pr) => !pr.url || !seen.has(pr.url))
              .map((pr) => ({
                id: pr.id,
                title: pr.identifier ? `${pr.identifier} ${pr.title}` : pr.title,
                url: pr.url,
                state: pr.state,
                lane: "",
              })),
          ];
          if (!allPrs.length) return null;
          return (
            <>
              <div className="mb-1.5 mt-5">
                <SectionLabel>Pull requests</SectionLabel>
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
        <div className="mb-1.5 mt-5 flex items-center justify-between">
          <SectionLabel>Workstreams</SectionLabel>
          <button
            type="button"
            className={ACTION}
            onClick={() => setShowAddStream((open) => !open)}
          >
            <Plus className="size-3" strokeWidth={2} />
            Add repo
          </button>
        </div>
        {showAddStream ? (
          <AddWorkstreamRow
            recents={recents}
            busy={addingStream}
            onAdd={addWorkstream}
          />
        ) : null}
        {streamError ? (
          <p role="alert" className="mt-1 break-words text-[11px] text-red-300">
            {streamError}
          </p>
        ) : null}
        <div className="mt-1 flex flex-col gap-1.5">
          {(card.workstreams ?? []).map((row) => (
            <WorkstreamCard
              key={row.id}
              row={row}
              result={results.get(row.id)}
              busy={
                busyAction === "merge" ||
                busyAction === "prs" ||
                busyAction === `merge:${row.id}`
              }
              onOpenSession={onOpenSession}
              onUpdate={() => onUpdateWorkstream(row.id)}
              onCreatePr={() => setPrDialog(new Set([row.id]))}
              onSpawnSession={async () => {
                const spawned = await onSpawnSession({
                  projectPath: row.projectPath,
                  branch: row.branch,
                  base: row.base,
                  ...(row.worktreePath
                    ? { worktreePath: row.worktreePath }
                    : {}),
                });
                updateTask(task.id, (current) => ({
                  workstreams: current.workstreams.map((ws) =>
                    ws.id === row.id
                      ? {
                          ...ws,
                          worktreePath: spawned.worktreePath,
                          sessionIds: [
                            ...(ws.sessionIds ?? []),
                            spawned.sessionId,
                          ],
                        }
                      : ws,
                  ),
                }));
                // Spawning is an intent to chat — take the user to it.
                onOpenSession(spawned.sessionId);
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
                onSendToSession(spawned.sessionId, resolveConflictPrompt(row));
              }}
              onBind={(anchor) =>
                setBindAt({ anchor, workstreamId: row.id })
              }
              onUnbind={(sessionId) => {
                onBindSession(sessionId, null);
                updateTask(task.id, (current) => ({
                  workstreams: current.workstreams.map((ws) =>
                    ws.id === row.id
                      ? {
                          ...ws,
                          sessionIds: (ws.sessionIds ?? []).filter(
                            (id) => id !== sessionId,
                          ),
                        }
                      : ws,
                  ),
                }));
              }}
              onRemove={() => {
                // An open Bind popover anchored on this lane would dangle —
                // its anchor element is about to unmount.
                setBindAt((current) =>
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
              No workstreams — add a repo lane to start work.
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
            Start work
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

function WorkstreamCard({
  row,
  result,
  busy,
  onOpenSession,
  onUpdate,
  onCreatePr,
  onSpawnSession,
  onResolve,
  onBind,
  onUnbind,
  onRemove,
  onCleanup,
}: {
  row: BoardWorkstreamRow;
  result?: WorkstreamResult;
  /** True while this lane's update or a task-wide op runs — sibling lanes
   * keep their own controls live. */
  busy: boolean;
  onOpenSession: (sessionId: string) => void;
  onUpdate: () => void;
  onCreatePr: () => void;
  onSpawnSession: () => Promise<void>;
  onResolve: () => Promise<void>;
  onBind: (anchor: HTMLElement) => void;
  onUnbind: (sessionId: string) => void;
  onRemove: () => void;
  /** Remove the merged lane's worktree — only rendered when applicable. */
  onCleanup?: () => Promise<void>;
}) {
  const unresolved = row.sessionIds.filter(
    (id) => !row.sessions.some((ref) => ref.id === id),
  );
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
      setActionError(
        String(error).replace(/^Error:\s*/, "").split("\n")[0].slice(0, 160),
      );
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
    <div className="rounded-lg border border-content/8 bg-content/[0.015] px-2 py-1.5">
      {/* Lane header — repo · branch → base · remove */}
      <div className="flex items-center gap-1.5">
        <Folder className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-content/85">
          {projectName(row.projectPath) || row.projectPath}
        </span>
        <span
          className="flex min-w-0 shrink items-center gap-1 rounded bg-content/8 px-1.5 py-0.5"
          title={`${row.branch} → ${row.base}`}
        >
          <GitBranch className="size-2.5 shrink-0 text-content/45" strokeWidth={1.75} />
          <span className="min-w-0 truncate font-mono text-[10px] text-content/60">
            {row.branch}
          </span>
          {row.base ? (
            <span className="shrink-0 font-mono text-[10px] text-content/30">
              → {row.base}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          aria-label="Remove workstream"
          onClick={onRemove}
          className="grid size-5 shrink-0 place-items-center rounded text-content/30 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3" strokeWidth={1.75} />
        </button>
      </div>
      {/* Status chips — the lane's PR + pipeline state at a glance. */}
      {row.pr || row.ciTotal || row.behind ? (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {row.pr ? (
            <button
              type="button"
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                prIsOpen(row.pr.state)
                  ? "bg-amber-400/10 text-amber-300"
                  : "bg-content/8 text-content/50"
              } hover:bg-content/10`}
              title={`${row.pr.title} — ${row.pr.state}`}
              onClick={() => void openUrl(row.pr!.url)}
            >
              <GitPullRequest className="size-3" strokeWidth={1.75} />
              PR #{row.pr.number}
              {row.pr.draft ? " · draft" : ""}
            </button>
          ) : null}
          {row.pr && prIsOpen(row.pr.state) && row.pr.reviewDecision ? (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                row.pr.reviewDecision === "CHANGES_REQUESTED"
                  ? "bg-red-400/15 text-red-300"
                  : row.pr.reviewDecision === "APPROVED"
                    ? "bg-emerald-400/10 text-emerald-300/90"
                    : "bg-content/8 text-content/50"
              }`}
            >
              {row.pr.reviewDecision === "CHANGES_REQUESTED"
                ? "Changes requested"
                : row.pr.reviewDecision === "APPROVED"
                  ? "Approved"
                  : "Awaiting review"}
            </span>
          ) : null}
          {row.pr && prIsOpen(row.pr.state) && row.pr.unresolvedThreads ? (
            <span
              className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300/90"
              title="Unresolved review threads"
            >
              {row.pr.unresolvedThreads} thread
              {row.pr.unresolvedThreads === 1 ? "" : "s"}
            </span>
          ) : null}
          {mergeSignal === "ready" ? (
            <span
              className="flex items-center gap-1 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
              title="Approved, checks green, mergeable — land it on the provider"
            >
              <CheckCircle className="size-3" strokeWidth={1.75} />
              Ready
            </span>
          ) : mergeSignal === "conflicts" ? (
            <span
              className="rounded bg-red-400/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
              title="The provider reports merge conflicts"
            >
              Conflicts
            </span>
          ) : mergeSignal === "blocked" ? (
            <span
              className="rounded bg-red-400/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
              title="Merge blocked by branch policy/protection"
            >
              Blocked
            </span>
          ) : null}
          {mergeSignal === "behind" && !row.behind ? (
            <span
              className="rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300/90"
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
          {row.ciFailing ? (
            <span className="rounded bg-red-400/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
              CI ×{row.ciFailing}
            </span>
          ) : row.ciRunning ? (
            <span className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300/90">
              CI ●{row.ciRunning}
            </span>
          ) : row.ciTotal ? (
            <span className="rounded bg-content/8 px-1.5 py-0.5 text-[10px] font-medium text-content/45">
              CI ✓
            </span>
          ) : null}
        </div>
      ) : null}
      {/* Merge conflict — durable while MERGE_HEAD exists. Spawns a session
       * in this worktree with the resolve prompt. */}
      {conflicted ? (
        <div className="mt-1.5 flex items-center gap-1.5 rounded-md bg-red-400/10 py-1 pl-1.5 pr-1 ring-1 ring-red-400/20">
          <GitMerge className="size-3 shrink-0 text-red-300" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-red-300">
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
              <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
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
              armed
                ? void runAction("cleanup", onCleanup)
                : setArmed(true)
            }
          >
            {pending === "cleanup" ? (
              <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
            ) : (
              <Trash2 className="size-3" strokeWidth={1.75} />
            )}
            {armed ? "Remove?" : "Clean up"}
          </button>
        </div>
      ) : null}
      {/* Conversations — a lane can hold several sessions. */}
      {row.sessions.length || unresolved.length ? (
        <div className="mt-1 flex flex-col">
          {row.sessions.map((session) => (
            <div
              key={session.id}
              className="group -mx-1 flex items-center rounded-md px-1 hover:bg-content/4"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[11.5px] text-content/70 hover:text-content"
                title={
                  session.live
                    ? session.title
                    : `${session.title} — click to resume`
                }
                onClick={() => onOpenSession(session.id)}
              >
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${
                    session.live
                      ? sessionDotClass(session)
                      : "bg-transparent ring-1 ring-content/25"
                  }`}
                />
                <span
                  className={`min-w-0 flex-1 truncate ${session.live ? "" : "text-content/45"}`}
                >
                  {session.title}
                </span>
                <span
                  className={`shrink-0 text-[10px] ${
                    session.needsInput
                      ? "text-amber-300/80"
                      : session.busy
                        ? "text-emerald-300/80"
                        : "text-content/30"
                  }`}
                >
                  {session.needsInput
                    ? "needs input"
                    : session.busy
                      ? "running"
                      : session.live
                        ? "idle"
                        : "stored"}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Unbind ${session.title}`}
                className="grid size-4 shrink-0 place-items-center rounded text-content/30 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onUnbind(session.id)}
              >
                <X className="size-2.5" strokeWidth={2} />
              </button>
            </div>
          ))}
          {unresolved.map((id) => (
            // Bound but unresolved — resume rehydrates the stored session.
            <div
              key={id}
              className="group -mx-1 flex items-center rounded-md px-1 hover:bg-content/4"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[11.5px] text-accent hover:underline"
                onClick={() => onOpenSession(id)}
              >
                <Play className="size-2.5 shrink-0" strokeWidth={2} />
                Resume session
              </button>
              <button
                type="button"
                aria-label="Unbind session"
                className="grid size-4 shrink-0 place-items-center rounded text-content/30 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onUnbind(id)}
              >
                <X className="size-2.5" strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {/* Lane actions — separated from status by a hairline. */}
      <div className="mt-1.5 flex min-w-0 items-center gap-1 border-t border-content/6 pt-1.5">
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
          className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-40"
          onClick={() => void runAction("spawn", onSpawnSession)}
        >
          {pending === "spawn" ? (
            <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
          ) : (
            <Plus className="size-3" strokeWidth={2} />
          )}
          {row.sessionIds.length
            ? "New chat"
            : row.worktreePath
              ? "Start session"
              : "Create worktree"}
        </button>
        <button
          type="button"
          disabled={laneBusy}
          className="rounded px-1 py-0.5 text-[11px] text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-40"
          onClick={(event) => onBind(event.currentTarget as HTMLElement)}
        >
          Bind
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
      {row.probeError ? (
        <p
          className="mt-1 break-words text-[10px] text-amber-300"
          title={row.probeError}
        >
          {row.probeError}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="mt-1 break-words text-[10px] text-red-300">
          {actionError}
        </p>
      ) : null}
      {result ? (
        <p
          className={`mt-1 break-words text-[10px] ${
            result.ok ? "text-content/40" : "text-red-300"
          }`}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
