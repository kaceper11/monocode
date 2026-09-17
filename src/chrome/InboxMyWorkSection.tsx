/** Compact my-work badges for inbox rows — the detail pane's work content
 * lives in `InboxTasksSection`; this module only carries the list-row
 * indicators. */
import type { InboxMyWork, InboxMyWorkSession } from "../lib/inboxMyWork";
import { CircleAlert, CircleDot, GitPullRequest } from "./icons";

const SESSION_STATE_DOT: Partial<Record<InboxMyWorkSession["state"], string>> = {
  waiting: "bg-amber-400",
  working: "bg-emerald-400",
};

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
