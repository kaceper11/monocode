import {
  ContextCheckbox,
  ContextSelectionSections,
  useInboxContext,
} from "./InboxContextPicker";
import type { SessionSummary } from "../lib/sessionStore";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
} from "react";
import {
  familyHasCopy,
  getVerifiedFamilies,
} from "../lib/repositoryFamilies";
import { familyForRepository } from "../lib/projects";
import {
  liveTaskSessionIds,
  loadTaskWorkspaces,
  projectForTask,
  subscribeTaskWorkspaces,
  taskDestinationForSession,
  taskWorkspacesSnapshot,
} from "../lib/taskWorkspaces";
import {
  contextChoices,
  prepareBatchContexts,
  prepareItemContext,
} from "../lib/inboxContext";
import {
  DEFAULT_BATCH_CONTEXT,
  type AgentContext,
  type AgentContextRequest,
  type AgentDestination,
  type BatchContextChoice,
} from "../lib/agentContext";
import type { Session } from "../lib/session";
import type { InboxItem } from "../lib/githubTasks";
import { pathKey, wslLocation } from "../lib/paths";
import { basename } from "../lib/fs";
import { Modal } from "./Modal";
import { InboxProviderMark } from "./InboxProviderMark";
import { Check, File, ListBullet, Plus } from "./icons";

/** What the user picked — already an AgentDestination; the picker only
 * ever offers task destinations. */
type Picked = Extract<AgentDestination, { kind: "task" | "new-task" }>;

/** Single-item inbox send: the shared selection sections plus a build
 * callback the parent calls at confirm — the freshest provider read wins. */
function InboxItemContext({
  item,
  disabled,
  buildRef,
  onError,
}: {
  item: InboxItem;
  disabled: boolean;
  buildRef: MutableRefObject<
    ((signal?: AbortSignal) => Promise<AgentContext>) | undefined
  >;
  onError: (error: string) => void;
}) {
  const context = useInboxContext(item);
  // A local draft like the Ask flow's — saved choices persist on confirm
  // only, so cancelling the send leaves them untouched.
  const [draft, setDraft] = useState(context.selection);
  useEffect(() => {
    setDraft(context.selection);
  }, [context.selection]);
  useEffect(() => {
    void context.load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // No builder while a read is in flight — confirming then must not
    // stack a second provider read or build from pre-load choices.
    buildRef.current = context.busy
      ? undefined
      : async (signal) => {
          const doc = context.document ?? (await context.load());
          // A just-loaded document means `selection`/`pages` are the
          // pre-load defaults — read the persisted choices instead, the
          // same way useInboxContext.prepare does.
          const choices = context.document
            ? draft
            : contextChoices(doc.owner, item.url);
          const pages = context.document
            ? context.pages
            : Math.max(1, Math.min(5, choices.pages ?? 1));
          // Persist at confirm, matching the Ask modal's semantics.
          context.change(choices);
          return (
            await prepareItemContext(item, doc, choices, pages, signal)
          ).context;
        };
    return () => {
      buildRef.current = undefined;
    };
  });
  useEffect(() => {
    onError(context.error);
  }, [context.error, onError]);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-content/10 bg-content/5 p-3">
        <InboxProviderMark
          provider={item.provider}
          className="mt-0.5 size-4 shrink-0"
        />
        <div className="min-w-0">
          <p className="text-[11px] text-content/50">
            {item.identifier || `#${item.number}`} ·{" "}
            {item.provider === "azure"
              ? `${item.site?.split("/").pop()} / `
              : ""}
            {item.projectName || item.repo}
          </p>
          <p className="mt-0.5 font-medium">{item.title}</p>
        </div>
      </div>
      <p className="text-content/45">Title and link always included.</p>
      <fieldset
        disabled={disabled || context.busy}
        className="min-w-0 space-y-3"
      >
        <ContextSelectionSections
          context={context}
          draft={draft}
          onDraft={setDraft}
        />
      </fieldset>
      {context.busy ? (
        <p role="status" className="text-content/50">
          Loading context…
        </p>
      ) : null}
      <button
        type="button"
        disabled={context.busy}
        className="text-content/55 underline"
        onClick={() => void context.load().catch(() => {})}
      >
        Refresh context
      </button>
    </div>
  );
}

export function AgentContextPicker({
  request,
  sessions,
  history = [],
  onPrepare,
  onClose,
}: {
  request: AgentContextRequest;
  sessions: readonly Session[];
  history?: readonly SessionSummary[];
  onPrepare: (
    request: AgentContextRequest,
    destination: AgentDestination,
    signal?: AbortSignal,
  ) => string | Promise<string>;
  onClose: () => void;
}) {
  const tickets =
    request.context.entries.length > 0 &&
    request.context.entries.every((entry) => !!entry.ticket);
  const inboxItems = request.inboxItems;
  const singleItem = inboxItems?.length === 1 ? inboxItems[0] : undefined;
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const tasks = useMemo(
    () => loadTaskWorkspaces().filter((task) => !task.archived),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasksRaw],
  );
  const headKey = request.repair ? pathKey(request.repair.head.cwd) : "";
  const initialPicked = ((): Picked | undefined => {
    const d = request.destination;
    if (d?.kind === "task") return { kind: "task", taskId: d.taskId };
    if (d?.kind === "new-task") return { kind: "new-task" };
    if (request.repair) {
      // The task already claiming the evidence checkout owns the fix —
      // anywhere else would need a second copy of the same files.
      const owner = tasks.find((task) =>
        task.children.some(
          (child) =>
            child.workingCopy && pathKey(child.workingCopy) === headKey,
        ),
      );
      return owner ? { kind: "task", taskId: owner.id } : undefined;
    }
    // Sends originating inside a task session preselect that task; work
    // items default to a fresh task. Anything else asks for a choice.
    return (
      taskDestinationForSession(request.sourceSessionId) ??
      (inboxItems || tickets ? { kind: "new-task" } : undefined)
    );
  })();
  const [picked, setPicked] = useState<Picked | undefined>(initialPicked);
  const [choosingDestination, setChoosingDestination] =
    useState(!initialPicked);
  const [instruction, setInstruction] = useState(
    request.context.instruction ?? "",
  );
  const [selected, setSelected] = useState(() =>
    request.context.entries.map((entry) => entry.id),
  );
  const [batch, setBatch] = useState<BatchContextChoice>(
    () => request.batch ?? DEFAULT_BATCH_CONTEXT,
  );
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  /** A new destination means a new attempt — stale send/evidence errors
   * must not mask or block it. */
  const pick = (next: Picked) => {
    setPicked(next);
    setChoosingDestination(false);
    setError("");
  };
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const preparation = useRef<AbortController | null>(null);
  const buildItemContext = useRef<
    ((signal?: AbortSignal) => Promise<AgentContext>) | undefined
  >(undefined);
  useEffect(() => () => preparation.current?.abort(), []);
  const trigger = useRef(document.activeElement as HTMLElement | null);
  useEffect(
    () => () => {
      if (!submitting.current) trigger.current?.focus();
    },
    [],
  );
  const liveIds = useMemo(
    () =>
      new Set([...sessions, ...history].map((session) => session.id)),
    [sessions, history],
  );
  /** A repair's task rows: the child whose working copy matches the
   * evidence checkout fixes it in place; a project repo covering the path
   * joins the task on confirm. Project names resolve once here — the
   * search filter must not re-read project storage on every keystroke. */
  const taskRows = useMemo(
    () =>
      tasks.map((task) => {
        const project = projectForTask(task);
        const child = headKey
          ? task.children.find(
              (entry) =>
                entry.workingCopy && pathKey(entry.workingCopy) === headKey,
            )
          : undefined;
        const canAdd =
          !!headKey &&
          !child &&
          !!project?.repositories.some((repo) => {
            if (pathKey(repo.anchor) === headKey) return true;
            const family = familyForRepository(repo, getVerifiedFamilies());
            return family
              ? familyHasCopy(family, request.repair!.head.cwd)
              : false;
          });
        const conversations = liveTaskSessionIds(task, liveIds).length;
        return { task, child, canAdd, conversations, project };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, headKey, liveIds],
  );
  const pickedTask =
    picked?.kind === "task"
      ? tasks.find((task) => task.id === picked.taskId)
      : undefined;
  const repairError =
    request.repair && (!selected.length || !instruction.trim())
      ? "Select evidence and enter an instruction."
      : "";
  const staleRepair =
    !!request.repair &&
    /changed|no longer|stale|already attempted/i.test(error);
  const unsupported =
    repairError ||
    (!picked
      ? "Choose a task."
      : picked.kind === "task" && !pickedTask
        ? "That task no longer exists. Choose another."
        : "");
  const taskMatches = taskRows
    .filter(({ task, project }) =>
      `${task.name} ${project?.name ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .slice()
    .sort((a, b) => {
      if (!request.repair)
        return (
          Number(picked?.kind === "task" && b.task.id === picked.taskId) -
          Number(picked?.kind === "task" && a.task.id === picked.taskId)
        );
      return (
        Number(!!b.child) - Number(!!a.child) ||
        Number(b.canAdd) - Number(a.canAdd) ||
        Number(picked?.kind === "task" && b.task.id === picked.taskId) -
          Number(picked?.kind === "task" && a.task.id === picked.taskId)
      );
    })
    .slice(0, 30);
  const pickedLabel =
    picked?.kind === "task"
      ? (pickedTask?.name ?? "Task")
      : picked?.kind === "new-task"
        ? "New task"
        : "Choose task";
  return (
    <Modal
      title={
        request.repair
          ? request.repair.kind === "ci" ||
            request.repair.kind === "github-ci" ||
            request.repair.kind === "gitlab-ci"
            ? "Fix CI"
            : "Address comments"
          : "Send to agent"
      }
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
          : singleItem
            ? "Choose the context and where the work happens"
            : inboxItems
              ? `${inboxItems.length} tickets · shared context selection`
              : tickets
                ? `${request.context.entries.length} selected · titles and descriptions · send when ready`
                : "Selected context · does not auto-send"
      }
      onClose={onClose}
      trapFocus
      className="max-h-[80vh] [&_header_h2]:text-base"
    >
      <div className="space-y-3 p-3 text-[12px] text-content">
        {singleItem ? (
          <InboxItemContext
            item={singleItem}
            disabled={pending}
            buildRef={buildItemContext}
            onError={setError}
          />
        ) : !request.repair && request.context.entries.length ? (
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
        {inboxItems && inboxItems.length > 1 ? (
          <fieldset
            disabled={pending}
            className="space-y-2 rounded-lg border border-content/10 p-3"
          >
            <p className="font-medium text-content/70">
              Context per ticket
            </p>
            <label className="flex cursor-pointer items-center gap-2.5">
              <ContextCheckbox
                className=""
                label="Include descriptions"
                checked={batch.description}
                onChange={() =>
                  setBatch({ ...batch, description: !batch.description })
                }
              />
              <span>Description</span>
            </label>
            <label className="flex items-center gap-2.5">
              <span className="text-content/60">Recent comments each</span>
              <select
                aria-label="Recent comments per ticket"
                value={batch.comments}
                onChange={(event) =>
                  setBatch({
                    ...batch,
                    comments: Number(event.target.value),
                  })
                }
                className="rounded-md border border-content/10 bg-transparent px-1.5 py-0.5 outline-accent"
              >
                {[0, 1, 3, 5, 10].map((count) => (
                  <option key={count} value={count}>
                    {count === 0 ? "None" : count}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex cursor-pointer items-center gap-2.5">
              <ContextCheckbox
                className=""
                label="Include files"
                checked={batch.files}
                onChange={() => setBatch({ ...batch, files: !batch.files })}
              />
              <span>
                Files{" "}
                <span className="text-content/45">
                  · shared 20 files / 20 MiB limit
                </span>
              </span>
            </label>
          </fieldset>
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
        <details open={!request.repair || choosingDestination || !picked} onToggle={event => { if (request.repair) setChoosingDestination(event.currentTarget.open); }}>
          <summary className={request.repair ? "cursor-pointer rounded-md bg-content/5 px-2 py-2 text-content/70" : "hidden"}>Send to · {pickedLabel}</summary>
        <input
          autoFocus={!request.repair}
          aria-label="Search tasks"
          placeholder="Find a task…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="mb-1 h-8 w-full rounded-md border border-content/10 bg-transparent px-2 outline-accent"
        />
        <div
          className="max-h-[min(30vh,240px)] overflow-y-auto"
          role="group"
          aria-label="Tasks"
        >
          {taskMatches.map(({ task, child, canAdd, conversations }) => (
            <button
              type="button"
              key={task.id}
              data-destination={`task:${task.id}`}
              aria-pressed={
                picked?.kind === "task" && picked.taskId === task.id
              }
              onClick={() => pick({ kind: "task", taskId: task.id })}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-content/5 ${picked?.kind === "task" && picked.taskId === task.id ? "bg-content/5" : ""}`}
            >
              <Check
                aria-hidden
                className={`size-3.5 shrink-0 ${picked?.kind === "task" && picked.taskId === task.id ? "text-content" : "invisible"}`}
              />
              <ListBullet
                className="size-3.5 shrink-0 text-content/45"
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {task.name || "Untitled task"}
                </span>
                <span className="block truncate text-[11px] text-content/45">
                  {request.repair
                    ? child?.workingCopy
                      ? `Fixes in ${basename(child.workingCopy)}`
                      : canAdd
                        ? "Adds the evidence checkout"
                        : "No matching checkout"
                    : conversations
                      ? `${conversations} conversation${conversations === 1 ? "" : "s"}`
                      : "Starts the task"}
                </span>
              </span>
            </button>
          ))}
          {!taskMatches.length ? (
            <p className="px-2 py-3 text-content/45">
              {search ? "No matching tasks" : "No tasks yet"}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          data-destination="new-task"
          aria-pressed={picked?.kind === "new-task"}
          onClick={() => pick({ kind: "new-task" })}
          className={`mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-content/5 ${picked?.kind === "new-task" ? "bg-content/5" : ""}`}
        >
          <Plus className="size-3.5" />
          New task…
        </button>
        </details>
        {request.repair ? <p className="text-[11px] text-content/40">Busy agents queue this request. Replies, pushes and merges stay manual.</p> : null}
        {unsupported || error ? (
          <p role="alert" className="px-2 py-1 text-red-400">
            {unsupported || error}
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
              if (submitting.current || unsupported || staleRepair || !picked)
                return;
              submitting.current = true;
              setPending(true);
              const controller = new AbortController();
              preparation.current = controller;
              try {
                // Inbox item sends build their context at confirm — the
                // freshest provider read and the user's selection win.
                let prepared = request;
                if (singleItem) {
                  if (!buildItemContext.current)
                    throw new Error("Context is still loading.");
                  prepared = {
                    ...request,
                    context: await buildItemContext.current(
                      controller.signal,
                    ),
                    inboxItems: undefined,
                  };
                } else if (inboxItems && inboxItems.length > 1) {
                  prepared = {
                    ...request,
                    context: await prepareBatchContexts(
                      inboxItems,
                      batch,
                      controller.signal,
                    ),
                    inboxItems: undefined,
                  };
                }
                await onPrepare(
                  {
                    ...prepared,
                    context: request.repair
                      ? {
                          ...prepared.context,
                          entries: prepared.context.entries.filter((entry) =>
                            selected.includes(entry.id),
                          ),
                          instruction,
                        }
                      : prepared.context,
                  },
                  picked,
                  controller.signal,
                );
                if (controller.signal.aborted) return;
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
              ? request.repair
                ? "Checking evidence…"
                : "Loading context…"
              : picked?.kind === "new-task"
                ? "Create task…"
                : "Send to task"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
