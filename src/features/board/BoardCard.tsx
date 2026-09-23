import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { InboxProviderMark } from "../inbox/ui/InboxProviderMark";
import { Popover } from "../../shared/ui/Popover";
import {
  AlertCircle,
  Archive,
  ArrowUp,
  Bot,
  CircleDot,
  ChevronRight,
  Clock,
  ExternalLink,
  FolderTree,
  GitPullRequest,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
  Zap,
} from "../../shared/ui/icons";
import type { BoardCard } from "./boardData";
import {
  attentionScore,
  cardAttentionLines,
  groupSwatch,
  sessionDotClass,
} from "./boardData";
import { prIsOpen } from "./taskOps";
import type { BoardColumn, BoardColumnId } from "./boardStore";

export type BoardCardAction =
  | { kind: "open-session"; sessionId: string }
  | { kind: "start" }
  | { kind: "fix-ci" }
  | { kind: "comments" }
  | { kind: "open-url" }
  | { kind: "open-prs" }
  | { kind: "review-locally" }
  | { kind: "open-task" }
  | { kind: "reset" }
  | { kind: "pin" }
  | { kind: "promote" }
  | { kind: "archive" }
  | { kind: "remove" }
  | { kind: "snooze"; until?: number; wakeOnChange?: boolean }
  | { kind: "ungroup"; groupId: string };

const KIND_FALLBACK_ICON = {
  item: CircleDot,
  session: Bot,
  local: CircleDot,
  task: FolderTree,
} as const;

/** "Until tomorrow" = next morning — snoozing at 23:40 shouldn't buy
 * twenty minutes. */
const DAY_MS = 24 * 3600_000;
const tomorrow = () => {
  const date = new Date(Date.now() + DAY_MS);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
};
/** A card sits dimmed once it's idled this long with nothing actionable. */
const STALE_MS = 5 * DAY_MS;

function MenuRow({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ComponentType<{
    className?: string;
    strokeWidth?: number;
  }>;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] ${
        danger
          ? "text-red-300/80 hover:bg-red-400/10 hover:text-red-300"
          : "text-content/80 hover:bg-content/8 hover:text-content"
      }`}
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
      {label}
    </button>
  );
}

/** Card ⋯ menu — quick actions. Column changes are drag-only. */
function CardMenu({
  card,
  manual,
  pinned,
  anchor,
  onAction,
  onClose,
}: {
  card: BoardCard;
  manual: boolean;
  pinned: boolean;
  anchor: HTMLElement;
  onAction: (card: BoardCard, action: BoardCardAction) => void;
  onClose: () => void;
}) {
  const liveSession = card.sessions.find((session) => session.live);
  const anySession = liveSession ?? card.sessions[0];
  // Deduped PR urls across lanes + discovered chips — "open all" only
  // earns a row when there's more than one (a single PR opens from its chip).
  const prUrlCount = new Set(
    [
      ...(card.prs ?? []).map((pr) => pr.url),
      ...(card.workstreams ?? []).map((row) => row.pr?.url),
    ].filter((url): url is string => Boolean(url)),
  ).size;
  const reviewablePr =
    card.kind === "item" &&
    card.itemKind === "pr" &&
    card.item &&
    prIsOpen(card.state ?? "");
  const run = (action: BoardCardAction) => () => {
    onAction(card, action);
    onClose();
  };
  return (
    <Popover
      anchor={anchor}
      align="end"
      width={176}
      onDismiss={onClose}
      role="menu"
      aria-label={`Actions for ${card.title}`}
      className="p-1"
    >
      <MenuRow
        icon={PanelRight}
        label="Open details"
        onClick={run({ kind: "open-task" })}
      />
      {card.url ? (
        <MenuRow
          icon={ExternalLink}
          label="Open in provider"
          onClick={run({ kind: "open-url" })}
        />
      ) : null}
      {prUrlCount > 1 ? (
        <MenuRow
          icon={GitPullRequest}
          label={`Open ${prUrlCount} PRs`}
          onClick={run({ kind: "open-prs" })}
        />
      ) : null}
      {reviewablePr ? (
        <MenuRow
          icon={FolderTree}
          label="Review locally"
          onClick={run({ kind: "review-locally" })}
        />
      ) : null}
      {card.kind === "item" && !anySession ? (
        <MenuRow
          icon={Play}
          label="Start work"
          onClick={run({ kind: "start" })}
        />
      ) : null}
      {card.ciFailing > 0 && (anySession || card.task?.workstreams.length) ? (
        <MenuRow
          icon={RefreshCw}
          label="Fix CI"
          onClick={run({ kind: "fix-ci" })}
        />
      ) : null}
      {card.hasUpdate && (anySession || card.task?.workstreams.length) ? (
        <MenuRow
          icon={MessageSquare}
          label="Address updates"
          onClick={run({ kind: "comments" })}
        />
      ) : null}
      {card.kind === "local" ? (
        <MenuRow
          icon={ArrowUp}
          label="Make task"
          onClick={run({ kind: "promote" })}
        />
      ) : null}
      <MenuRow
        icon={pinned ? PinOff : Pin}
        label={pinned ? "Unpin" : "Pin to top"}
        onClick={run({ kind: "pin" })}
      />
      {manual ? (
        <MenuRow
          icon={RotateCcw}
          label="Reset position"
          onClick={run({ kind: "reset" })}
        />
      ) : null}
      <div className="mx-1 my-1 h-px bg-content/10" role="separator" />
      {card.kind !== "local" ? (
        // Locals carry no provider/session signal — a wake fingerprint
        // could never change, so the snooze would be permanent.
        <MenuRow
          icon={Zap}
          label="Snooze until activity"
          onClick={run({ kind: "snooze", wakeOnChange: true })}
        />
      ) : null}
      <MenuRow
        icon={Clock}
        label="Snooze until tomorrow"
        onClick={run({
          kind: "snooze",
          until: tomorrow(),
        })}
      />
      <div className="mx-1 my-1 h-px bg-content/10" role="separator" />
      {card.kind === "local" ? (
        <MenuRow
          icon={Trash2}
          label="Remove"
          danger
          onClick={run({ kind: "remove" })}
        />
      ) : (
        <MenuRow
          icon={Archive}
          label="Archive"
          onClick={run({ kind: "archive" })}
        />
      )}
    </Popover>
  );
}

export function BoardCardView({
  card,
  column,
  columns,
  manual,
  pinned,
  placedAt,
  dragging,
  dropTarget,
  inGroup,
  onAction,
  onDragStart,
}: {
  card: BoardCard;
  /** Column the card renders in — scopes the attention lines. */
  column: BoardColumnId;
  /** All board columns — resolves this column's label. */
  columns: readonly BoardColumn[];
  /** True when the user placed this card by hand — enables "Reset to auto". */
  manual: boolean;
  /** Pinned to the top of the column / its group wrapper. */
  pinned: boolean;
  /** When the card entered this column — drives the age chip/stale dim. */
  placedAt?: number;
  dragging: boolean;
  /** Insertion marker should render above this card. */
  dropTarget: boolean;
  /** Inside a group wrapper — the wrapper carries the colour and labels the
   * group, so the card goes neutral and skips that group's chip. */
  inGroup?: string;
  onAction: (card: BoardCard, action: BoardCardAction) => void;
  onDragStart: (card: BoardCard, event: React.PointerEvent) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const lines = cardAttentionLines(card, column);
  const liveSession = card.sessions.find((session) => session.live);
  const anySession = liveSession ?? card.sessions[0];
  const FallbackIcon =
    card.kind === "item" && card.itemKind === "pr"
      ? GitPullRequest
      : KIND_FALLBACK_ICON[card.kind];
  // First group's colour washes the card — a whole group reads as one hue.
  const groupWash =
    !inGroup && card.groups?.length
      ? groupSwatch(card.groups[0].color).card
      : "border-content/10 bg-content/[0.06]";
  // Inside a group wrapper the wrapper already names that group — only
  // memberships beyond it still earn a chip.
  const chipGroups = (card.groups ?? []).filter(
    (group) => group.id !== inGroup,
  );
  const showStart = card.kind === "item" && !anySession;
  const showFixCi = card.ciFailing > 0 && !!(anySession || card.task?.workstreams.length);
  const showUpdates = card.hasUpdate && !!(anySession || card.task?.workstreams.length);
  const hasActions =
    showStart || showFixCi || showUpdates || card.kind === "local";
  // Column age — surfaced at a glance; the card dims once it's idled past
  // the stale threshold with nothing actionable left.
  const ageDays = placedAt
    ? Math.floor((Date.now() - placedAt) / DAY_MS)
    : 0;
  const stale =
    ageDays * DAY_MS >= STALE_MS &&
    attentionScore(card) === 0 &&
    card.sessions.every((session) => !session.busy);
  const columnLabel = columns.find((entry) => entry.id === column)?.label;

  return (
    <div
      data-board-card={card.id}
      role="button"
      tabIndex={0}
      aria-label={`Open ${card.title}`}
      onPointerDown={(event) => {
        // Whole card is the drag surface — except its interactive elements.
        if (
          (event.target as HTMLElement).closest(
            "button, a, input, textarea, select, [role='checkbox']",
          )
        )
          return;
        onDragStart(card, event);
      }}
      onClick={(event) => {
        // Whole card opens details — the same interactive-element guard as
        // the drag surface keeps buttons/chips/links on their own actions.
        // A completed drag eats this click in the capture phase upstream.
        if (
          (event.target as HTMLElement).closest(
            "button, a, input, textarea, select, [role='checkbox']",
          )
        )
          return;
        onAction(card, { kind: "open-task" });
      }}
      onKeyDown={(event) => {
        if (
          (event.key === "Enter" || event.key === " ") &&
          event.target === event.currentTarget
        ) {
          event.preventDefault();
          onAction(card, { kind: "open-task" });
        }
      }}
      className={`group relative min-w-0 cursor-grab rounded-xl border px-2.5 py-2 outline-none transition-opacity focus-visible:ring-1 focus-visible:ring-accent/60 ${groupWash} ${
        dragging ? "opacity-40" : stale ? "opacity-60" : ""
      }`}
    >
      {dropTarget ? (
        <div
          aria-hidden
          className="absolute -top-[5px] inset-x-1 h-0.5 rounded bg-accent"
        />
      ) : null}
      {/* Header line — provider mark, identity chips, hover actions. */}
      <div className="flex items-center gap-1.5">
        {card.provider ? (
          <InboxProviderMark
            provider={card.provider}
            className="size-3.5 shrink-0 text-content/60"
          />
        ) : (
          <FallbackIcon
            className="size-3.5 shrink-0 text-content/50"
            strokeWidth={1.75}
          />
        )}
        {card.identifier ? (
          <span className="max-w-40 shrink-0 truncate rounded bg-content/8 px-1 py-px text-[10px] font-medium text-content/55">
            {card.identifier}
          </span>
        ) : null}
        {card.draft ? (
          <span className="shrink-0 rounded bg-content/8 px-1 py-px text-[10px] text-content/45">
            Draft
          </span>
        ) : null}
        {ageDays >= 1 ? (
          <span
            className="shrink-0 text-[9px] text-content/35"
            title={`In ${columnLabel ?? column} for ${ageDays} day${ageDays === 1 ? "" : "s"}`}
          >
            {ageDays}d
          </span>
        ) : null}
        {pinned ? (
          <Pin
            className="size-2.5 shrink-0 text-accent"
            strokeWidth={2}
            aria-label="Pinned"
          />
        ) : manual ? (
          <Pin
            className="size-2.5 shrink-0 text-content/30"
            strokeWidth={2}
            aria-label="Manually placed"
          />
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {card.url ? (
            <button
              type="button"
              title="Open in browser"
              aria-label={`Open ${card.title} in browser`}
              className="grid size-5 place-items-center rounded-md text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => onAction(card, { kind: "open-url" })}
            >
              <ExternalLink className="size-3" strokeWidth={1.75} />
            </button>
          ) : null}
          <span>
            <button
              type="button"
              title="Card actions"
              aria-label={`Actions for ${card.title}`}
              aria-haspopup="menu"
              aria-expanded={!!menuAnchor}
              className="grid size-5 place-items-center rounded-md text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
              onClick={(event) =>
                setMenuAnchor((anchor) =>
                  anchor ? null : (event.currentTarget as HTMLElement),
                )
              }
            >
              <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
            </button>
            {menuAnchor ? (
              <CardMenu
                card={card}
                manual={manual}
                pinned={pinned}
                anchor={menuAnchor}
                onAction={onAction}
                onClose={() => setMenuAnchor(null)}
              />
            ) : null}
          </span>
        </span>
      </div>

      <p className="mt-1 line-clamp-2 break-words text-[12px] leading-snug text-content/90">
        {card.title}
      </p>
      {(card.repo || card.projectPath) && card.kind !== "task" ? (
        <p className="mt-0.5 truncate text-[11px] text-content/40">
          {card.repo ?? card.projectPath}
        </p>
      ) : null}
      {chipGroups.length ? (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
          <GroupChips card={card} groups={chipGroups} onAction={onAction} />
        </div>
      ) : null}
      {card.kind === "task" ? (
        <button
          type="button"
          aria-label={`Details for ${card.title}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1.5 flex w-full min-w-0 items-center gap-1 rounded py-1 text-left text-[11px] text-content/55 hover:bg-content/5 hover:text-content focus-visible:outline-accent"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {card.workstreams?.length ?? 0} {card.workstreams?.length === 1 ? "repo" : "repos"} · {card.sessions.length} {card.sessions.length === 1 ? "agent" : "agents"}
            {card.tickets?.length ? ` · ${card.tickets.length} ${card.tickets.length === 1 ? "ticket" : "tickets"}` : ""}
          </span>
          <ChevronRight className={`size-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
      ) : null}
      {card.kind === "task" && card.workstreams?.some((row) => row.probeError) ? (
        <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">Worktree needs attention</p>
      ) : null}
      {card.kind === "task" && expanded ? (
        <TaskMeta
          card={card}
          onOpenSession={(sessionId) =>
            onAction(card, { kind: "open-session", sessionId })
          }
        />
      ) : null}

      {lines.length ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {lines.slice(0, 3).map((line) => (
            <span
              key={line}
              className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium ${
                /fail|input|review/i.test(line)
                  ? "bg-red-400/15 text-red-300"
                  : /working|running/i.test(line)
                    ? "bg-emerald-400/10 text-emerald-300/90"
                    : "bg-accent/15 text-accent"
              }`}
            >
              {/fail|input/i.test(line) ? (
                <AlertCircle className="size-2.5 shrink-0" strokeWidth={2} />
              ) : /working|running/i.test(line) ? (
                <Zap className="size-2.5 shrink-0" strokeWidth={2} />
              ) : (
                <MessageSquare className="size-2.5 shrink-0" strokeWidth={2} />
              )}
              <span className="min-w-0 truncate">{line}</span>
            </span>
          ))}
        </div>
      ) : null}

      {card.sessions.length && card.kind !== "task" ? (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          {card.sessions.slice(0, 3).map((session) => (
            <button
              key={session.id}
              type="button"
              title={session.needsInput ? "Waiting on you" : session.busy ? "Working" : "Open session"}
              className="flex min-w-0 items-center gap-1 rounded text-left text-[11px] text-content/55 hover:text-content"
              onClick={() =>
                onAction(card, { kind: "open-session", sessionId: session.id })
              }
            >
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${sessionDotClass(session)}`}
              />
              <span className="max-w-28 truncate">{session.title}</span>
            </button>
          ))}
          {card.sessions.length > 3 ? (
            <span className="text-[10px] text-content/40">
              +{card.sessions.length - 3}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Footer only renders when there's a real action — details is reached
       * via the title or ⋯ menu. */}
      {hasActions && (card.kind !== "task" || expanded) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {showStart ? (
            <button
              type="button"
              className="flex h-6 items-center gap-1 rounded-md bg-accent/15 px-1.5 text-[11px] font-medium text-accent hover:bg-accent/25"
              onClick={() => onAction(card, { kind: "start" })}
            >
              <Play className="size-3" strokeWidth={2} />
              Start work
            </button>
          ) : null}
          {showFixCi ? (
            <button
              type="button"
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-red-300 hover:bg-red-400/15"
              onClick={() => onAction(card, { kind: "fix-ci" })}
            >
              <RefreshCw className="size-3" strokeWidth={2} />
              Fix CI
            </button>
          ) : null}
          {showUpdates ? (
            <button
              type="button"
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-accent hover:bg-accent/15"
              onClick={() => onAction(card, { kind: "comments" })}
            >
              <MessageSquare className="size-3" strokeWidth={2} />
              Address updates
            </button>
          ) : null}
          {card.kind === "local" ? (
            <>
              <button
                type="button"
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-accent hover:bg-accent/15"
                onClick={() => onAction(card, { kind: "promote" })}
              >
                <ArrowUp className="size-3" strokeWidth={2} />
                Make task
              </button>
              <button
                type="button"
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-content/45 hover:bg-content/10 hover:text-content"
                onClick={() => onAction(card, { kind: "remove" })}
              >
                <X className="size-3" strokeWidth={2} />
                Remove
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Coloured group chips — every card kind can carry groups. Hover reveals
 * an × that removes just that membership (the "ungroup" action). */
function GroupChips({
  card,
  groups,
  onAction,
}: {
  card: BoardCard;
  /** Groups to render — the caller filters out the enclosing wrapper's. */
  groups: readonly { id: string; name: string; color: number }[];
  onAction: (card: BoardCard, action: BoardCardAction) => void;
}) {
  return (
    <>
      {groups.map((group) => {
        const swatch = groupSwatch(group.color);
        return (
          <span
            key={group.id}
            className={`group/chip inline-flex h-4.5 min-w-0 max-w-32 items-center gap-0.5 rounded px-1.5 text-[10px] font-medium ${swatch.chip}`}
          >
            <span className="min-w-0 truncate">{group.name}</span>
            <button
              type="button"
              aria-label={`Remove group ${group.name}`}
              className="grid size-3 shrink-0 place-items-center rounded-sm opacity-0 hover:bg-content/15 group-hover/chip:opacity-100 focus-visible:opacity-100"
              onClick={() => onAction(card, { kind: "ungroup", groupId: group.id })}
            >
              <X className="size-2.5" strokeWidth={2.5} />
            </button>
          </span>
        );
      })}
    </>
  );
}

/** Ticket chips, workstream lanes and discovered PRs on a task card. */
function TaskMeta({
  card,
  onOpenSession,
}: {
  card: BoardCard;
  onOpenSession: (sessionId: string) => void;
}) {
  const tickets = card.tickets ?? [];
  const workstreams = card.workstreams ?? [];
  const prs = card.prs ?? [];
  return (
    <div className="mt-1 flex flex-col gap-1">
      {tickets.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {tickets.slice(0, 4).map((ticket) => (
            <button
              key={ticket.key}
              type="button"
              title={ticket.title}
              className="flex h-4.5 min-w-0 items-center gap-1 rounded bg-content/8 px-1 text-[10px] font-medium text-content/60 hover:bg-content/12 hover:text-content"
              onClick={() => ticket.url && void openUrl(ticket.url)}
            >
              {ticket.provider ? (
                <InboxProviderMark
                  provider={ticket.provider}
                  className="size-2.5 shrink-0"
                />
              ) : null}
              <span className="truncate">
                {ticket.identifier ?? ticket.title}
              </span>
            </button>
          ))}
          {tickets.length > 4 ? (
            <span className="text-[10px] text-content/40">
              +{tickets.length - 4}
            </span>
          ) : null}
        </div>
      ) : null}
      {workstreams.map((row) => (
        <div
          key={row.id}
          className="flex min-w-0 items-center gap-1.5 text-[11px] text-content/55"
        >
          {row.session ? (
            <button
              type="button"
              title={`Open ${row.session.title}`}
              aria-label={`Open ${row.session.title}`}
              className="grid size-3.5 shrink-0 place-items-center rounded hover:bg-content/10"
              onClick={() => onOpenSession(row.session!.id)}
            >
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${sessionDotClass(row.session)}`}
              />
            </button>
          ) : (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-transparent ring-1 ring-content/15"
            />
          )}
          <span className="shrink-0 max-w-24 truncate font-medium text-content/70">
            {row.projectPath.split("/").filter(Boolean).pop() ??
              row.projectPath}
          </span>
          {row.sessionIds.length > 1 ? (
            <span
              className="shrink-0 text-[9px] text-content/40"
              title={`${row.sessionIds.length} conversations`}
            >
              ×{row.sessionIds.length}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-content/40">
            {row.branch}
          </span>
          {row.pr ? (
            <button
              type="button"
              title={`${row.pr.title} — ${row.pr.state}`}
              className={`flex shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium ${
                /open|active/i.test(row.pr.state)
                  ? "bg-amber-400/10 text-amber-300"
                  : "bg-content/8 text-content/45"
              }`}
              onClick={() => void openUrl(row.pr!.url)}
            >
              <GitPullRequest className="size-2.5" strokeWidth={2} />
              {row.pr.number}
            </button>
          ) : null}
          {row.ciFailing ? (
            <span className="shrink-0 rounded bg-red-400/15 px-1 text-[10px] font-medium text-red-300">
              CI ×{row.ciFailing}
            </span>
          ) : row.ciRunning ? (
            <span className="shrink-0 rounded bg-emerald-400/10 px-1 text-[10px] font-medium text-emerald-300/90">
              CI ●
            </span>
          ) : row.ciTotal ? (
            <span className="shrink-0 rounded bg-content/8 px-1 text-[10px] text-content/40">
              CI ✓
            </span>
          ) : null}
          {row.probeError ? (
            <span
              className="shrink-0 rounded bg-amber-400/15 px-1 text-[10px] font-medium text-amber-300"
              title={row.probeError}
            >
              !
            </span>
          ) : null}
        </div>
      ))}
      {prs.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {prs.slice(0, 3).map((pr) => (
            <button
              key={pr.id}
              type="button"
              title={pr.title}
              className="flex h-4.5 min-w-0 items-center gap-1 rounded bg-amber-400/10 px-1 text-[10px] font-medium text-amber-300/90 hover:bg-amber-400/20"
              onClick={() => pr.url && void openUrl(pr.url)}
            >
              <GitPullRequest className="size-2.5 shrink-0" strokeWidth={2} />
              <span className="truncate">
                {pr.identifier ?? pr.title}
              </span>
            </button>
          ))}
          {prs.length > 3 ? (
            <span className="text-[10px] text-content/40">
              +{prs.length - 3}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
