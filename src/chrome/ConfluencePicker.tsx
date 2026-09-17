import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Checkbox } from "./controls";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";
import { ChevronRight, ExternalLink, LoaderCircle, Search } from "./icons";
import { atlassianCapable, jiraConnected } from "../lib/jira";
import { MAX_CONTEXT_ITEMS, requestAgentContext } from "../lib/agentContext";
import {
  confluenceMarkdown,
  confluencePage,
  confluencePageContext,
  confluenceSearch,
  confluenceSections,
  confluenceSpaces,
  type ConfluencePage,
  type ConfluencePageSummary,
  type ConfluenceSpace,
} from "../lib/confluence";

type Selection = { sections: Set<string> | null };

/** Confluence page/section picker on the shared Atlassian connection. Page
 * content is untrusted reference data — rendered, never executed. */
export function ConfluencePicker({
  cwd,
  sessionId,
  onClose,
}: {
  cwd: string;
  sessionId?: string;
  onClose: () => void;
}) {
  const [site, setSite] = useState<string | null>(null);
  const [connectError, setConnectError] = useState("");
  const [spaces, setSpaces] = useState<ConfluenceSpace[]>([]);
  const [space, setSpace] = useState("");
  const [text, setText] = useState("");
  const [results, setResults] = useState<ConfluencePageSummary[]>([]);
  const [next, setNext] = useState<{ value: string; param: string }>({
    value: "",
    param: "",
  });
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<Map<string, Selection>>(new Map());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pages, setPages] = useState<Map<string, ConfluencePage>>(new Map());
  const [previewError, setPreviewError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const generation = useRef(0);
  const searchSeq = useRef(0);
  const searching = text.trim() !== "";

  useEffect(() => {
    const current = ++generation.current;
    void jiraConnected()
      .then((status) => {
        if (current !== generation.current) return;
        if (!status.connected) {
          setConnectError("Connect Atlassian Cloud in Settings to add Confluence pages.");
          return;
        }
        if (!atlassianCapable(status, "Confluence")) {
          setConnectError(
            "This Atlassian connection has no Confluence access. Reconnect in Settings with an account that can read Confluence.",
          );
          return;
        }
        setSite(status.site);
      })
      .catch((reason: unknown) => {
        if (current === generation.current)
          setConnectError(
            reason instanceof Error ? reason.message : String(reason),
          );
      });
    return () => {
      generation.current++;
    };
  }, []);

  useEffect(() => {
    if (!site) return;
    const current = generation.current;
    void confluenceSpaces(site)
      .then((list) => {
        if (current === generation.current) setSpaces(list);
      })
      .catch(() => {});
  }, [site]);

  const search = (cursor = "", cursorParam = "") => {
    if (!site) return;
    // A fresh search invalidates any in-flight one — otherwise a stale
    // response can overwrite or append onto newer results.
    const seq = ++searchSeq.current;
    const current = generation.current;
    setLoading(true);
    setListError("");
    void confluenceSearch(site, { text, space, cursor, cursorParam })
      .then((page) => {
        if (current !== generation.current || seq !== searchSeq.current) return;
        setResults((existing) =>
          cursor
            ? [
                ...existing,
                ...page.results.filter(
                  (row) => !existing.some((seen) => seen.id === row.id),
                ),
              ].slice(0, 150)
            : page.results,
        );
        setNext({ value: page.next, param: page.nextParam });
      })
      .catch((reason: unknown) => {
        if (current === generation.current && seq === searchSeq.current)
          setListError(
            reason instanceof Error ? reason.message : String(reason),
          );
      })
      .finally(() => {
        if (current === generation.current && seq === searchSeq.current)
          setLoading(false);
      });
  };

  // Recent pages first; debounce text/space changes into a fresh search.
  useEffect(() => {
    if (!site) return;
    setExpanded(null);
    setPreviewError(null);
    // A stale cursor would pair the new query with the old query's page.
    setNext({ value: "", param: "" });
    const timer = window.setTimeout(() => search(), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, text, space]);

  const openPreview = (summary: ConfluencePageSummary) => {
    if (!site) return;
    if (expanded === summary.id) {
      setExpanded(null);
      return;
    }
    setExpanded(summary.id);
    setPreviewError(null);
    if (pages.has(summary.id)) return;
    const current = generation.current;
    void confluencePage(site, summary.id)
      .then((page) => {
        if (current !== generation.current) return;
        if (!page) {
          setPreviewError({
            id: summary.id,
            message: "This page is unavailable.",
          });
          return;
        }
        setPages((existing) => {
          const next = new Map(existing);
          next.set(summary.id, page);
          // Bound retained page bodies; the expanded page is the newest entry.
          while (next.size > 100) {
            const oldest = next.keys().next().value;
            if (oldest === undefined) break;
            next.delete(oldest);
          }
          return next;
        });
      })
      .catch((reason: unknown) => {
        if (current === generation.current)
          setPreviewError({
            id: summary.id,
            message:
              reason instanceof Error ? reason.message : String(reason),
          });
      });
  };

  const togglePage = (summary: ConfluencePageSummary) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(summary.id)) next.delete(summary.id);
      else if (next.size < MAX_CONTEXT_ITEMS)
        next.set(summary.id, { sections: null });
      return next;
    });
  };

  const toggleSection = (page: ConfluencePage, sectionId: string) => {
    setSelected((current) => {
      const existing = current.get(page.id);
      // Selecting a section on an unselected page still counts as a page.
      if (!existing && current.size >= MAX_CONTEXT_ITEMS) return current;
      const next = new Map(current);
      const sections = new Set(existing?.sections ?? []);
      if (sections.has(sectionId)) sections.delete(sectionId);
      else sections.add(sectionId);
      // Unchecking the last section deselects the page rather than silently
      // widening it back to the whole page.
      if (sections.size) next.set(page.id, { sections });
      else next.delete(page.id);
      return next;
    });
  };

  const send = async (destination: "chat" | "agent") => {
    if (!site || !selected.size) return;
    setSending(true);
    setSendError("");
    try {
      const wanted = [...selected.keys()].slice(0, MAX_CONTEXT_ITEMS);
      const fetched = new Map(pages);
      let nextIndex = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, wanted.length) }, async () => {
          while (nextIndex < wanted.length) {
            const id = wanted[nextIndex++];
            if (!fetched.has(id)) {
              // One unavailable page skips; it must not fail the send.
              const page = await confluencePage(site, id).catch(() => null);
              if (page) fetched.set(id, page);
            }
          }
        }),
      );
      const chosen = wanted.flatMap((id) => {
        const page = fetched.get(id);
        if (!page) return [];
        const selection = selected.get(id);
        return [
          {
            page,
            sections: selection?.sections
              ? [...selection.sections]
              : null,
          },
        ];
      });
      if (!chosen.length) throw new Error("Selected pages are unavailable.");
      if (chosen.length < wanted.length) {
        const skipped = wanted
          .filter((id) => !fetched.has(id))
          .map(
            (id) => results.find((row) => row.id === id)?.title ?? `page ${id}`,
          );
        throw new Error(
          `${skipped.length} selected ${skipped.length === 1 ? "page was" : "pages were"} unavailable: ${skipped.join(", ")}. Uncheck them or retry.`,
        );
      }
      const context = confluencePageContext(site, chosen);
      requestAgentContext({
        context,
        ...(destination === "chat"
          ? {
              destination: { kind: "source" as const },
              sourceSessionId: sessionId,
              cwd,
            }
          : {}),
      });
      onClose();
    } catch (reason) {
      setSendError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  const expandedPage = expanded ? (pages.get(expanded) ?? null) : null;
  const expandedMarkdown = useMemo(
    () => (expandedPage ? confluenceMarkdown(expandedPage.storage).text : ""),
    [expandedPage],
  );
  const expandedSections = useMemo(
    () => confluenceSections(expandedMarkdown),
    [expandedMarkdown],
  );
  const spaceOptions = useMemo(
    () => [
      { value: "", label: "All spaces" },
      ...spaces.map((entry) => ({ value: entry.key, label: entry.name })),
    ],
    [spaces],
  );

  return (
    <Modal
      title="Add Confluence pages"
      description={
        searching
          ? "Search page titles and content"
          : "Recently updated pages"
      }
      onClose={() => {
        // Closing mid-send would still land the context after cancel.
        if (!sending) onClose();
      }}
      className="max-h-[80vh] text-[13px] text-content [&_header_h2]:text-base"
    >
      <div className="flex max-h-[62vh] min-h-48 flex-col gap-2 p-3">
        {connectError ? (
          <p className="px-1 py-2 text-content/60">{connectError}</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-content/40" />
                <input
                  autoFocus
                  aria-label="Search Confluence pages"
                  placeholder="Search title or text…"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  className="h-8 w-full rounded-md border border-content/10 bg-transparent pl-7 pr-2 text-[12px] outline-accent"
                />
              </span>
              <Select
                label="Confluence space"
                value={space}
                options={spaceOptions}
                onChange={setSpace}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-content/10">
              {results.map((page) => {
                const chosen = selected.get(page.id);
                const open = expanded === page.id;
                return (
                  <div key={page.id} className="border-b border-content/5 last:border-0">
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <Checkbox
                        className=""
                        label={`Select ${page.title}`}
                        checked={!!chosen}
                        disabled={
                          sending ||
                          (!chosen && selected.size >= MAX_CONTEXT_ITEMS)
                        }
                        onChange={() => togglePage(page)}
                      />
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => openPreview(page)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-content/5"
                      >
                        <ChevronRight
                          className={`size-3 shrink-0 text-content/45 transition-transform ${open ? "rotate-90" : ""}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-content/90">
                            {page.title}
                          </span>
                          <span className="block truncate text-[11px] text-content/45">
                            {page.spaceKey || "Space"}
                            {page.version ? ` · v${page.version}` : ""}
                          </span>
                        </span>
                        {chosen ? (
                          <span className="shrink-0 text-[10px] text-content/45">
                            {chosen.sections
                              ? `${chosen.sections.size} section${chosen.sections.size === 1 ? "" : "s"}`
                              : "Whole page"}
                          </span>
                        ) : null}
                      </button>
                      {page.url ? (
                        <button
                          type="button"
                          title="Open in Confluence"
                          aria-label={`Open ${page.title} in Confluence`}
                          onClick={() => void openUrl(page.url)}
                          className="grid size-6 shrink-0 place-items-center rounded text-content/45 hover:bg-content/5 hover:text-content"
                        >
                          <ExternalLink className="size-3.5" strokeWidth={1.75} />
                        </button>
                      ) : null}
                    </div>
                    {open ? (
                      <div className="border-t border-content/5 px-3 py-2">
                        {expandedPage ? (
                          <>
                            <div className="max-h-48 overflow-y-auto rounded-md border border-content/10 p-2 text-[12px]">
                              <AgentMarkdown
                                text={expandedMarkdown || "Empty page"}
                                textOnly
                              />
                            </div>
                            {expandedSections.length ? (
                              <div className="mt-2 flex max-h-28 flex-col gap-1 overflow-y-auto">
                                <p className="text-[11px] text-content/45">
                                  Whole page is selected by default — pick
                                  sections to bound the content.
                                </p>
                                {expandedSections.map((section) => (
                                  <label
                                    key={section.id}
                                    className="flex cursor-pointer items-center gap-2 text-[12px] text-content/75"
                                  >
                                    <Checkbox
                                      className=""
                                      label={`Include section ${section.title}`}
                                      checked={
                                        selected
                                          .get(page.id)
                                          ?.sections?.has(section.id) ?? false
                                      }
                                      disabled={
                                        sending ||
                                        (!selected.has(page.id) &&
                                          selected.size >= MAX_CONTEXT_ITEMS)
                                      }
                                      onChange={() =>
                                        toggleSection(expandedPage, section.id)
                                      }
                                    />
                                    <span className="truncate">
                                      {section.title}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            ) : null}
                          </>
                        ) : previewError && previewError.id === page.id ? (
                          <p role="alert" className="text-red-400">
                            {previewError.message}
                          </p>
                        ) : (
                          <p className="flex items-center gap-2 text-content/45">
                            <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
                            Loading page…
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {loading ? (
                <p className="flex items-center gap-2 px-3 py-2 text-content/45">
                  <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
                  {searching ? "Searching…" : "Loading recent pages…"}
                </p>
              ) : null}
              {!loading && !results.length && site ? (
                <p className="px-3 py-3 text-content/45">
                  {searching || space
                    ? "No pages match. Try different text or another space."
                    : "No pages yet."}
                </p>
              ) : null}
              {listError ? (
                <p role="alert" className="px-3 py-2 text-red-400">
                  {listError}{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => search()}
                  >
                    Retry
                  </button>
                </p>
              ) : null}
              {next.value && !loading ? (
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-content/60 hover:bg-content/5"
                  onClick={() => search(next.value, next.param)}
                >
                  Load more pages
                </button>
              ) : null}
            </div>
            {selected.size ? (
              <p className="text-[11px] text-content/45">
                {selected.size} page{selected.size === 1 ? "" : "s"} selected —
                content is untrusted reference data for the agent.
              </p>
            ) : null}
            {sendError ? (
              <p role="alert" className="text-red-400">
                {sendError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 border-t border-content/10 pt-2">
              <button
                type="button"
                disabled={sending}
                onClick={onClose}
                className="rounded-md px-2 py-1.5 text-content/60 hover:bg-content/5 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!selected.size || sending}
                className="rounded-md bg-content/10 px-2.5 py-1.5 disabled:opacity-40"
                onClick={() => void send("chat")}
              >
                Add to chat
              </button>
              <button
                type="button"
                disabled={!selected.size || sending}
                className="rounded-md bg-content px-2.5 py-1.5 text-background-base disabled:opacity-40"
                onClick={() => void send("agent")}
              >
                {sending ? "Loading pages…" : "Send to agent…"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
