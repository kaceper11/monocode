import { useState, type ReactNode } from "react";
import {
  CircleDot,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  type IconComponent,
} from "./icons";
import { InboxProviderMark } from "./InboxProviderMark";
import { InboxDetailTab } from "./InboxDetailTab";
import { InboxTasksSection } from "./InboxTasksSection";
import { InboxContextPicker, useInboxContext } from "./InboxContextPicker";
import { ACTION_FILLED, ACTION_OUTLINE } from "./inboxActions";
import type { AttentionItem } from "../lib/attention";
import { contextFromTickets, requestAgentContext } from "../lib/agentContext";
import {
  inboxItemRef,
  inboxItemStatus,
  type InboxComposerCard,
  type InboxItem,
} from "../lib/githubTasks";
import type { InboxMyWork } from "../lib/inboxMyWork";

export type InboxStatusMark = {
  Icon: IconComponent;
  className: string;
  label: string;
};

/** Status reads from the glyph first and the color second, so it survives color blindness. */
export function inboxStatusMark(item: InboxItem): InboxStatusMark {
  const label = inboxItemStatus(item);
  if (item.kind === "ci")
    return {
      Icon: CircleX,
      className: "text-rose-400/90",
      label: "Needs attention",
    };
  const pr = item.kind === "pr";
  if (label === "Draft") {
    return {
      Icon: GitPullRequestDraft,
      className: "text-content/50",
      label,
    };
  }
  if (label === "Merged") {
    return { Icon: GitMerge, className: "text-violet-400/90", label };
  }
  if (label === "Closed") {
    return {
      Icon: pr ? GitPullRequestClosed : CircleX,
      className: "text-rose-400/90",
      label,
    };
  }
  return {
    Icon: pr ? GitPullRequest : CircleDot,
    className: label === "Unknown" ? "text-content/50" : "text-emerald-400/90",
    label,
  };
}

/** Same kind wording on the card and the detail — providers differ in name
 * (work item vs issue, MR vs PR), not in layout. */
export function inboxKindLabel(item: InboxItem): string {
  if (item.kind === "ci") return "CI";
  if (item.kind === "pr")
    return item.provider === "gitlab" ? "Merge request" : "Pull request";
  if (item.kind === "azure") return "Work item";
  return "Issue";
}

export type InboxDetailTabItem = {
  label: string;
  selected: boolean;
  onSelect: () => void;
};

/** The shared inbox item detail chrome: provider row, title, meta, the
 * my-work cluster, Send/Ask agent actions, the context picker modal, an
 * optional Summary/Code tab strip, and the caller-owned body. Providers keep
 * their own loading and review surfaces in the slots. */
export function InboxDetailShell({
  item,
  cwd,
  context,
  source,
  attention,
  meta,
  myWork,
  viewingSessionId,
  onOpenSession,
  onOpenDelivery,
  onOpenAttention,
  onDiscuss,
  actions,
  extra,
  error,
  tabs,
  children,
}: {
  item: InboxItem;
  cwd: string;
  context: ReturnType<typeof useInboxContext>;
  /** Trailing identity — org/project · repository trail. */
  source?: ReactNode;
  /** Accent label next to the status chip ("waiting on you" joins). */
  attention?: ReactNode;
  /** Second row — author, refs, timestamps, provider verdicts. */
  meta?: ReactNode;
  myWork?: InboxMyWork;
  viewingSessionId?: string;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery?: (
    sessionId: string,
    kind: "pr" | "ci",
    current: () => boolean,
    provider: "github" | "azure" | "gitlab",
    prUrl?: string,
    gitlabTarget?: { repo: string; number: number },
  ) => Promise<void>;
  onOpenAttention?: (item: AttentionItem) => void | Promise<void>;
  onDiscuss?: (card: InboxComposerCard) => void | Promise<void>;
  /** Provider actions appended after Send to agent / Ask agent. */
  actions?: ReactNode;
  /** Extra header rows — pickers, related conversations, provider notices. */
  extra?: ReactNode;
  /** Detail-level error row rendered under the actions. */
  error?: ReactNode;
  tabs?: { ariaLabel: string; items: InboxDetailTabItem[] };
  children?: ReactNode;
}) {
  const [sendError, setSendError] = useState("");
  const statusMark = inboxStatusMark(item);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div
        data-inbox-detail-header
        className="relative z-10 shrink-0 border-b border-content/10"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2.5 px-8 pt-5 pb-5">
          <header className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[12px] text-content/50">
              <InboxProviderMark provider={item.provider} className="size-3.5" />
              <span>{inboxKindLabel(item)}</span>
              <span className="tabular-nums">{inboxItemRef(item)}</span>
              <span
                className={`flex items-center gap-1 ${statusMark.className}`}
              >
                <statusMark.Icon className="size-3.5" strokeWidth={1.75} />
                {statusMark.label}
              </span>
              {attention}
              {source}
            </div>
            <h1
              title={item.title}
              className="line-clamp-2 text-[20px] font-semibold leading-tight text-content"
            >
              {item.title}
            </h1>
            {meta ? (
              <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[12px] text-content/50">
                {meta}
              </div>
            ) : null}
            {myWork?.hasWork ? (
              // Bounded — a busy item's task/conversation/queue list must
              // never push the actions and tabs below off the pinned header.
              <div className="max-h-56 overflow-y-auto overscroll-contain">
                <InboxTasksSection
                  item={item}
                  work={myWork}
                  viewingSessionId={viewingSessionId}
                  onOpenSession={onOpenSession}
                  onOpenDelivery={onOpenDelivery}
                  onOpenAttention={onOpenAttention}
                />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setSendError("");
                  try {
                    requestAgentContext({
                      inboxItems: [item],
                      context: contextFromTickets([item]),
                      cwd: item.projectPath || cwd || undefined,
                      onFailed: (reason) => setSendError(reason),
                    });
                  } catch (reason) {
                    setSendError(String(reason));
                  }
                }}
                className={`${ACTION_FILLED} disabled:cursor-default disabled:opacity-40`}
              >
                Send to agent
              </button>
              <button
                type="button"
                disabled={context.busy}
                onClick={() => context.open()}
                className={
                  item.kind === "pr" ? ACTION_FILLED : ACTION_OUTLINE
                }
              >
                <MessageSquare className="size-3.5" strokeWidth={1.75} />
                Ask agent
              </button>
              {actions}
            </div>
            {extra}
            {sendError ? (
              <p role="alert" className="text-[12px] text-red-400">
                {sendError}
              </p>
            ) : null}
            {error}
            <InboxContextPicker
              context={context}
              onConfirm={async (card) => {
                await onDiscuss?.(card);
              }}
            />
          </header>
          {tabs ? (
            <div
              role="tablist"
              aria-label={tabs.ariaLabel}
              className="flex h-9 gap-4 items-stretch border-b border-content/10"
            >
              {tabs.items.map((tab) => (
                <InboxDetailTab
                  key={tab.label}
                  label={tab.label}
                  selected={tab.selected}
                  onSelect={tab.onSelect}
                />
              ))}
            </div>
          ) : (
            <div className="border-t border-content/10" />
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
