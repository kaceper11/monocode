import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AttentionItem } from "../lib/attention";
import type {
  InboxMyWork,
  InboxMyWorkCi,
  InboxMyWorkPr,
  InboxMyWorkSession,
} from "../lib/inboxMyWork";
import {
  inboxCiRank,
  inboxPrKind,
  inboxPrRank,
  type InboxPrKind,
} from "../lib/inboxMyWork";
import { sessionDisplayTitle } from "../lib/session";
import { InboxProviderMark } from "./InboxProviderMark";
import {
  ChevronRight,
  CircleAlert,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  Zap,
} from "./icons";

const SESSION_STATE_LABEL: Record<InboxMyWorkSession["state"], string> = {
  waiting: "Waiting on you",
  working: "Working",
  archived: "Archived",
  idle: "Idle",
};

const SESSION_STATE_DOT: Partial<Record<InboxMyWorkSession["state"], string>> = {
  waiting: "bg-amber-400",
  working: "bg-emerald-400",
};

const http = (url: string | undefined) =>
  url && /^https?:\/\//i.test(url) ? url : null;

/** Rows beyond this collapse behind a "Show all" toggle — a ticket with many
 * PRs/pipelines must not flood the detail pane. */
const GROUP_CAP = 4;

const PR_KIND_LABEL: Record<InboxPrKind, string> = {
  attention: "Open",
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

type SummaryPart = { text: string; tone?: "amber" | "rose" | "muted" };

const TONE_CLASS = {
  amber: "text-amber-400",
  rose: "text-rose-400/90",
  muted: "text-content/40",
} as const;

/** One-line rollup for the disclosure header — counts plus the states worth
 * surfacing, capped so many-PR tickets stay a single line. */
export function myWorkSummary(work: InboxMyWork): SummaryPart[] {
  const parts: SummaryPart[] = [];
  if (work.sessions.length)
    parts.push({
      text: `${work.sessions.length} ${work.sessions.length === 1 ? "session" : "sessions"}`,
    });
  const nPrs = work.prs.length;
  if (nPrs) {
    const counts: Record<InboxPrKind, number> = {
      attention: 0,
      open: 0,
      draft: 0,
      merged: 0,
      closed: 0,
    };
    for (const pr of work.prs) counts[inboxPrKind(pr)] += 1;
    const uniform =
      counts.merged === nPrs
        ? "merged"
        : counts.closed === nPrs
          ? "closed"
          : counts.draft === nPrs
            ? "draft"
            : null;
    if (uniform) {
      parts.push({ text: `${nPrs} ${uniform} PR${nPrs === 1 ? "" : "s"}`, tone: "muted" });
    } else {
      parts.push({ text: `${nPrs} PR${nPrs === 1 ? "" : "s"}` });
      const qualifiers: SummaryPart[] = [];
      if (counts.attention)
        qualifiers.push({
          text: `${counts.attention} needs changes`,
          tone: "amber",
        });
      if (counts.open && counts.open !== nPrs)
        qualifiers.push({ text: `${counts.open} open`, tone: "muted" });
      if (counts.merged)
        qualifiers.push({ text: `${counts.merged} merged`, tone: "muted" });
      if (counts.draft)
        qualifiers.push({ text: `${counts.draft} draft`, tone: "muted" });
      if (counts.closed)
        qualifiers.push({ text: `${counts.closed} closed`, tone: "muted" });
      parts.push(...qualifiers.slice(0, 2));
    }
    // Only check-attention failures count here — a pipeline rollup in
    // `pr.ci` is the same source the CI segment already counts.
    const checksFailing = work.prs.filter((pr) => pr.checksFailing).length;
    if (checksFailing)
      parts.push({
        text: `${checksFailing} checks failing`,
        tone: "rose",
      });
  }
  if (work.ci.length) {
    parts.push({ text: `${work.ci.length} CI` });
    const failing = work.ci.filter((row) => row.failing).length;
    const running = work.ci.filter((row) => row.running).length;
    if (failing) parts.push({ text: `${failing} failing`, tone: "rose" });
    else if (running) parts.push({ text: `${running} running`, tone: "muted" });
  }
  if (work.attention.length)
    parts.push({
      text: `${work.attention.length} waiting on you`,
      tone: "amber",
    });
  return parts;
}

function SectionGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-1">
      <p className="py-0.5 text-[11px] font-medium text-content/45">{label}</p>
      {children}
    </div>
  );
}

const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-50";

/**
 * "My work" for one inbox ticket: the sessions, PRs, pipelines and attention
 * rows the local join produced. Rows open their owning context — session
 * rows the conversation, delivery rows the in-app PR/CI view (or the
 * provider URL when no session can host it), attention rows their queue
 * action. Pure presentation: the caller hands it the joined snapshot.
 */
export function InboxMyWorkSection({
  work,
  onOpenSession,
  onOpenDelivery,
  onOpenAttention,
}: {
  work: InboxMyWork;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
  onOpenDelivery?: (
    sessionId: string,
    kind: "pr" | "ci",
    current: () => boolean,
    provider: "github" | "azure",
    prUrl?: string,
  ) => Promise<void>;
  onOpenAttention?: (item: AttentionItem) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const openDelivery = async (
    sessionId: string,
    kind: "pr" | "ci",
    provider: "github" | "azure",
    prUrl?: string,
  ) => {
    if (!onOpenDelivery || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onOpenDelivery(
        sessionId,
        kind,
        () => mounted.current,
        provider,
        prUrl,
      );
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  /** A row is clickable only when it can actually open — in-app review via
   * its session or an http(s) provider link. */
  const prOpenable = (pr: InboxMyWorkPr) =>
    Boolean((pr.sessionId && onOpenDelivery) || http(pr.url));
  const ciOpenable = (row: InboxMyWorkCi) =>
    Boolean((row.sessionId && onOpenDelivery) || http(row.url));

  const prTarget = (pr: InboxMyWorkPr) => () => {
    if (pr.sessionId && onOpenDelivery) {
      void openDelivery(pr.sessionId, "pr", pr.provider, pr.url);
      return;
    }
    const url = http(pr.url);
    if (url) void openUrl(url);
  };

  const ciTarget = (row: InboxMyWorkCi) => () => {
    if (row.sessionId && onOpenDelivery) {
      void openDelivery(row.sessionId, "ci", row.provider);
      return;
    }
    const url = http(row.url);
    if (url) void openUrl(url);
  };

  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  /** Actionable-first order, then the group cap — anything past it sits
   * behind a "Show all" row. */
  const visible = <T,>(key: string, rows: T[]): { rows: T[]; hidden: number } =>
    expandedGroups.has(key) || rows.length <= GROUP_CAP
      ? { rows, hidden: 0 }
      : { rows: rows.slice(0, GROUP_CAP), hidden: rows.length - GROUP_CAP };
  const sortedPrs = useMemo(
    () => [...work.prs].sort((a, b) => inboxPrRank(a) - inboxPrRank(b)),
    [work.prs],
  );
  const sortedCi = useMemo(
    () => [...work.ci].sort((a, b) => inboxCiRank(a) - inboxCiRank(b)),
    [work.ci],
  );
  const parts = myWorkSummary(work);
  const prVisible = visible("prs", sortedPrs);
  const ciVisible = visible("ci", sortedCi);

  const moreRow = (key: string, hidden: number) => (
    <button
      key={`${key}:more`}
      type="button"
      onClick={() => toggleGroup(key)}
      className="w-full rounded-md px-1 py-1 text-left text-[11px] text-content/45 hover:bg-content/5 hover:text-content/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      {hidden ? `Show all ${hidden + GROUP_CAP}…` : "Show less"}
    </button>
  );

  return (
    <details className="group/mywork rounded-lg border border-content/10">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 text-[12px] font-medium hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-content/45 transition-transform group-open/mywork:rotate-90" />
        My work
        <span
          className="ml-auto min-w-0 truncate text-[11px] font-normal text-content/45"
          title={parts.map((part) => part.text).join(" · ")}
        >
          {parts.map((part, index) => (
            <Fragment key={index}>
              {index ? " · " : ""}
              <span className={part.tone ? TONE_CLASS[part.tone] : undefined}>
                {part.text}
              </span>
            </Fragment>
          ))}
        </span>
      </summary>
      <div className="border-t border-content/10 px-3 py-2 text-[12px]">
        {work.sessions.length ? (
          <SectionGroup label="Sessions">
            {work.sessions.map((session) => (
              <button
                key={session.sessionId}
                type="button"
                disabled={!onOpenSession}
                title={`Open session: ${sessionDisplayTitle(session.title, session.harness)}`}
                onClick={() => {
                  if (pending.current) return;
                  void onOpenSession?.(session.sessionId);
                }}
                className={ROW_CLASS}
              >
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${SESSION_STATE_DOT[session.state] ?? "bg-content/25"}`}
                />
                <span className="min-w-0 flex-1 truncate text-content/85">
                  {sessionDisplayTitle(session.title, session.harness)}
                </span>
                {session.taskName ? (
                  <span className="shrink-0 truncate text-[11px] text-content/40">
                    {session.taskName}
                  </span>
                ) : null}
                <span className="shrink-0 text-[11px] text-content/45">
                  {SESSION_STATE_LABEL[session.state]}
                </span>
              </button>
            ))}
          </SectionGroup>
        ) : null}
        {sortedPrs.length ? (
          <SectionGroup label="Pull requests">
            {prVisible.rows.map((pr) => {
              const ci = pr.ci;
              const kind = inboxPrKind(pr);
              return (
                <button
                  key={pr.key}
                  type="button"
                  disabled={!prOpenable(pr)}
                  title={
                    pr.sessionId
                      ? `Open ${pr.provider === "github" ? "GitHub" : "Azure"} PR review`
                      : `Open ${pr.url}`
                  }
                  onClick={prTarget(pr)}
                  className={ROW_CLASS}
                >
                  <InboxProviderMark
                    provider={pr.provider}
                    className="size-3.5 shrink-0"
                  />
                  {kind === "merged" ? (
                    <GitMerge
                      className="size-3 shrink-0 text-content/40"
                      strokeWidth={1.75}
                    />
                  ) : kind === "closed" ? (
                    <GitPullRequestClosed
                      className="size-3 shrink-0 text-content/35"
                      strokeWidth={1.75}
                    />
                  ) : kind === "draft" ? (
                    <GitPullRequestDraft
                      className="size-3 shrink-0 text-content/45"
                      strokeWidth={1.75}
                    />
                  ) : (
                    <GitPullRequest
                      className={`size-3 shrink-0 ${kind === "attention" ? "text-amber-400" : "text-content/50"}`}
                      strokeWidth={1.75}
                    />
                  )}
                  <span className="shrink-0 tabular-nums text-content/55">
                    {pr.number !== undefined ? `#${pr.number}` : "PR"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-content/85">
                    {pr.title || pr.url}
                  </span>
                  <span className="shrink-0 truncate text-[11px] text-content/40">
                    {pr.repo}
                  </span>
                  {ci?.failing ? (
                    <span className="shrink-0 text-[11px] text-rose-400/90">
                      {ci.label}
                    </span>
                  ) : ci?.running ? (
                    <span className="shrink-0 text-[11px] text-content/50">
                      {ci.label}
                    </span>
                  ) : null}
                  {kind === "attention" ? (
                    <span className="shrink-0 text-[11px] text-amber-400">
                      Changes requested
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-content/45">
                      {PR_KIND_LABEL[kind]}
                    </span>
                  )}
                </button>
              );
            })}
            {sortedPrs.length > GROUP_CAP ? moreRow("prs", prVisible.hidden) : null}
          </SectionGroup>
        ) : null}
        {sortedCi.length ? (
          <SectionGroup label="CI">
            {ciVisible.rows.map((row) => (
              <button
                key={row.key}
                type="button"
                disabled={!ciOpenable(row)}
                title={
                  row.sessionId
                    ? "Open pipeline"
                    : row.url
                      ? `Open ${row.url}`
                      : row.name
                }
                onClick={ciTarget(row)}
                className={ROW_CLASS}
              >
                <Zap
                  className="size-3.5 shrink-0 text-content/50"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1 truncate text-content/85">
                  {row.name}
                  {row.runNumber ? (
                    <span className="text-content/45"> · {row.runNumber}</span>
                  ) : null}
                </span>
                <span className="shrink-0 truncate text-[11px] text-content/40">
                  {row.projectName}
                </span>
                <span
                  className={`shrink-0 text-[11px] ${row.failing ? "text-rose-400/90" : "text-content/45"}`}
                >
                  {row.state}
                </span>
              </button>
            ))}
            {sortedCi.length > GROUP_CAP ? moreRow("ci", ciVisible.hidden) : null}
          </SectionGroup>
        ) : null}
        {work.attention.length ? (
          <SectionGroup label="Waiting on you">
            {work.attention.map((row) => (
              <button
                key={row.key}
                type="button"
                disabled={!row.action || !onOpenAttention}
                title={row.detail || row.title}
                onClick={() => void onOpenAttention?.(row)}
                className={ROW_CLASS}
              >
                <CircleAlert
                  className="size-3.5 shrink-0 text-amber-400"
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1 truncate text-content/85">
                  {row.title}
                </span>
                {row.detail ? (
                  <span className="shrink-0 truncate text-[11px] text-content/40">
                    {row.detail}
                  </span>
                ) : null}
              </button>
            ))}
          </SectionGroup>
        ) : null}
        {busy ? (
          <p
            role="status"
            className="flex items-center gap-2 py-1 text-[11px] text-content/50"
          >
            <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
            Opening…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="py-1 text-[12px] text-rose-400">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** Compact badge facts for an inbox row — null when the row stays calm. */
export function myWorkBadges(work: InboxMyWork | undefined): {
  sessionState: "waiting" | "working" | null;
  sessionLabel: string;
  prs: number;
  ciFailing: boolean;
  attention: number;
  aria: string;
} | null {
  if (!work?.hasWork) return null;
  const waiting = work.sessions.filter(
    (row) => row.state === "waiting",
  ).length;
  const working = work.sessions.filter(
    (row) => row.state === "working",
  ).length;
  const sessionState = waiting ? "waiting" : working ? "working" : null;
  const sessionLabel = [
    waiting
      ? `${waiting} session${waiting === 1 ? "" : "s"} waiting on you`
      : "",
    working ? `${working} working` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const prs = work.prs.length;
  const ciFailing =
    work.ci.some((row) => row.failing) ||
    work.prs.some((pr) => pr.ci?.failing === true);
  const attention = work.attention.length;
  const aria = [
    sessionLabel,
    prs ? `${prs} pull request${prs === 1 ? "" : "s"}` : "",
    ciFailing ? "CI failing" : "",
    attention ? `${attention} waiting on you` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return { sessionState, sessionLabel, prs, ciFailing, attention, aria };
}

export function MyWorkBadges({ work }: { work: InboxMyWork | undefined }) {
  const badges = myWorkBadges(work);
  if (!badges || !badges.aria) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {badges.sessionState ? (
        <span
          title={badges.sessionLabel}
          aria-hidden
          className={`size-1.5 rounded-full ${SESSION_STATE_DOT[badges.sessionState]}`}
        />
      ) : null}
      {badges.prs ? (
        <span
          title={`${badges.prs} pull request${badges.prs === 1 ? "" : "s"} from your sessions`}
          className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-content/55"
        >
          <GitPullRequest className="size-3" strokeWidth={1.75} />
          {badges.prs}
        </span>
      ) : null}
      {badges.ciFailing ? (
        <span
          title="CI failing on your work"
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-rose-400/90"
        >
          <CircleDot className="size-3" strokeWidth={1.75} />
          CI
        </span>
      ) : null}
      {badges.attention ? (
        <span
          title={`${badges.attention} item${badges.attention === 1 ? "" : "s"} waiting on you`}
          className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-amber-400"
        >
          <CircleAlert className="size-3" strokeWidth={1.75} />
          {badges.attention}
        </span>
      ) : null}
    </span>
  );
}
