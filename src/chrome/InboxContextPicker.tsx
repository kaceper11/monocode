import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { InboxProviderMark } from "./InboxProviderMark";
import { Check, ChevronRight } from "./icons";
import { AgentMarkdown } from "../surfaces/AgentMarkdown";
import type { InboxComposerCard, InboxItem } from "../lib/githubTasks";
import {
  contextChoices,
  DEFAULT_CONTEXT,
  downloadContextFile,
  prepareContext,
  readContext,
  type ContextDocument,
  type ContextSelection,
} from "../lib/inboxContext";

export function ContextCheckbox({
  label,
  checked,
  disabled,
  onChange,
  className,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  /** Overrides the default `mt-0.5` used to align with multi-line rows. */
  className?: string;
}) {
  return (
    <span
      className={`relative inline-flex size-4 shrink-0 ${className ?? "mt-0.5"}`}
    >
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="peer absolute inset-0 z-10 size-4 cursor-pointer opacity-0 disabled:cursor-default"
      />
      <span className="pointer-events-none flex size-4 items-center justify-center rounded border border-content/25 text-transparent peer-checked:border-content/60 peer-checked:bg-content/10 peer-checked:text-content peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-disabled:opacity-35">
        <Check className="size-3" strokeWidth={2} />
      </span>
    </span>
  );
}

export function useInboxContext(item: InboxItem) {
  const [document, setDocument] = useState<ContextDocument>();
  const [selection, setSelection] = useState<ContextSelection>(DEFAULT_CONTEXT);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [action, setAction] = useState<"ask" | "send" | null>(null);
  const alive = useRef(true);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = async (nextPages = pages) => {
    setBusy(true);
    setError("");
    try {
      let next = await readContext(item, nextPages);
      if (!alive.current) throw new Error("Ticket closed");
      if (!document || next.owner !== document.owner) {
        const saved = contextChoices(next.owner, item.url);
        const savedPages = Math.max(1, Math.min(5, saved.pages ?? 1));
        if (savedPages > nextPages) {
          nextPages = savedPages;
          next = await readContext(item, nextPages);
        }
        if (!alive.current) throw new Error("Ticket closed");
        setSelection(saved);
      }
      setDocument(next);
      setPages(nextPages);
      return next;
    } catch (reason) {
      if (alive.current) setError(String(reason));
      throw reason;
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const prepare = async (chosen = selection): Promise<InboxComposerCard> => {
    if (busy) throw new Error("Context is still loading");
    const current = document ?? (await load());
    const choices = document ? chosen : contextChoices(current.owner, item.url);
    setBusy(true);
    setError("");
    try {
      const card = await prepareContext(item, current, choices, pages);
      if (!alive.current) throw new Error("Ticket closed");
      return card;
    } catch (reason) {
      if (alive.current) setError(String(reason));
      throw reason;
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return {
    item,
    document,
    selection,
    pages,
    busy,
    error,
    load,
    prepare,
    action,
    open: (next: "ask" | "send") => {
      trigger.current = globalThis.document.activeElement as HTMLElement;
      setAction(next);
      if (!document) void load().catch(() => {});
    },
    close: () => {
      setAction(null);
      requestAnimationFrame(() => trigger.current?.focus());
    },
    change: (next: ContextSelection) => {
      const saved = { ...next, pages };
      setSelection(saved);
      if (document) contextChoices(document.owner, item.url, saved);
    },
  };
}

export function InboxContextPicker({
  context,
  destination,
  onConfirm,
}: {
  context: ReturnType<typeof useInboxContext>;
  destination?: ReactNode;
  onConfirm: (card: InboxComposerCard, action: "ask" | "send") => Promise<void>;
}) {
  const { item, document, selection, pages, busy, error } = context;
  const action = context.action;
  const [confirmError, setConfirmError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(selection);
  const [preview, setPreview] = useState<{ id: string; url: string }>();
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const generation = useRef(0);
  const body = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (!action) return;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = body.current?.closest('[role="dialog"]');
      const controls = [
        ...(dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), summary, select:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ].filter((el) => el.getClientRects().length > 0);
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && globalThis.document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        globalThis.document.activeElement === last
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => window.removeEventListener("keydown", trap);
  }, [action]);
  useEffect(() => {
    setDraft(selection);
  }, [selection, action]);
  useEffect(() => {
    setConfirmError("");
  }, [action]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const close = () => {
    generation.current++;
    context.close();
    setPreview(undefined);
    setPreviewBusy(false);
  };
  const toggle = (kind: "comments" | "files", id: string) =>
    setDraft((current) => ({
      ...current,
      [kind]: current[kind].includes(id)
        ? current[kind].filter((value) => value !== id)
        : [...current[kind], id],
    }));
  const missing = [
    ...draft.comments
      .filter((id) => !document?.comments.some((c) => c.id === id))
      .map((id) => ({ kind: "comments" as const, id })),
    ...draft.files
      .filter((id) => !document?.files.some((f) => f.id === id))
      .map((id) => ({ kind: "files" as const, id })),
  ];
  return (
    <>
      {action ? (
        <Modal
          title={
            action === "send"
              ? "Send to agent"
              : action === "ask"
                ? item.kind === "ci" ? "Ask about this CI run" : item.kind === "pr" ? "Ask about this PR" : "Ask about this ticket"
                : "Agent context"
          }
          description="Review the context for your next message."
          onClose={close}
          className="max-h-[80vh] text-[13px] text-content [&_header_h2]:text-lg"
        >
          <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-content/10 bg-content/5 p-3">
            <InboxProviderMark
              provider={item.provider}
              className="mt-0.5 size-4 shrink-0"
            />
            <div className="min-w-0">
              <p className="text-[11px] text-content/50">
                {item.identifier || `#${item.number}`} ·{" "}
                {item.provider === "azure" ? `${item.site?.split("/").pop()} / ` : ""}{item.projectName || item.repo}
              </p>
              <p className="mt-0.5 font-medium">{item.title}</p>
            </div>
          </div>
          <fieldset
            ref={body}
            disabled={busy || confirming}
            className="p-4 space-y-3 min-w-0"
          >
            {action === "send" && destination ? (
              <div className="flex items-center justify-between gap-3 border-b border-content/10 pb-3">
                <span className="text-content/55">Local project</span>
                {destination}
              </div>
            ) : null}
            <p className="text-content/45">
              Title and link always included.
            </p>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-content/10 p-3 hover:bg-content/5">
              <ContextCheckbox
                label="Include description"
                checked={draft.description}
                onChange={() =>
                  setDraft({ ...draft, description: !draft.description })
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Description</span>
                <span className="block text-[12px] text-content/45">
                  {item.kind === "ci" ? "Run details and revision" : item.kind === "pr" ? "PR description and revision" : "Ticket details and requirements"}
                </span>
              </span>
            </label>
            {draft.description && document ? (
              <details className="group/preview">
                <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-content/55 hover:bg-content/5 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3.5 shrink-0 group-open/preview:rotate-90" />
                  Preview description
                </summary>
                <div className="mt-3 rounded-lg border border-content/10 p-3">
                  <AgentMarkdown
                    text={document.description || "No description"}
                    textOnly
                  />
                </div>
              </details>
            ) : null}
            <details className="group/section overflow-hidden rounded-lg border border-content/10">
              <summary className="flex cursor-pointer list-none items-center gap-2.5 p-3 font-medium hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 shrink-0 text-content/45 group-open/section:rotate-90" />
                Comments
                <span className="ml-auto text-[11px] font-normal text-content/45">
                  {draft.comments.length
                    ? `${draft.comments.length} selected`
                    : (document?.comments.length ?? 0)}
                </span>
              </summary>
              <div className="border-t border-content/10 p-3">
                {document?.comments.map((comment) => (
                  <div key={comment.id} className="mb-2 flex items-start gap-2">
                    <ContextCheckbox
                      label={`Include comment by ${comment.author}`}
                      checked={draft.comments.includes(comment.id)}
                      onChange={() => toggle("comments", comment.id)}
                    />
                    <details className="group/comment min-w-0 flex-1">
                      <summary className="cursor-pointer list-none rounded px-1 hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">
                            {comment.author || "Unknown author"}
                          </span>
                          <span className="text-[11px] text-content/40">
                            {comment.createdAt?.slice(0, 10)}
                          </span>
                          <ChevronRight className="size-3 shrink-0 text-content/45 group-open/comment:rotate-90" />
                        </span>
                        <span className="mt-0.5 block truncate text-[12px] text-content/55">
                          {comment.body || "Empty comment"}
                        </span>
                      </summary>
                      <div className="mt-2">
                        <AgentMarkdown text={comment.body} textOnly />
                      </div>
                    </details>
                  </div>
                ))}
                {document && !document.comments.length ? (
                  <p className="text-content/45">No comments</p>
                ) : null}
                {document?.more ? (
                  pages < 5 ? (
                    <button
                      type="button"
                      disabled={busy}
                      className="py-1 text-content/70 underline"
                      onClick={() =>
                        void context.load(pages + 1).catch(() => {})
                      }
                    >
                      Load more comments
                    </button>
                  ) : (
                    <p className="text-content/45">
                      Reached the five-page limit per comment type. Open the
                      provider for more discussion.
                    </p>
                  )
                ) : null}
              </div>
            </details>
            <details className="group/section overflow-hidden rounded-lg border border-content/10">
              <summary className="flex cursor-pointer list-none items-center gap-2.5 p-3 font-medium hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 shrink-0 text-content/45 group-open/section:rotate-90" />
                Images & files
                <span className="ml-auto text-[11px] font-normal text-content/45">
                  {draft.files.length
                    ? `${draft.files.length} selected`
                    : (document?.files.length ?? 0)}
                </span>
              </summary>
              <div className="border-t border-content/10 p-3">
                <p className="mb-2 text-[12px] text-content/45">
                  Up to 20 files / 20 MiB total. Only selected files are
                  downloaded when you continue.
                </p>
                {document?.files.map((file) => (
                  <div key={file.id} className="mb-2">
                    <div className="flex items-start gap-2">
                      <ContextCheckbox
                        label={`Include ${file.name}`}
                        disabled={
                          !!file.unavailable ||
                          (file.size ?? 0) > 20 * 1024 * 1024
                        }
                        checked={draft.files.includes(file.id)}
                        onChange={() => toggle("files", file.id)}
                      />
                      <span className="min-w-0 flex-1 break-words">
                        {file.name}
                        <span className="block text-content/45">
                          {file.unavailable ??
                            (file.size === null
                              ? "Size checked on download"
                              : `${(file.size / 1024).toFixed(0)} KiB`)}
                        </span>
                      </span>
                      {!file.unavailable ? (
                        <button
                          type="button"
                          disabled={previewBusy}
                          className="text-content/60 underline"
                          onClick={() => {
                            const current = ++generation.current;
                            setPreviewBusy(true);
                            setPreviewError("");
                            void downloadContextFile(
                              item,
                              document,
                              pages,
                              file.id,
                            )
                              .then((download) => {
                                if (current !== generation.current) return;
                                if (
                                  ![
                                    "image/png",
                                    "image/jpeg",
                                    "image/gif",
                                    "image/webp",
                                  ].includes(download.type)
                                )
                                  throw new Error(
                                    "Preview is available for images only. Other files can be attached without opening or executing them.",
                                  );
                                setPreview({
                                  id: file.id,
                                  url: URL.createObjectURL(download),
                                });
                              })
                              .catch((reason) => {
                                if (current === generation.current)
                                  setPreviewError(String(reason));
                              })
                              .finally(() => {
                                if (current === generation.current)
                                  setPreviewBusy(false);
                              });
                          }}
                        >
                          Preview
                        </button>
                      ) : null}
                    </div>
                    {preview?.id === file.id ? (
                      <img
                        alt={file.name}
                        src={preview.url}
                        className="mt-2 max-h-48 max-w-full rounded"
                      />
                    ) : null}
                  </div>
                ))}
                {document && !document.files.length ? (
                  <p className="text-content/45">No uploaded files found</p>
                ) : null}
                {previewError ? (
                  <p role="alert" className="text-red-400">
                    {previewError}
                  </p>
                ) : null}
              </div>
            </details>
            {missing.map(({ kind, id }) => (
              <p key={`${kind}:${id}`} className="text-amber-400">
                Selected {kind === "files" ? "file" : "comment"} not loaded or
                no longer available.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => toggle(kind, id)}
                >
                  Remove selection
                </button>
              </p>
            ))}
            {error || confirmError ? (
              <p role="alert" className="text-red-400">
                {confirmError || error}
              </p>
            ) : null}
            <button
              type="button"
              disabled={busy}
              className="text-content/55 underline"
              onClick={() => void context.load().catch(() => {})}
            >
              Refresh context
            </button>
            <p className="text-[11px] text-content/40">
              Changing this selection does not remove context already sent to an
              agent. Start a new conversation for a clean context.
            </p>
          </fieldset>
          <div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-content/10 bg-background-base p-3">
            <span className="mr-auto text-[11px] text-content/45">
              Prepares context · does not auto-send
            </span>
            <button
              type="button"
              className="rounded px-3 py-1.5 hover:bg-content/10"
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || confirming || previewBusy || !document}
              className="rounded bg-content/10 px-3 py-1.5 text-content disabled:opacity-40"
              onClick={async () => {
                const current = generation.current;
                setConfirming(true);
                setConfirmError("");
                try {
                  const card = await context.prepare(draft);
                  if (current !== generation.current) return;
                  context.change(draft);
                  await onConfirm(card, action);
                  if (current === generation.current) close();
                } catch (reason) {
                  if (current === generation.current)
                    setConfirmError(String(reason));
                } finally {
                  setConfirming(false);
                }
              }}
            >
              {busy || confirming
                ? "Preparing…"
                : action === "ask"
                  ? "Open discussion"
                  : "Choose conversation"}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
