import { ContextCheckbox } from "./InboxContextPicker";
import { repairOwnerError } from "../lib/repair";
import { searchSessions, type SessionSummary } from "../lib/sessionStore";
import { useEffect, useRef, useState } from "react";
import { getVerifiedFamilies } from "../lib/repositoryFamilies";
import type { AgentContextRequest } from "../lib/agentContext";
import {
  HARNESS_TITLE,
  HARNESSES,
  harnessSupportsAttachments,
  newDefaultSession,
  newSession,
  sessionWorkCwd,
  type Session,
} from "../lib/session";
import type { RecentProject } from "../lib/recents";
import { wslLocation } from "../lib/paths";
import { Modal } from "./Modal";
import { CwdPicker } from "./CwdPicker";
import { SecondOpinionButton } from "./SecondOpinionButton";
import { Check, File, Plus } from "./icons";

export function AgentContextPicker({
  request,
  sessions,
  history = [],
  recents,
  onPrepare,
  onOpen,
  onClose,
}: {
  request: AgentContextRequest;
  sessions: readonly Session[];
  history?: readonly SessionSummary[];
  recents: RecentProject[];
  onPrepare: (
    request: AgentContextRequest,
    destination: string | Session,
    signal?: AbortSignal,
  ) => string | Promise<string>;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const tickets =
    request.context.entries.length > 0 &&
    request.context.entries.every((entry) => !!entry.ticket);
  const [destination, setDestination] = useState(
    request.requireDestinationSelection ? "" : request.repair && !sessions.some(s => s.id === request.sourceSessionId && !repairOwnerError(s, request.repair!)) ? "new" : request.sourceSessionId ?? "new",
  );
  const [choosingDestination, setChoosingDestination] = useState(!!request.requireDestinationSelection);
  const [instruction, setInstruction] = useState(request.context.instruction ?? "");
  const [selected, setSelected] = useState(() => request.context.entries.map(entry => entry.id));
  const [fresh, setFresh] = useState(() => newDefaultSession(request.cwd));
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [savedMatches, setSavedMatches] = useState<Pick<SessionSummary, "id" | "title" | "cwd" | "harness">[]>([]);
  useEffect(() => {
    setSavedMatches([]);
    if (!search.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchSessions({ query: search, includeArchived: false }).then(result => {
        if (!cancelled) setSavedMatches(result.hits.flatMap(hit => { const harness = HARNESSES.find(harness => harness === hit.harness); return harness ? [{ id: hit.sessionId, title: hit.title, cwd: hit.cwd, harness }] : []; }));
      }).catch(() => { if (!cancelled) setError("Could not search saved conversations. Try again."); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [search]);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const preparation = useRef<AbortController | null>(null);
  useEffect(() => () => preparation.current?.abort(), []);
  const body = useRef<HTMLDivElement>(null);
  const trigger = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [
        ...(body.current
          ?.closest('[role="dialog"]')
          ?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea, summary, select",
          ) ?? []),
      ].filter((el) => el.getClientRects().length);
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => {
      window.removeEventListener("keydown", trap);
      if (!submitting.current) trigger.current?.focus();
    };
  }, []);
  const available = [...new Map([...savedMatches, ...history, ...sessions].map(session => [session.id, session])).values()];
  const target =
    destination === "new"
      ? fresh
      : available.find((session) => session.id === destination);
  const repairError = request.repair ? !selected.length || !instruction.trim() ? "Select evidence and enter an instruction." : destination === "new" ? repairOwnerError(fresh, request.repair) : sessions.find(s => s.id === destination) ? repairOwnerError(sessions.find(s => s.id === destination), request.repair) : "" : "";
  const staleRepair = !!request.repair && /changed|no longer|stale|already attempted/i.test(error);
  const unsupported = repairError || (!destination
    ? "Choose an agent conversation or a new conversation."
    : !target
    ? "Conversation closed. Choose another."
    : !tickets &&
        request.context.attachments.length &&
        !request.attachmentsOptional &&
        !harnessSupportsAttachments(target.harness)
      ? "This agent does not support attachments."
      : destination === "new" && (!fresh.cwd || fresh.cwd === "~")
        ? "Choose a project."
        : "");
  const knownProjects = [
    ...new Map(
      [
        ...recents,
        ...[...getVerifiedFamilies().values()].flatMap((family) =>
          family.worktrees
            .filter((tree) => !tree.missing && !tree.prunable)
            .map((tree) => ({ path: tree.path, openedAt: 0 })),
        ),
      ].map((project) => [project.path, project]),
    ).values(),
  ];
  const matches = available
    .filter(
      (session) =>
        !("inboxAsk" in session && session.inboxAsk) &&
        `${session.title} ${sessionWorkCwd(session)} ${HARNESS_TITLE[session.harness]}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .slice()
    .reverse()
    .sort(
      (a, b) =>
        Number(b.id === request.sourceSessionId) -
        Number(a.id === request.sourceSessionId),
    )
    .slice(0, 30);
  return (
    <Modal
      title={request.repair ? (request.repair.kind === "ci" || request.repair.kind === "github-ci" || request.repair.kind === "gitlab-ci") ? "Fix CI" : "Address comments" : tickets ? "Open conversation" : "Send to agent"}
      description={
        request.repair
          ? request.repair.kind === "comments"
            ? `PR !${request.repair.association.target.number} · ${request.repair.association.pr.title}`
            : request.repair.kind === "github-comments"
              ? `PR #${request.repair.number} · ${request.repair.repo}`
              : request.repair.kind === "github-ci"
                ? `PR #${request.repair.number} · ${request.repair.repo} · ${request.repair.checks.length} check${request.repair.checks.length === 1 ? "" : "s"}`
                : request.repair.kind === "gitlab-comments"
                  ? `MR !${request.repair.number} · ${request.repair.repo}`
                  : request.repair.kind === "gitlab-ci"
                    ? `MR !${request.repair.number} · ${request.repair.repo} · pipeline ${request.repair.pipeline.id}`
                    : `Run ${request.repair.run.id} · ${request.repair.job.name}`
          : tickets
            ? `${request.context.entries.length} selected · titles and descriptions · send when ready`
            : "Selected context · does not auto-send"
      }
      onClose={onClose}
      className="max-h-[80vh] [&_header_h2]:text-base"
    >
      <div ref={body} className="space-y-3 p-3 text-[12px] text-content">
        {!request.repair && request.context.entries.length ? (
          <div className="flex flex-wrap gap-1.5">
            {request.context.entries.map((entry) => (
              <span
                key={entry.id}
                title={entry.origin}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-content/10 px-1.5 py-0.5 text-[11px] text-content/75"
              >
                <File className="size-3 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{entry.title}</span>
                {entry.truncated ? (
                  <span className="shrink-0 text-amber-500">Truncated</span>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
        {request.repair ? <div className="space-y-3">
          <div className="flex items-center justify-between text-content/60"><span>{request.repair.kind === "comments" || request.repair.kind === "github-comments" ? "Comments" : request.repair.kind === "gitlab-comments" ? "Discussions" : request.repair.kind === "github-ci" ? "Check output" : request.repair.kind === "gitlab-ci" ? "Pipeline" : "Log evidence"} · {selected.length} selected</span><button type="button" className="rounded px-1.5 py-1 hover:bg-content/5" disabled={pending} onClick={() => setSelected(selected.length === request.context.entries.length ? [] : request.context.entries.map(entry => entry.id))}>{selected.length === request.context.entries.length ? "Clear selection" : "Select all"}</button></div>
          <div className="max-h-52 overflow-auto rounded-md border border-content/10">{request.context.entries.map(entry => {
            const comment = request.repair?.kind === "comments" ? request.repair.threads.find(thread => thread.entry === entry.id)?.comment : request.repair?.kind === "github-comments" || request.repair?.kind === "gitlab-comments" ? request.repair.comments.find(row => row.entry === entry.id) : undefined;
            return <div key={entry.id} className="flex items-start gap-2 border-b border-content/5 p-2.5 last:border-0">
              <ContextCheckbox label={entry.title} disabled={pending} checked={selected.includes(entry.id)} onChange={() => setSelected(ids => ids.includes(entry.id) ? ids.filter(id => id !== entry.id) : [...ids, entry.id])} />
              <div className="min-w-0 flex-1"><label className="block text-content/70">{comment ? `${comment.author} · comment ${comment.id}` : entry.title}</label>
                {comment?.file ? <p className="truncate text-[11px] text-content/40" title={comment.file}>{comment.file}{comment.line ? `:${comment.line}` : ""}</p> : null}
                <p className="mt-1 whitespace-pre-wrap break-words text-content/85 line-clamp-3">{comment?.text ?? entry.text.slice(0, 500)}</p>
                <details className="mt-1 text-[11px] text-content/45"><summary className="cursor-pointer">Context</summary><pre className="mt-1 whitespace-pre-wrap break-words font-sans">{entry.text}</pre></details>
              </div>
            </div>;
          })}</div>
          <label className="block text-content/60">Instructions<textarea aria-label="Repair instruction" maxLength={4000} rows={2} disabled={pending} className="mt-1 w-full resize-y rounded-md border border-content/10 bg-content/5 px-2 py-1.5 text-[12px] text-content outline-accent" value={instruction} onChange={event => setInstruction(event.target.value)} /></label>
          <details className="text-[11px] text-content/50"><summary className="cursor-pointer">{request.repair.head.branch} · {request.repair.head.commit.slice(0,8)} · {wslLocation(request.repair.head.cwd) ? "WSL" : "Local checkout"}</summary><p className="mt-1 break-all">{request.repair.head.cwd}<br />{request.repair.kind === "ci" ? `Azure Pipelines · ${request.repair.source.projectName}/${request.repair.source.definitionName} · account ${request.repair.source.target.accountId}` : request.repair.kind === "comments" ? `Azure Repos · ${request.repair.association.projectName}/${request.repair.association.repositoryName} · account ${request.repair.association.target.accountId}` : request.repair.kind === "gitlab-comments" || request.repair.kind === "gitlab-ci" ? `GitLab · ${request.repair.repo}` : `GitHub · ${request.repair.repo}`}</p></details>
        </div> : null}
        <details open={!request.repair || choosingDestination || !destination} onToggle={event => { if (request.repair) setChoosingDestination(event.currentTarget.open); }}>
          <summary className={request.repair ? "cursor-pointer rounded-md bg-content/5 px-2 py-2 text-content/70" : "hidden"}>Send to · {destination === "new" ? "New conversation" : target?.title || "Choose conversation"}{target ? ` · ${HARNESS_TITLE[target.harness]}` : ""}</summary>
        <input
          autoFocus={!request.repair}
          aria-label="Search conversations"
          placeholder="Find a conversation…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="mb-1 h-8 w-full rounded-md border border-content/10 bg-transparent px-2 outline-accent"
        />
        <div
          className="max-h-[min(30vh,240px)] overflow-y-auto"
          aria-label="Conversations"
        >
          {matches.map((session) => (
            <button
              type="button"
              key={session.id}
              data-destination={session.id}
              aria-pressed={destination === session.id}
              onClick={() => { setDestination(session.id); setChoosingDestination(false); }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-content/5 ${destination === session.id ? "bg-content/5" : ""}`}
            >
              <Check
                aria-hidden
                className={`size-3.5 shrink-0 ${destination === session.id ? "text-content" : "invisible"}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {session.title || "New conversation"}
                </span>
                <span
                  className="block truncate text-[11px] text-content/45"
                  title={sessionWorkCwd(session)}
                >
                  {HARNESS_TITLE[session.harness]} · {sessionWorkCwd(session)}
                  {wslLocation(sessionWorkCwd(session)) ? " · WSL" : ""}
                </span>
              </span>
              {"busy" in session && session.busy ? (
                <span className="shrink-0 text-[11px] text-content/50">
                  Working
                </span>
              ) : null}
            </button>
          ))}
          {!matches.length ? (
            <p className="px-2 py-3 text-content/45">
              No matching conversations
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-pressed={destination === "new"}
          onClick={() => { setDestination("new"); setChoosingDestination(false); }}
          className={`mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-content/5 ${destination === "new" ? "bg-content/5" : ""}`}
        >
          <Plus className="size-3.5" />
          New conversation
        </button>
        </details>
        {destination === "new" ? (
          <div className="flex min-w-0 items-center justify-between gap-2 px-2 py-1">
            {request.repair ? <span className="text-content/50">Use prepared checkout</span> : <CwdPicker
              cwd={fresh.cwd}
              recents={knownProjects}
              placement="above"
              onCwdChange={(cwd) => setFresh({ ...fresh, cwd })}
            />}
            <span className="flex shrink-0 items-center gap-1 text-content/60">
              {HARNESS_TITLE[fresh.harness]}
              <SecondOpinionButton
                cwd={fresh.cwd}
                from={fresh.harness}
                fromModel={fresh.model}
                includeCurrent
                title="Choose agent"
                onPick={(harness, model) =>
                  setFresh(
                    newSession(harness, fresh.cwd, model, fresh.runtimeMode),
                  )
                }
              />
            </span>
          </div>
        ) : null}
        {request.repair ? <p className="text-[11px] text-content/40">Busy agents queue this request. Replies, pushes and merges stay manual.</p> : null}
        {error || unsupported ? (
          <p role="alert" className="px-2 py-1 text-red-400">
            {error || unsupported}
            {request.repair && error && request.onRefreshEvidence ? <button className="ml-2 underline" disabled={pending} onClick={() => { request.onRefreshEvidence?.(instruction); onClose(); }}>Refresh evidence</button> : null}
          </p>
        ) : null}
        <div className="sticky bottom-0 mt-2 flex justify-end gap-2 border-t border-content/10 bg-background-base pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1.5 text-content/60 hover:bg-content/5"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!!unsupported || pending || staleRepair}
            className="rounded-md bg-content/10 px-2.5 py-1.5 disabled:opacity-40"
            onClick={async () => {
              if (submitting.current || unsupported || staleRepair) return;
              submitting.current = true;
              setPending(true);
              const controller = new AbortController();
              preparation.current = controller;
              try {
                const id = await onPrepare(
                  {
                    ...request,
                    context: request.repair ? { ...request.context, entries: request.context.entries.filter(entry => selected.includes(entry.id)), instruction } : request.context,
                  },
                  destination === "new" ? fresh : destination,
                  controller.signal,
                );
                if (controller.signal.aborted) return;
                if (destination !== "new") onOpen(id);
                onClose();
              } catch (reason) {
                setError(String(reason));
                submitting.current = false;
              } finally {
                setPending(false);
              }
            }}
          >
            {pending
              ? request.repair ? "Checking evidence…" : "Loading context…"
              : request.repair ? destination === "new" ? "Start repair session" : target && "busy" in target && target.busy ? "Queue for owner" : "Send to owner"
              : tickets
                ? "Open conversation"
                : "Add to chat"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
