import type { HarnessEvent } from "./types";
import {
  asRecord,
  museDeltaEvent,
  museItemEvent,
  stringField,
  type MuseItemState,
} from "./museProtocol";
import { formatAgentType } from "./preview";

/**
 * Muse `subagent` items carry a `childSessionId`; the child transcript is a
 * separate MSP session paged via `view/page` and tailed via `view/subscribe`
 * (tdd SS4.5.7). This class converts the followed child session's item
 * notifications into `agent.step` events on the root `subagent` row, mirroring
 * what `AcpSubagents` does for ACP providers. Nested subagents flatten onto
 * the root call — only the outermost item exists in the main transcript.
 *
 * Ordering: the owner pages durable history first, then subscribes with
 * `after` set to the last paged cursor — the server replays `(after, head]`
 * before live events, so the sequence is gapless without buffering (SS4.7.1).
 */

/** Followed child sessions are bounded so a fan-out cannot grow state. */
export const MUSE_MAX_FOLLOWED = 16;
/** Prose steps carry cumulative text; apply.ts re-caps at its own limit. */
const MAX_PROSE_CHARS = 8_000;

export type MuseSubagentMeta = { name?: string; type?: string };

export type FollowedMuseChild = {
  /** The main-session `subagent` item id this trail renders under. */
  callId: string;
  items: Map<string, MuseItemState>;
  /** itemId → accumulated message/reasoning text for merged steps. */
  prose: Map<string, { kind: "message" | "reasoning"; text: string }>;
  agentName?: string;
  agentType?: string;
  /** Last view cursor seen; subscribe and drains resume from it. */
  cursor?: string;
  ended: boolean;
};

export type MuseRoutedChild = {
  events: HarnessEvent[];
  /** Nested child sessions discovered while routing. */
  follow: { sessionId: string; callId: string; meta: MuseSubagentMeta }[];
};

/** Identity shown on the parent row's run: agent path leaf, then its role. */
export function museSubagentMeta(
  item: Record<string, unknown>,
): MuseSubagentMeta {
  const leaf = stringField(item, "agentPath")
    ?.split(/[/\\]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.[a-z0-9]+$/i, "");
  return {
    ...(leaf ? { name: formatAgentType(leaf) } : {}),
    ...(stringField(item, "role")
      ? { type: stringField(item, "role") }
      : {}),
  };
}

export class MuseSubagentTrails {
  private followed = new Map<string, FollowedMuseChild>();

  has(sessionId: string): boolean {
    return this.followed.has(sessionId);
  }

  get(sessionId: string): FollowedMuseChild | undefined {
    return this.followed.get(sessionId);
  }

  callIdFor(sessionId: string): string | undefined {
    return this.followed.get(sessionId)?.callId;
  }

  /**
   * Returns the fresh record for the caller to fill, or undefined when the
   * session is already followed or the bound is reached.
   */
  register(
    sessionId: string,
    callId: string,
    meta?: MuseSubagentMeta,
  ): FollowedMuseChild | undefined {
    if (!sessionId || this.followed.has(sessionId)) return undefined;
    if (this.followed.size >= MUSE_MAX_FOLLOWED) return undefined;
    const child: FollowedMuseChild = {
      callId,
      items: new Map(),
      prose: new Map(),
      ended: false,
      ...(meta?.name ? { agentName: meta.name } : {}),
      ...(meta?.type ? { agentType: meta.type } : {}),
    };
    this.followed.set(sessionId, child);
    return child;
  }

  unregister(sessionId: string): void {
    this.followed.delete(sessionId);
  }

  /**
   * Convert one child-session notification into `agent.step` events on the
   * root row. Item state is per child session, so the shared item/delta
   * parsers apply verbatim; only the emitted event vocabulary changes.
   */
  route(
    sessionId: string,
    method: string,
    params: unknown,
  ): MuseRoutedChild {
    const child = this.followed.get(sessionId);
    const out: MuseRoutedChild = { events: [], follow: [] };
    if (!child) return out;
    const rec = asRecord(params);
    const cursor = stringField(rec, "viewCursor");
    if (cursor) child.cursor = cursor;

    if (
      method === "item/started" ||
      method === "item/updated" ||
      method === "item/completed"
    ) {
      const phase =
        method === "item/started"
          ? "started"
          : method === "item/updated"
            ? "updated"
            : "completed";
      const item = asRecord(rec?.item);
      const itemId = stringField(item ?? {}, "itemId");
      if (!item || !itemId) return out;
      this.push(itemId, museItemEvent(item, phase, child.items), child, out);
      // A nested subagent inside the child runs its own session; following it
      // keeps that activity on the same root row.
      if (stringField(item, "kind") === "subagent") {
        const nested = stringField(item, "childSessionId");
        if (nested && nested !== sessionId && !this.followed.has(nested)) {
          out.follow.push({
            sessionId: nested,
            callId: child.callId,
            meta: museSubagentMeta(item),
          });
        }
      }
      return out;
    }

    if (method === "item/delta") {
      const itemId = stringField(rec, "itemId");
      if (!itemId) return out;
      this.push(itemId, museDeltaEvent(rec, child.items), child, out);
      return out;
    }

    return out;
  }

  private push(
    itemId: string,
    events: HarnessEvent[],
    child: FollowedMuseChild,
    out: MuseRoutedChild,
  ): void {
    const identity = {
      ...(child.agentName ? { agentName: child.agentName } : {}),
      ...(child.agentType ? { agentType: child.agentType } : {}),
    };
    for (const event of events) {
      if (event.type === "tool.started" || event.type === "tool.updated") {
        // Output-only updates (a detail stream) carry no step-worthy change.
        if (!event.title && event.status === undefined && !event.preview) {
          continue;
        }
        out.events.push({
          type: "agent.step",
          callId: child.callId,
          stepId: `item:${event.callId}`,
          kind: "tool",
          text: event.title ?? "",
          toolKind: event.kind,
          status: event.status,
          preview: event.preview,
          ...identity,
        });
      } else if (
        event.type === "message.delta" ||
        event.type === "reasoning.delta"
      ) {
        const kind =
          event.type === "message.delta" ? "message" : "reasoning";
        let prose = child.prose.get(itemId);
        if (!prose || prose.kind !== kind) prose = { kind, text: "" };
        prose.text = (prose.text + event.text).slice(0, MAX_PROSE_CHARS);
        child.prose.set(itemId, prose);
        out.events.push({
          type: "agent.step",
          callId: child.callId,
          stepId: `item:${itemId}`,
          kind,
          text: prose.text,
          ...identity,
        });
      }
      // Child statuses, plans, task lists, approvals and lifecycle events stay
      // inside the child — they must never touch the parent's transcript.
    }
  }
}
