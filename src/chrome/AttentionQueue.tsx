import { useEffect, useRef, useState } from "react";
import { Popover, type PopoverAnchor } from "./Popover";
import { InboxProviderMark } from "./InboxProviderMark";
import {
  ATTENTION_URGENT,
  type AttentionItem,
} from "../lib/attention";
import { displayPath } from "../lib/paths";
import {
  AlertCircle,
  Bot,
  Clock,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageSquare,
  Play,
  Settings,
  Task,
  Wrench,
  X,
  Zap,
} from "./icons";

/**
 * The attention queue (#76): a compact popover listing every condition that
 * wants the user, urgency-sorted. Rows clear only when their condition
 * resolves or the user mutes them — dispatching an action never clears a row.
 * Keyboard: arrows/j/k move, Enter acts, s snoozes, d/Backspace dismisses,
 * Esc closes.
 */

const KIND_ICON = {
  approval: AlertCircle,
  finished: Bot,
  reminder: Clock,
  repair: Wrench,
  ticket: Task,
  "ticket-update": MessageSquare,
  "pr-review": GitPullRequest,
  "pr-comments": MessageSquare,
  "ci-failure": AlertCircle,
  "pr-behind": GitBranch,
  "pr-conflicts": GitMerge,
  "pr-done": GitPullRequestClosed,
  schedule: Clock,
  check: Play,
  worktree: GitBranch,
  watcher: Zap,
} as const;

export function attentionActionLabel(item: AttentionItem): string {
  switch (item.action?.kind) {
    case "open-session":
      return item.kind === "approval" ? "Respond" : "Open";
    case "open-changes":
      return "Review changes";
    case "open-item":
      return item.kind === "pr-review" ? "Review" : "Open";
    case "start-task":
      return "Start work";
    case "open-delivery":
      return "Open";
    case "send-context":
      return "Send";
    case "repair":
      return "Repair";
    case "azure-pr-comments":
    case "github-pr-comments":
      return "Address comments";
    case "azure-ci-fix":
    case "github-ci-fix":
      return "Fix CI";
    case "update-branch":
      return item.kind === "pr-conflicts" ? "Resolve" : "Update branch";
    case "open-automations":
      return "Automations";
    case "check-fix":
      return "Send to agent";
    case "reconnect":
      return "Reconnect";
    case "open-worktrees":
      return "Clean up";
    case "open-url":
      return "Open";
    default:
      return "Open";
  }
}

/** Compact where/who line under the title — deduped so a repo equal to the
 * checkout path doesn't read twice. */
function itemMeta(item: AttentionItem): string {
  const parts = [
    ...new Set(
      [item.repo, item.cwd ? displayPath(item.cwd) : "", item.account].filter(
        Boolean,
      ),
    ),
  ];
  return parts.slice(0, 3).join(" · ");
}

export function AttentionQueue({
  anchor,
  items,
  onDismiss,
  onAction,
  onSnooze,
  onDismissItem,
  onDismissAll,
  onOpenAutomations,
}: {
  anchor: PopoverAnchor;
  items: AttentionItem[];
  onDismiss: () => void;
  onAction: (item: AttentionItem) => void;
  onSnooze: (item: AttentionItem) => void;
  onDismissItem: (item: AttentionItem) => void;
  onDismissAll: (items: AttentionItem[]) => void;
  onOpenAutomations: () => void;
}) {
  // Selection is tracked by row key, not index — a poll resolving a row
  // above the cursor must not silently re-point the next keystroke at a
  // different item.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const position = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const found = items.findIndex((item) => item.key === activeKey);
  const clamped = items.length
    ? found >= 0
      ? found
      : Math.min(position.current, items.length - 1)
    : 0;
  position.current = clamped;
  const current = items[clamped];

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${clamped}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [clamped]);

  const move = (delta: number) => {
    if (!items.length) return;
    const next = items[(clamped + delta + items.length) % items.length];
    setActiveKey(next.key);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Modified chords belong to the app. Enter/Space on a focused row button
    // must click that button natively — `current` tracks the same row via
    // onFocusCapture, so s/d/arrows below stay consistent with focus.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target instanceof HTMLElement &&
      event.target.closest("button")
    ) {
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "j":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
      case "k":
        event.preventDefault();
        move(-1);
        return;
      case "Enter":
        if (current?.action) {
          event.preventDefault();
          onAction(current);
        }
        return;
      case "s":
        if (current) {
          event.preventDefault();
          onSnooze(current);
        }
        return;
      case "d":
      case "Backspace":
      case "Delete":
        if (event.shiftKey) {
          if (items.length) {
            event.preventDefault();
            onDismissAll(items);
          }
          return;
        }
        if (current) {
          event.preventDefault();
          onDismissItem(current);
        }
        return;
    }
  };

  return (
    <Popover
      anchor={anchor}
      side="bottom"
      align="start"
      width={360}
      maxHeight={440}
      onDismiss={onDismiss}
      autoFocus
      tabIndex={-1}
      className="flex flex-col text-content"
      role="dialog"
      aria-label="Attention queue"
      aria-activedescendant={
        current ? `attention-opt-${current.key}` : undefined
      }
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center justify-between border-b border-content/10 px-3 py-2">
        <p className="text-[12px] font-medium">Attention</p>
        <span className="flex items-center gap-1">
          {items.length ? (
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-content/50 hover:bg-content/5 hover:text-content"
              onClick={() => onDismissAll(items)}
            >
              Clear all
            </button>
          ) : null}
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-content/50 hover:bg-content/5 hover:text-content"
            onClick={() => {
              onDismiss();
              onOpenAutomations();
            }}
          >
            <Settings className="size-3" strokeWidth={1.75} />
            Automations
          </button>
        </span>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-label="Attention items">
        {items.length ? (
          items.map((item, index) => {
            const Icon = KIND_ICON[item.kind] ?? Zap;
            const selected = index === clamped;
            const meta = [item.detail, itemMeta(item)]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                key={item.key}
                id={`attention-opt-${item.key}`}
                data-index={index}
                role="option"
                aria-selected={selected}
                className={`group flex items-start gap-2 rounded-lg px-2 py-2 ${
                  selected ? "bg-content/8" : ""
                }`}
                onPointerEnter={() => setActiveKey(item.key)}
                onFocusCapture={() => setActiveKey(item.key)}
              >
                <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center">
                  {item.provider ? (
                    <InboxProviderMark
                      provider={item.provider}
                      className="size-3.5 text-content/60"
                    />
                  ) : (
                    <Icon className="size-3.5 text-content/60" strokeWidth={1.75} />
                  )}
                  {item.urgency === ATTENTION_URGENT ? (
                    <span
                      aria-hidden
                      className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-accent"
                    />
                  ) : null}
                </span>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => item.action && onAction(item)}
                  disabled={!item.action}
                >
                  <p className="truncate text-[12px] leading-tight text-content/90">
                    {item.title}
                  </p>
                  {meta ? (
                    <p className="mt-0.5 truncate text-[11px] text-content/45">
                      {meta}
                    </p>
                  ) : null}
                </button>
                <span className="flex shrink-0 items-center gap-0.5">
                  {item.action ? (
                    <button
                      type="button"
                      className={`flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium ${
                        selected
                          ? "bg-accent/15 text-accent"
                          : "text-content/50 hover:bg-content/10 hover:text-content"
                      }`}
                      onClick={() => onAction(item)}
                    >
                      <Play className="size-3" strokeWidth={2} />
                      {attentionActionLabel(item)}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title="Snooze until the state changes"
                    aria-label={`Snooze ${item.title}`}
                    className="grid size-6 place-items-center rounded-md text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => onSnooze(item)}
                  >
                    <Clock className="size-3" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    title="Dismiss until the state changes"
                    aria-label={`Dismiss ${item.title}`}
                    className="grid size-6 place-items-center rounded-md text-content/35 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => onDismissItem(item)}
                  >
                    <X className="size-3" strokeWidth={1.75} />
                  </button>
                </span>
              </div>
            );
          })
        ) : (
          <p className="px-3 py-6 text-center text-[12px] text-content/45">
            Nothing needs you right now.
          </p>
        )}
      </div>
      <div className="border-t border-content/10 px-3 py-1.5 text-[10px] text-content/40">
        ↑↓ move · Enter act · S snooze · D dismiss · ⇧D clear — muted rows
        resurface on change
      </div>
    </Popover>
  );
}
