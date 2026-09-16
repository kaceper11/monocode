import { useState, type ReactNode } from "react";
import { ChevronRight } from "./icons";

/** Shared button tiers for the review surfaces — ghost for routine/navigation,
 * accent for the agent-handoff CTAs, danger for severing actions. */
export const reviewButton =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/80 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
export const reviewAction =
  "inline-flex items-center gap-1.5 rounded-md bg-accent/15 px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
export const reviewDanger =
  "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-rose-300 hover:bg-rose-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60 disabled:opacity-40";
/** Shared input/textarea styling for the review surfaces. */
export const reviewField =
  "w-full rounded-md border border-content/15 bg-content/5 px-2 py-1.5 text-[12px] text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * Shared chrome for the delivery-review surfaces (GitHub PR, Azure PR, GitLab
 * MR, Azure CI): one header row — surface label left, checkout context right —
 * and one status line so loading reads identically across providers.
 */

/** Scroll container every review surface shares. */
export function ReviewShell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto w-full max-w-3xl space-y-3 px-5 py-4 text-[12px]">
        {children}
      </div>
    </section>
  );
}

/** Muted disclosure for secondary facts (revision, mapping) — keeps the main
 * column to title, state and actions. `bordered` suits content-heavy
 * disclosures (checks, threads); bare suits one-fact footnotes. */
export function ReviewDetails({
  summary,
  bordered = false,
  lazy = false,
  open,
  onToggle,
  className,
  children,
}: {
  summary: ReactNode;
  bordered?: boolean;
  /** Mount children only after first open — for markdown-heavy bodies. */
  lazy?: boolean;
  open?: boolean;
  onToggle?: (event: React.SyntheticEvent<HTMLDetailsElement>) => void;
  className?: string;
  children: ReactNode;
}) {
  const [seen, setSeen] = useState(false);
  return (
    <details
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open) setSeen(true);
        onToggle?.(event);
      }}
      className={`group/review ${
        bordered ? "rounded-md border border-content/10" : ""
      } ${className ?? ""}`}
    >
      <summary
        className={`flex cursor-pointer list-none items-center gap-1.5 text-content/60 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden ${
          bordered ? "px-2 py-1.5" : ""
        }`}
      >
        <ChevronRight
          className="size-3 shrink-0 text-content/40 transition-transform group-open/review:rotate-90"
          strokeWidth={1.75}
        />
        {summary}
      </summary>
      <div
        className={`space-y-1 break-words text-content/55 ${
          bordered ? "px-2 pb-2" : "pt-1"
        }`}
      >
        {lazy && !seen && !open ? null : children}
      </div>
    </details>
  );
}

/** Alert line — errors must read as errors, not body copy. */
export function ReviewError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="break-words text-rose-400/90">
      {children}
    </p>
  );
}

export function ReviewHeader({
  label,
  context,
  title,
}: {
  label: string;
  context: string;
  title?: string;
}) {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-content/10 pb-3">
      <h2 className="text-[13px] font-medium">{label}</h2>
      <span className="truncate text-content/50" title={title ?? context}>
        {context}
      </span>
    </header>
  );
}

/** Muted, announced status line — used for pending reads so the surface does
 * not flash a bright empty state before content arrives. */
export function ReviewStatus({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-content/50">
      {children}
    </p>
  );
}

/** State pill tones shared across providers — emerald open/passing, violet
 * merged, amber draft/in-progress, rose failing/abandoned, dim closed. */
export type ReviewTone =
  | "open"
  | "merged"
  | "closed"
  | "draft"
  | "passing"
  | "failing"
  | "running"
  | "neutral";

/** Text color for a tone — used where a pill would be too loud (run rows,
 * check entries). */
export const reviewToneText: Record<ReviewTone, string> = {
  open: "text-emerald-400/90",
  merged: "text-violet-400/90",
  closed: "text-content/55",
  draft: "text-amber-400/90",
  passing: "text-emerald-400/90",
  failing: "text-rose-400/90",
  running: "text-amber-400/90",
  neutral: "text-content/60",
};

const tones: Record<ReviewTone, string> = {
  open: "border-emerald-400/40 text-emerald-300",
  merged: "border-violet-400/40 text-violet-300",
  closed: "border-content/20 text-content/55",
  draft: "border-amber-400/40 text-amber-300",
  passing: "border-emerald-400/40 text-emerald-300",
  failing: "border-rose-400/40 text-rose-300",
  running: "border-amber-400/40 text-amber-300",
  neutral: "border-content/15 text-content/60",
};

export function ReviewPill({
  tone,
  children,
}: {
  tone: ReviewTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
