import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Checkbox } from "./controls";
import { InboxProviderMark } from "./InboxProviderMark";
import { ChevronRight, LoaderCircle } from "./icons";
import { inboxItemStatus, type InboxItem } from "../lib/githubTasks";
import {
  contextFromTickets,
  contextTicketKey,
  MAX_CONTEXT_ITEMS,
  requestAgentContext,
} from "../lib/agentContext";
import {
  loadInboxRelations,
  type InboxRelationEdge,
  type InboxRelations,
} from "../lib/inboxRelations";

/** Collapsed provider-native relations for the open Inbox item. Loads on
 * first expand; a failed provider shows its own error inside the section. */
export function InboxRelated({ item }: { item: InboxItem }) {
  const [open, setOpen] = useState(false);
  const [relations, setRelations] = useState<InboxRelations | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [sendError, setSendError] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const load = () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    void loadInboxRelations(item)
      .then((next) => {
        if (current !== generation.current) return;
        setRelations(next);
        setSelected([]);
      })
      .catch((reason: unknown) => {
        if (current !== generation.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
  };

  const count = relations?.groups.reduce((sum, g) => sum + g.edges.length, 0);
  const selectable = (edge: InboxRelationEdge) =>
    // Foreign-repository rows are display-only: detail fetches resolve the
    // repo from the local project, so selecting them would read the wrong
    // work item.
    !!edge.item && !edge.foreign;

  const selectedItems = () => {
    const wanted = new Set(selected);
    // The same target can legitimately appear under two groups — send it once.
    const items = new Map<string, InboxItem>();
    for (const edge of (relations?.groups ?? []).flatMap((group) => group.edges)) {
      if (!edge.item) continue;
      const id = contextTicketKey(edge.item);
      if (wanted.has(id)) items.set(id, edge.item);
    }
    return [...items.values()];
  };

  const send = () => {
    setSendError("");
    try {
      const items = [item, ...selectedItems()];
      requestAgentContext({
        inboxItems: items,
        context: contextFromTickets(items),
        cwd: item.projectPath || undefined,
        // The send landed — the row checkboxes served their purpose.
        onPrepared: () => setSelected([]),
        onFailed: (reason) => setSendError(reason),
      });
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // PRs, CI items and delivery rows have no work-item relations.
  if (item.delivery || item.kind === "pr" || item.kind === "ci") {
    return null;
  }

  return (
    <details
      className="group/related rounded-lg border border-content/10"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next && !relations && !loading) load();
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 text-[12px] font-medium hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-content/45 transition-transform group-open/related:rotate-90" />
        Related work items
        {count ? (
          <span className="ml-auto text-[11px] font-normal text-content/45">
            {selected.length ? `${selected.length} selected · ` : ""}
            {count}
          </span>
        ) : null}
      </summary>
      <div className="border-t border-content/10 px-3 py-2 text-[12px]">
        {loading ? (
          <p className="flex items-center gap-2 py-1 text-content/45">
            <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
            Loading related items…
          </p>
        ) : error ? (
          <p className="py-1 text-content/55">
            {error}{" "}
            <button type="button" className="underline" onClick={load}>
              Retry
            </button>
          </p>
        ) : relations && !relations.groups.length ? (
          <p className="py-1 text-content/45">No linked work items</p>
        ) : (
          (relations?.groups ?? []).map((group) => (
            <div key={group.key} className="py-1">
              <p className="py-0.5 text-[11px] font-medium text-content/45">
                {group.label}
              </p>
              {group.edges.map((edge, index) => {
                const linked = edge.item;
                const id = linked
                  ? contextTicketKey(linked)
                  : `${edge.key}:${edge.ref}:${index}`;
                const status = linked ? inboxItemStatus(linked) : "";
                return (
                  <div
                    key={id}
                    className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1"
                  >
                    {selectable(edge) ? (
                      <Checkbox
                        className=""
                        label={`Include ${edge.ref}`}
                        disabled={
                          !selected.includes(id) &&
                          selected.length >= MAX_CONTEXT_ITEMS - 1
                        }
                        checked={selected.includes(id)}
                        onChange={() =>
                          setSelected((current) =>
                            current.includes(id)
                              ? current.filter((value) => value !== id)
                              : [...current, id],
                          )
                        }
                      />
                    ) : (
                      <span className="size-4 shrink-0" aria-hidden />
                    )}
                    <InboxProviderMark
                      provider={item.provider}
                      className="size-3.5 shrink-0"
                    />
                    {linked?.url ? (
                      <button
                        type="button"
                        title={`Open ${edge.ref} in the provider`}
                        onClick={() => {
                          // Provider-supplied URL — only hand http(s) to the
                          // system opener, matching MarkdownLink's guard.
                          if (/^https?:\/\//i.test(linked.url))
                            void openUrl(linked.url);
                        }}
                        className="flex min-w-0 flex-1 items-baseline gap-2 rounded text-left hover:bg-content/5"
                      >
                        <span className="shrink-0 tabular-nums text-content/55">
                          {edge.ref}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-content/85">
                          {linked.title || edge.ref}
                        </span>
                        {edge.foreign ? (
                          <span className="shrink-0 text-[11px] text-content/40">
                            {linked.repo}
                          </span>
                        ) : null}
                        {status ? (
                          <span className="shrink-0 text-[11px] text-content/45">
                            {status}
                          </span>
                        ) : null}
                      </button>
                    ) : (
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="shrink-0 tabular-nums text-content/55">
                          {edge.ref}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-content/45">
                          {linked ? linked.title || edge.ref : "Unavailable"}
                        </span>
                      </span>
                    )}
                    <span className="shrink-0 text-[11px] text-content/40">
                      {edge.label}
                    </span>
                  </div>
                );
              })}
            </div>
          ))
        )}
        {relations?.truncated ? (
          <p className="py-1 text-[11px] text-content/40">
            Showing the first page of relations. Open the provider for more.
          </p>
        ) : null}
        {selected.length ? (
          <div className="flex items-center gap-2 border-t border-content/10 pt-2">
            <button
              type="button"
              className="rounded-md bg-content/10 px-2.5 py-1.5 hover:bg-content/15 disabled:opacity-40"
              onClick={send}
            >
              Send ticket + {selected.length} related to agent…
            </button>
            <button
              type="button"
              className="text-content/55 underline"
              onClick={() => setSelected([])}
            >
              Clear
            </button>
          </div>
        ) : null}
        {sendError ? (
          <p role="alert" className="py-1 text-red-400">
            {sendError}
          </p>
        ) : null}
      </div>
    </details>
  );
}
