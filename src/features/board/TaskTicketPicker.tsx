import { useMemo, useState } from "react";
import { Check, Search, X } from "../../shared/ui/icons";
import { InboxProviderMark } from "../inbox/ui/InboxProviderMark";
import { inboxItemRef, type InboxItem } from "../inbox/model/githubTasks";
import type { LinkedWorkItem } from "../sessions/model/session";
import { linkedWorkItemInboxKey } from "../sessions/model/sessionWorkItem";
import { boardTicketOptions } from "./boardData";

export function TaskTicketPicker({
  items,
  links,
  onToggle,
}: {
  items: InboxItem[];
  links: LinkedWorkItem[];
  onToggle: (link: LinkedWorkItem) => void;
}) {
  const [query, setQuery] = useState("");
  const tickets = useMemo(
    () => boardTicketOptions(items, query),
    [items, query],
  );
  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-content/60">
          Tickets
        </h3>
        {links.length ? (
          <span className="text-[11px] text-content/60">
            {links.length} linked
          </span>
        ) : null}
      </div>
      {links.length ? (
        // Linked tickets stay visible as chips — the list scrolls away.
        <div className="mb-1.5 flex flex-wrap gap-1">
          {links.map((link) => {
            const key = linkedWorkItemInboxKey(link);
            return (
              <button
                key={key}
                type="button"
                title={`Unlink ticket: ${link.title || link.url}`}
                aria-label={`Unlink ticket ${link.identifier || (link.number ? `#${link.number}` : link.title || link.url)}`}
                onClick={() => onToggle(link)}
                className="flex max-w-44 items-center gap-1 rounded-md bg-content/7 px-1.5 py-0.5 text-[11px] text-content/70 outline-none hover:bg-content/10 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
              >
                {link.provider ? (
                  <InboxProviderMark
                    provider={link.provider}
                    className="size-3 shrink-0 text-content/55"
                  />
                ) : null}
                <span className="truncate">
                  {link.identifier ||
                    (link.number ? `#${link.number}` : link.title || link.url)}
                </span>
                <X className="size-2.5 shrink-0" strokeWidth={2} />
              </button>
            );
          })}
        </div>
      ) : null}
      <label className="relative mb-1.5 flex items-center">
        <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Inside the form an unguarded Enter submits the whole
            // task — searching must never create worktrees/sessions.
            if (event.key === "Enter") event.preventDefault();
          }}
          placeholder="Search inbox items…"
          aria-label="Search tickets"
          className="h-7 w-full rounded-md bg-content/6 pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/60 focus:ring-1 focus:ring-accent/40"
        />
      </label>
      <div
        role="group"
        aria-label="Tickets"
        className="max-h-44 overflow-y-auto overscroll-none rounded-lg border border-content/8"
      >
        {tickets.map(({ item, linked }) => {
          const key = linkedWorkItemInboxKey(linked);
          const checked = links.some(
            (link) => linkedWorkItemInboxKey(link) === key,
          );
          return (
            <button
              key={key}
              type="button"
              role="checkbox"
              aria-checked={checked}
              onClick={() => onToggle(linked)}
              className="flex w-full items-center gap-2 border-b border-content/5 px-2 py-1.5 text-left outline-none last:border-0 hover:bg-content/5 focus-visible:bg-content/6"
            >
              <InboxProviderMark
                provider={item.provider}
                className="size-3.5 shrink-0 text-content/60"
              />
              <span className="shrink-0 rounded bg-content/8 px-1 py-px text-[10px] font-medium text-content/55">
                {inboxItemRef(item)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                {item.title}
              </span>
              {checked ? (
                <Check
                  className="size-3.5 shrink-0 text-accent"
                  strokeWidth={2.25}
                />
              ) : null}
            </button>
          );
        })}
        {!tickets.length ? (
          <p className="px-3 py-2.5 text-[12px] text-content/60">
            No inbox items match. You can link tickets later.
          </p>
        ) : null}
      </div>
    </section>
  );
}
