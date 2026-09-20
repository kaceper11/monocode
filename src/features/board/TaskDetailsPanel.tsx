import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { InboxProviderMark } from "../inbox/ui/InboxProviderMark";
import { Popover } from "../../shared/ui/Popover";
import {
  Archive,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  Play,
  Plus,
  Search,
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
import { linkedWorkItemInboxKey } from "../sessions/model/sessionWorkItem";
import {
  boardTicketOptions,
  cardAttentionLines,
  groupSwatch,
  linkBundleFromLinks,
  sessionDotClass,
} from "./boardData";
import { namedWorktreeBranch } from "../source-control/model/worktrees";
import type { BoardCard, BoardWorkstreamRow } from "./boardData";
import {
  createGroup,
  loadBoard,
  newEntityId,
  removeTask,
  renameLocalCard,
  updateTask,
  type BoardGroup,
} from "./boardStore";
import {
  suggestedBranch,
  WorkstreamFields,
  workstreamProjectOptions,
  type NewTaskSpec,
} from "./NewTaskDialog";
import type { WorkstreamResult } from "./taskOps";

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
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  sessions: Session[];
  projectPath: string;
  /** Session ids already bound to a workstream — excluded so a pick
   * can't silently steal one from another lane. */
  bound: ReadonlySet<string>;
  onPick: (sessionId: string) => void;
  onClose: () => void;
}) {
  const options = sessions.filter(
    (session) =>
      !session.inboxAsk &&
      !session.orchestrationLeadId &&
      !bound.has(session.id) &&
      sameProjectPath(session.cwd, projectPath),
  );
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
  onSpawnSession,
  onBindSession,
  onCreatePrs,
  onUpdateBranches,
  onUpdateWorkstream,
  onCreateWorkstreamPr,
}: {
  card: BoardCard;
  items: InboxItem[];
  recents: RecentProject[];
  sessions: Session[];
  /** Action currently running, e.g. "prs" | "merge" — disables buttons. */
  busyAction: string;
  /** Latest bulk-action results, keyed by workstream id. */
  results: ReadonlyMap<string, WorkstreamResult>;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onSpawnSession: (spec: NewTaskSpec["workstreams"][number]) => Promise<{
    sessionId: string;
    worktreePath: string;
  }>;
  onBindSession: (sessionId: string, linked: LinkedWorkItem | null) => void;
  onCreatePrs: () => void;
  onUpdateBranches: () => void;
  onUpdateWorkstream: (workstreamId: string) => void;
  onCreateWorkstreamPr: (workstreamId: string) => void;
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

  const linkKeys = useMemo(
    () => new Set(task.links.map((link) => linkedWorkItemInboxKey(link))),
    [task.links],
  );
  // Fresh read — `task` gets a new identity on every store write, so this
  // tracks renames/deletes from this panel and any other surface.
  const allGroups = useMemo(() => loadBoard().groups, [task]);
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
        : [...(current.groupIds ?? []), groupId],
    }));

  const addWorkstream = async (
    projectPath: string,
    branch: string,
    base: string,
  ) => {
    setAddingStream(true);
    setStreamError("");
    try {
      const resolved =
        namedWorktreeBranch(branch.trim()) ||
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
                    /done|closed|merged|resolved|completed/i.test(ticket.state)
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

        {/* Pull requests -------------------------------------------- */}
        {card.prs?.length ? (
          <>
            <div className="mb-1.5 mt-5">
              <SectionLabel>Pull requests</SectionLabel>
            </div>
            <div className="flex flex-col">
              {card.prs.map((pr) => (
                <div
                  key={pr.id}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-content/4"
                >
                  {pr.provider ? (
                    <InboxProviderMark
                      provider={pr.provider}
                      className="size-3.5 shrink-0 text-content/60"
                    />
                  ) : (
                    <GitPullRequest
                      className="size-3.5 shrink-0 text-content/50"
                      strokeWidth={1.75}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                    {pr.identifier ? `${pr.identifier} ` : ""}
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
        ) : null}

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
        <div className="mt-1 flex flex-col divide-y divide-content/6">
          {(card.workstreams ?? []).map((row) => (
            <WorkstreamCard
              key={row.id}
              row={row}
              result={results.get(row.id)}
              busy={busyAction}
              onOpenSession={onOpenSession}
              onUpdate={() => onUpdateWorkstream(row.id)}
              onCreatePr={() => onCreateWorkstreamPr(row.id)}
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
          disabled={!!busyAction || !card.workstreams?.length}
          onClick={onCreatePrs}
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
  onBind,
  onUnbind,
  onRemove,
}: {
  row: BoardWorkstreamRow;
  result?: WorkstreamResult;
  busy: string;
  onOpenSession: (sessionId: string) => void;
  onUpdate: () => void;
  onCreatePr: () => void;
  onSpawnSession: () => Promise<void>;
  onBind: (anchor: HTMLElement) => void;
  onUnbind: (sessionId: string) => void;
  onRemove: () => void;
}) {
  const unresolved = row.sessionIds.filter(
    (id) => !row.sessions.some((ref) => ref.id === id),
  );
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState("");
  const spawn = async () => {
    setSpawning(true);
    setSpawnError("");
    try {
      await onSpawnSession();
    } catch (error) {
      setSpawnError(
        String(error).replace(/^Error:\s*/, "").split("\n")[0].slice(0, 160),
      );
    } finally {
      setSpawning(false);
    }
  };
  return (
    <div className="py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 max-w-[45%] truncate text-[12px] font-medium text-content/85">
          {projectName(row.projectPath) || row.projectPath}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-content/40">
          {row.branch}
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
      {/* Conversations — a lane can hold several sessions. */}
      <div className="mt-0.5 flex flex-col">
        {row.sessions.map((session) => (
          <div key={session.id} className="group flex items-center">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-0.5 text-left text-[11px] text-content/65 hover:text-content"
              title={
                session.live ? session.title : `${session.title} — click to resume`
              }
              onClick={() => onOpenSession(session.id)}
            >
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${
                  session.needsInput
                    ? "bg-amber-400"
                    : session.busy
                      ? "bg-emerald-400"
                      : session.live
                        ? "bg-content/25"
                        : "bg-transparent ring-1 ring-content/25"
                }`}
              />
              <span
                className={`truncate ${session.live ? "" : "text-content/45"}`}
              >
                {session.title}
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
          <div key={id} className="group flex items-center">
            <button
              type="button"
              className="flex flex-1 items-center gap-1 rounded py-0.5 text-[11px] text-accent hover:underline"
              onClick={() => onOpenSession(id)}
            >
              <Play className="size-2.5" strokeWidth={2} />
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
      {/* Lane status + actions on one line — chips read, links act. */}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {row.pr ? (
          <button
            type="button"
            className={`flex items-center gap-1 rounded px-1 text-[11px] ${
              /open|active/i.test(row.pr.state)
                ? "bg-amber-400/10 text-amber-300"
                : "bg-content/8 text-content/50"
            } hover:bg-content/10`}
            title={`${row.pr.title} — ${row.pr.state}`}
            onClick={() => void openUrl(row.pr!.url)}
          >
            <GitPullRequest className="size-3" strokeWidth={1.75} />
            PR #{row.pr.number}
          </button>
        ) : row.worktreePath ? (
          <button
            type="button"
            disabled={!!busy}
            className="flex items-center gap-1 rounded px-1 text-[11px] text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-40"
            onClick={onCreatePr}
          >
            <GitPullRequest className="size-3" strokeWidth={1.75} />
            Create PR
          </button>
        ) : null}
        {row.ciFailing ? (
          <span className="rounded bg-red-400/15 px-1 text-[10px] font-medium text-red-300">
            CI ×{row.ciFailing}
          </span>
        ) : row.ciRunning ? (
          <span className="rounded bg-emerald-400/10 px-1 text-[10px] font-medium text-emerald-300/90">
            CI ●{row.ciRunning}
          </span>
        ) : row.ciTotal ? (
          <span className="rounded bg-content/8 px-1 text-[10px] text-content/45">
            CI ✓
          </span>
        ) : null}
        <button
          type="button"
          disabled={!!busy}
          className="flex items-center gap-1 rounded px-1 text-[11px] text-content/45 hover:bg-content/8 hover:text-content disabled:opacity-40"
          title={`Merge ${row.base} into ${row.branch}`}
          onClick={onUpdate}
        >
          <GitMerge className="size-3" strokeWidth={1.75} />
          Update
        </button>
        <button
          type="button"
          disabled={spawning}
          className="flex items-center gap-1 rounded px-1 text-[11px] text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-40"
          onClick={() => void spawn()}
        >
          {spawning ? (
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
          className="rounded px-1 text-[11px] text-content/45 hover:bg-content/8 hover:text-content"
          onClick={(event) => onBind(event.currentTarget as HTMLElement)}
        >
          Bind
        </button>
      </div>
      {row.probeError ? (
        <p
          className="mt-1 break-words text-[10px] text-amber-300"
          title={row.probeError}
        >
          {row.probeError}
        </p>
      ) : null}
      {spawnError ? (
        <p role="alert" className="mt-1 break-words text-[10px] text-red-300">
          {spawnError}
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
