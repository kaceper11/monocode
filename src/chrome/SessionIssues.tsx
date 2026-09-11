import { ChevronDown, ChevronRight } from "./icons";
import { useState } from "react";
import { InboxMiniCard } from "./InboxMiniCard";
import { sessionWorkItems } from "../lib/sessionWorkItem";
import type { Session } from "../lib/session";

/** Persistent issue references, separate from the next-message composer cards. */
export function SessionIssues({
  session,
  onAdd,
}: {
  session: Session;
  onAdd?: () => void;
}) {
  const links = sessionWorkItems(session);
  const [open, setOpen] = useState(() => links.length > 0);
  if (!links.length && !onAdd) return null;
  return (
    <div className="shrink-0 border-b border-content/10 text-[12px]">
      <div className="flex h-8 items-center gap-2 px-3">
        {links.length ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 items-center gap-1 text-content/65 hover:text-content"
            title={links.map((item) => item.title || item.url).join("\n")}
          >
            {open ? <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} /> : <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />}
            <span className="truncate">Issues ·{" "}
            {links
              .map((item) => item.identifier || `#${item.number}`)
              .join(", ")}</span>
          </button>
        ) : null}
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            className="ml-auto shrink-0 rounded px-2 py-1 text-content/55 hover:bg-content/5 hover:text-content"
          >
            Add issues
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="max-h-[min(35vh,240px)] overflow-y-auto pb-2">
          {links.map((item) => (
            <InboxMiniCard
              key={`${item.url}:${item.account ?? ""}`}
              card={{
                provider: item.provider ?? "github",
                account: item.account,
                kind: item.kind,
                identifier: item.identifier || `#${item.number}`,
                title: item.title || `${item.repo} #${item.number}`,
                url: item.url,
                source: [item.provider ?? "github", item.account, item.repo]
                  .filter(Boolean)
                  .join(" · "),
                labels: [],
                prompt: item.context ?? "",
                ...(session.contextDraft?.entries.some(entry => entry.workItem?.url === item.url && entry.workItem?.account === item.account) ? { contextSummary: "Description" } : {}),
                ...(item.context
                  ? {
                      contextPreview: {
                        description: item.context,
                        comments: [],
                      },
                    }
                  : {}),
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
