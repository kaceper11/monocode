import type { BoardLocalCard, BoardPlacement } from "./boardStore";
import {
  cardAttentionLines,
  cardColumn,
  type BoardCard,
} from "./boardData";

/**
 * Standup report — markdown sections sourced from real board state:
 * Done/merged (placedAt + provider update times), In flight (current
 * columns + attention lines), Plan (todo order). Pure so it's testable.
 */

/** PR states that mean the work landed (Azure "completed" = merged). */
const MERGED_STATES = new Set(["merged", "completed"]);
const CLOSED_STATES = new Set(["closed", "abandoned", "declined", "removed"]);

const RECENT_MS = 48 * 3600_000;
const MAX_SECTION = 8;
const MAX_PLAN = 5;

export type StandupItem = {
  /** Display/markdown line (no leading "-"). */
  text: string;
  /** Provider URL the row can open in the report modal. */
  url?: string;
};
export type StandupSection = { title: string; items: StandupItem[] };

const refLabel = (card: BoardCard): string =>
  card.identifier ?? (card.itemKind === "pr" ? `#${card.item?.number ?? ""}` : "");

const bullet = (card: BoardCard, extra?: string): StandupItem => {
  const bits = [refLabel(card), card.repo?.split("/").pop()].filter(Boolean);
  return {
    text: `${card.title}${bits.length ? ` — ${bits.join(" · ")}` : ""}${extra ? ` (${extra})` : ""}`,
    url: card.url,
  };
};

/** When the card entered its column — placedAt, else the card's own
 * timestamp (task creation / item update / local creation). */
function enteredAt(
  card: BoardCard,
  placements: Readonly<Record<string, BoardPlacement>>,
  locals: readonly BoardLocalCard[],
): number {
  if (card.kind === "local")
    return (
      locals.find((entry) => entry.id === card.id)?.placedAt ??
      card.updatedAt
    );
  return placements[card.id]?.placedAt ?? card.updatedAt;
}

/** Structured report — the modal renders these natively while
 * `buildStandup` renders the same sections to markdown for the clipboard. */
export function standupSections(input: {
  cards: readonly BoardCard[];
  placements: Readonly<Record<string, BoardPlacement>>;
  locals: readonly BoardLocalCard[];
  now?: number;
}): StandupSection[] {
  const now = input.now ?? Date.now();
  const since = now - RECENT_MS;
  const column = (card: BoardCard) => cardColumn(card, input.placements);

  // --- Done / merged ----------------------------------------------------
  const doneItems: StandupItem[] = [];
  const doneCards = input.cards
    .filter((card) => column(card) === "done")
    .sort(
      (a, b) =>
        enteredAt(b, input.placements, input.locals) -
        enteredAt(a, input.placements, input.locals),
    );
  const coveredPrUrls = new Set<string>();
  for (const card of doneCards.slice(0, MAX_SECTION)) {
    doneItems.push(bullet(card));
    for (const row of card.workstreams ?? [])
      if (row.pr?.url) coveredPrUrls.add(row.pr.url);
    for (const pr of card.prs ?? []) if (pr.url) coveredPrUrls.add(pr.url);
  }
  // Recently merged lane PRs and PRs linked onto cards — a lane can merge
  // while its task is still open elsewhere; the merge itself is reportable
  // work. Both shapes normalize to the same row.
  const merged = input.cards
    .flatMap((card) => [
      ...(card.workstreams ?? [])
        .filter(
          (row) =>
            row.pr &&
            MERGED_STATES.has(row.pr.state.toLowerCase()) &&
            !coveredPrUrls.has(row.pr.url),
        )
        .map((row) => ({
          card,
          label: `PR #${row.pr!.number} merged`,
          url: row.pr!.url,
          at: Date.parse(row.pr!.updatedAt ?? "") || 0,
        })),
      ...(card.prs ?? [])
        .filter(
          (pr) =>
            pr.url &&
            pr.state &&
            MERGED_STATES.has(pr.state.toLowerCase()) &&
            !coveredPrUrls.has(pr.url),
        )
        .map((pr) => ({
          card,
          label: `${pr.identifier ?? "PR"} merged`,
          url: pr.url!,
          at: Date.parse(pr.updatedAt ?? "") || 0,
        })),
    ])
    .filter((entry) => entry.at >= since)
    .sort((a, b) => b.at - a.at);
  // Both sources share the section cap — done cards count first.
  for (const { card, label, url } of merged.slice(
    0,
    Math.max(0, MAX_SECTION - doneItems.length),
  ))
    doneItems.push({ text: `${label} — ${card.title}`, url });
  // Standalone PR cards that closed recently — the review queue cleared.
  for (const card of input.cards) {
    if (doneItems.length >= MAX_SECTION) break;
    if (card.kind !== "item" || card.itemKind !== "pr") continue;
    if (column(card) === "done") continue; // already listed
    const state = (card.state ?? "").toLowerCase();
    if (!MERGED_STATES.has(state) && !CLOSED_STATES.has(state)) continue;
    if ((card.item ? Date.parse(card.item.updatedAt) : 0) < since) continue;
    doneItems.push(
      bullet(
        card,
        MERGED_STATES.has(state) ? "merged" : "closed",
      ),
    );
  }

  // --- In flight ---------------------------------------------------------
  const flightItems = input.cards
    .filter((card) => {
      const col = column(card);
      return col === "progress" || col === "review";
    })
    .slice(0, MAX_SECTION)
    .map((card) => {
      const attention = cardAttentionLines(card, column(card))[0];
      const working = card.sessions.some((session) => session.busy)
        ? "agent working"
        : "";
      const extra = [attention, working].filter(Boolean).join("; ");
      return bullet(card, extra || undefined);
    });

  // --- Plan ---------------------------------------------------------------
  const planItems = input.cards
    .filter((card) => column(card) === "todo")
    .slice(0, MAX_PLAN)
    .map((card) => bullet(card));

  const sections: StandupSection[] = [];
  if (doneItems.length) sections.push({ title: "Done / merged", items: doneItems });
  if (flightItems.length) sections.push({ title: "In flight", items: flightItems });
  if (planItems.length) sections.push({ title: "Plan", items: planItems });
  return sections;
}

export function standupMarkdown(sections: readonly StandupSection[]): string {
  return sections
    .map(
      (section) =>
        `### ${section.title}\n` +
        section.items
          .map((item) => `- ${item.text}${item.url ? ` (${item.url})` : ""}`)
          .join("\n"),
    )
    .join("\n\n");
}

export function buildStandup(input: {
  cards: readonly BoardCard[];
  placements: Readonly<Record<string, BoardPlacement>>;
  locals: readonly BoardLocalCard[];
  now?: number;
}): string {
  return standupMarkdown(standupSections(input));
}
