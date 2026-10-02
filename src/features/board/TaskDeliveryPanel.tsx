import { groupedDeliveryChecks } from "./delivery";
import { useEffect, useMemo, useRef, useState } from "react";
import { invokeWorkspace as invoke } from "../../platform/tauri/fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Checkbox } from "../../shared/ui/Checkbox";
import { Modal } from "../../shared/ui/Modal";
import {
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  X,
} from "../../shared/ui/icons";
import { InboxComments } from "../inbox/ui/InboxComments";
import { checkDuration } from "../inbox/model/githubPrChecks";
import { getSession } from "../sessions/data/sessionStore";
import type { Session } from "../sessions/model/session";
import { listWorktrees } from "../source-control/model/worktrees";
import { pathKey } from "../../shared/lib/paths";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import {
  loadBoard,
  updateTask,
  type BoardTask,
  type TaskWorkstream,
} from "./boardStore";
import type { WorkstreamStatus } from "./boardData";
import { sendHandoff, type HandoffKind } from "./handoff";
import { CHECK_APPEARANCE } from "./DeliveryControls";
import {
  checkState,
  commentEvidence,
  deliveryKey,
  evidenceFingerprint,
  isFailedCheck,
  loadComments,
  matchesTarget,
  probeDelivery,
  PROVIDER_NAMES,
  snapshotIdentity,
  type DeliveryCheck,
  type DeliverySnapshot,
  type DeliveryTarget,
  type ReviewComment,
  type SendToSession,
} from "./delivery";
import {
  parseReplyBundle,
  replyDraftKey,
  replyScope,
  type Reply,
} from "./replyDrafts";

type DetailNode = {
  id: string;
  parentId?: string;
  kind: string;
  name: string;
  state: string;
  startedAt: string;
  completedAt: string;
};
type CheckDetails = {
  nodes: DetailNode[];
  annotations: { path: string; line: number; message: string; level: string }[];
  notice?: string;
};
// Neutral bordered chip — local view/navigation actions.
const action =
  "inline-flex h-7 items-center gap-1 rounded-md border border-content/10 bg-content/3 px-2 text-[11px] font-medium text-content/70 hover:bg-content/8 hover:text-content focus-visible:outline-accent disabled:opacity-40";
// Accent — dispatch actions that send work elsewhere (handoffs, imports).
const accentAction =
  "inline-flex h-7 items-center gap-1 rounded-md border border-accent/15 bg-accent/10 px-2 text-[11px] font-medium text-accent hover:bg-accent/20 focus-visible:outline-accent disabled:opacity-40";
// Compact accent ghost — repeated per-row actions inside dense lists.
const rowAction =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/10 disabled:opacity-40";
// Icon-only buttons stay light.
const iconAction =
  "grid size-6 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content focus-visible:outline-accent disabled:opacity-40";

export function orderedCheckNodes(nodes: DetailNode[]): DetailNode[] {
  const unique = [...new Map(nodes.map((node) => [node.id, node])).values()];
  const ids = new Set(unique.map((node) => node.id));
  const children = new Map<string | undefined, DetailNode[]>();
  for (const node of unique) {
    const parent =
      node.parentId && ids.has(node.parentId) ? node.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const seen = new Set<string>();
  const result: DetailNode[] = [];
  const visit = (node: DetailNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    result.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  for (const node of children.get(undefined) ?? []) visit(node);
  for (const node of unique) visit(node);
  return result;
}

function CheckRow({
  ws,
  check,
  refresh,
  selected,
  onSelect,
  onFix,
  children,
  selectable = true,
}: {
  ws: TaskWorkstream;
  check: DeliveryCheck;
  refresh?: number;
  selected: boolean;
  onSelect: () => void;
  onFix?: () => void;
  children?: React.ReactNode;
  selectable?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<CheckDetails>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<{ text: string; truncated: boolean }>();
  const [logBusy, setLogBusy] = useState(false);
  const [logError, setLogError] = useState("");
  const currentKey = useRef("");
  const key = JSON.stringify([deliveryKey(ws), check]);
  currentKey.current = key;
  useEffect(
    () => () => {
      currentKey.current = "";
    },
    [],
  );
  useEffect(() => {
    setDetails(undefined);
    setLog(undefined);
    setLogBusy(false);
    setLogError("");
  }, [key]);
  useEffect(() => {
    let active = true;
    if (expanded && !children) {
      setLoading(true);
      setError("");
      void invoke<CheckDetails>("task_delivery_details", {
        cwd: ws.worktreePath || ws.projectPath,
        check,
      })
        .then((result) => {
          if (active) setDetails(result);
        })
        .catch((reason) => {
          if (active) setError(String(reason));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
    // key includes the complete checkout/check identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, key, refresh]);
  const parents = useMemo(
    () => new Map(details?.nodes.map((node) => [node.id, node]) ?? []),
    [details],
  );
  const state = checkState(check),
    appearance = CHECK_APPEARANCE[state];
  const loadLog = async () => {
    if (logBusy) return;
    setLogBusy(true);
    setLogError("");
    try {
      const result = await invoke<{ text: string; truncated: boolean }>(
        "task_delivery_log",
        { cwd: ws.worktreePath || ws.projectPath, check },
      );
      if (currentKey.current === key) setLog(result);
    } catch (reason) {
      if (currentKey.current === key) setLogError(String(reason));
    } finally {
      if (currentKey.current === key) setLogBusy(false);
    }
  };
  return (
    <li className="min-w-0 border-b border-content/8 py-2">
      <div className="flex items-center gap-2">
        {state === "failed" && selectable ? (
          <Checkbox
            label={`Select ${check.name}`}
            checked={selected}
            onChange={onSelect}
          />
        ) : (
          <appearance.icon className={`size-3.5 ${appearance.tone}`} />
        )}
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] focus-visible:outline-accent"
          aria-expanded={expanded}
          aria-label={`${check.name} details`}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRight
            className={`size-3 shrink-0 text-content/40 ${expanded ? "rotate-90" : ""}`}
          />
          <span className="min-w-0 truncate text-content/85">{check.name}</span>
        </button>
        <span className={`text-[10px] ${appearance.tone}`}>{state}</span>
        {state === "failed" && selectable && onFix && (
          <button className={rowAction} onClick={onFix}>
            Fix
          </button>
        )}
        {check.url && (
          <button
            aria-label={`Open ${check.name} on provider`}
            className={iconAction}
            onClick={() => void openUrl(check.url)}
          >
            <ExternalLink className="size-3" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="ml-5 mt-2 space-y-2 text-[11px] text-content/65">
          {loading && !details && (
            <LoaderCircle
              className="size-3.5 animate-spin text-content/50"
              role="status"
              aria-label="Loading details"
            />
          )}
          {error && <p role="alert">{error}</p>}
          {children}
          {!children && details && (
            <>
              <ol className="space-y-1">
                {orderedCheckNodes(details.nodes).map((node) => {
                  const seen = new Set([node.id]);
                  let parent = node.parentId,
                    depth = 0;
                  while (
                    parent &&
                    parents.has(parent) &&
                    !seen.has(parent) &&
                    depth < 8
                  ) {
                    seen.add(parent);
                    depth++;
                    parent = parents.get(parent)?.parentId;
                  }
                  const state = checkState({
                    name: node.name,
                    state: node.state,
                    bucket: node.state,
                    url: "",
                  });
                  const mark = CHECK_APPEARANCE[state];
                  return (
                    <li
                      key={node.id}
                      className="flex items-center gap-2 py-1"
                      style={{ paddingLeft: depth * 12 }}
                    >
                      <mark.icon
                        aria-hidden="true"
                        className={`size-3 shrink-0 ${mark.tone}`}
                      />
                      <span className="min-w-0 flex-1 break-words">
                        {node.name}
                      </span>
                      <span className="text-content/40">
                        {node.kind === "stage" && node.state === "unknown"
                          ? "Stage"
                          : state}
                      </span>
                      <span className="tabular-nums text-content/40">
                        {checkDuration(
                          node.startedAt || null,
                          node.completedAt || null,
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {!details.nodes.length && (
                <p>
                  No native steps reported. Open the check for full details.
                </p>
              )}
              {details.annotations.map((annotation, index) => (
                <p
                  key={index}
                  className="whitespace-pre-wrap break-words rounded bg-content/5 p-2"
                >
                  {annotation.path &&
                    `${annotation.path}:${annotation.line} · `}
                  {annotation.message}
                </p>
              ))}
              {details.notice && <p role="status">{details.notice}</p>}
            </>
          )}
          {(state === "failed" && check.jobId !== undefined) ||
          (state === "failed" && check.source.provider === "azuredevops") ? (
            <button
              className={action}
              disabled={logBusy}
              onClick={() => void loadLog()}
            >
              {logBusy && (
                <LoaderCircle className="size-3 animate-spin" strokeWidth={2} />
              )}
              Show log excerpt
            </button>
          ) : null}
          {logError && <p role="alert">{logError}</p>}
          {log && (
            <>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-content/5 p-2">
                {log.text}
              </pre>
              {log.truncated && (
                <p>Excerpt truncated · open provider for the full log.</p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Locally-buffered reply draft — commits on blur/unmount so typing doesn't
 * serialize the board store per keystroke. Stays open once expanded, so
 * clearing the text never collapses the editor mid-edit. */
function ReplyDraft({
  id,
  draft,
  url,
  onChange,
  onDiscard,
  onError,
}: {
  id: string;
  draft: string;
  url: string;
  onChange: (value: string) => void;
  onDiscard: () => void;
  onError: (reason: unknown) => void;
}) {
  const [value, setValue] = useState(draft);
  const [open, setOpen] = useState(!!draft);
  const latest = useRef({ value, draft, onChange });
  latest.current = { value, draft, onChange };
  // Imported/discarded drafts overwrite the local buffer wholesale.
  useEffect(() => {
    setValue(draft);
    if (draft) setOpen(true);
  }, [draft]);
  const commit = (text?: string) => {
    // latest.current beats the render closure when input and blur land in
    // the same batch.
    const { value: buffer, draft: saved, onChange: write } = latest.current;
    const next = text ?? buffer;
    if (next !== saved) write(next);
  };
  // Unmount can arrive before blur — never drop un-saved text.
  useEffect(
    () => () => {
      const { value, draft, onChange } = latest.current;
      if (value !== draft) onChange(value);
    },
    [],
  );
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="text-[11px] text-content/60"
    >
      <summary className="cursor-pointer">Reply draft · saved locally</summary>
      <textarea
        aria-label={`Reply draft for ${id}`}
        maxLength={32_768}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Escape blurs the field — without preventDefault the board's
          // global Escape would close the whole details panel mid-edit.
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
        className="mt-2 min-h-20 w-full resize-y rounded-md border border-content/10 bg-content/3 p-2 text-[12px] text-content outline-none focus-visible:ring-1 focus-visible:ring-accent"
      />
      <div className="flex gap-1">
        <button
          className={action}
          disabled={!value}
          onClick={() =>
            void navigator.clipboard.writeText(value).catch(onError)
          }
        >
          Copy reply
        </button>
        <button className={action} onClick={() => void openUrl(url)}>
          Open provider
        </button>
        <button
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-content/55 hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-accent disabled:opacity-40 dark:hover:text-red-400"
          disabled={!value && !draft}
          onClick={() => {
            setValue("");
            onDiscard();
          }}
        >
          Discard draft
        </button>
      </div>
    </details>
  );
}

export function TaskDeliveryPanel({
  task,
  ws,
  status,
  tab,
  sessions,
  onHandoff,
  onSend,
  onSpawn,
  onRefresh,
  onSources,
  onOpenSession,
}: {
  task: BoardTask;
  ws: TaskWorkstream;
  status?: WorkstreamStatus;
  tab: "pr" | "checks";
  sessions: Session[];
  onHandoff: (kind: HandoffKind, ids?: readonly string[]) => void;
  /** Inline reply drafting: send the request to a chosen session, or spawn a
   * lane-bound agent — same dispatch the handoff dialog uses. */
  onSend: SendToSession;
  onSpawn: (
    ws: TaskWorkstream,
  ) => Promise<{ sessionId: string; worktreePath: string }>;
  onRefresh?: () => void;
  onSources: () => void;
  onOpenSession: (id: string) => void;
}) {
  const snapshot = status?.delivery;
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [allComments, setAllComments] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [checkSelection, setCheckSelection] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Reply[]>();
  const importBaseline = useRef<Record<string, string>>({});
  const [importSelection, setImportSelection] = useState<Set<string>>(
    new Set(),
  );
  const [importBusy, setImportBusy] = useState(false);
  // Ref mirror — state lags a render; two clicks in one commit must not
  // both start an import.
  const importBusyRef = useRef(false);
  /** Thread ids the inline reply composer is targeting — set opens it. */
  const [composerThreads, setComposerThreads] = useState<string[]>();
  const scope = snapshot ? replyScope(snapshot) : "";
  const identity = snapshot ? snapshotIdentity(snapshot) : "";
  const toggle = (setter: typeof setSelection, id: string) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  useEffect(() => {
    let active = true;
    if (tab === "pr" && snapshot?.pr) {
      setLoading(true);
      setError("");
      void loadComments(ws, snapshot)
        .then((thread) => {
          if (active) {
            setComments(thread.comments as ReviewComment[]);
            setTruncated(thread.truncated);
          }
        })
        .catch((reason) => {
          if (active) setError(String(reason));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
    // Polling must not replace comments the user is reviewing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, identity, refresh]);
  const failures =
    snapshot?.checks.filter((check) => isFailedCheck(check, snapshot.checks)) ??
    [];
  const chosenChecks = failures.filter((check) => checkSelection.has(check.id));
  const chosen = comments.filter((comment) =>
    selection.has(comment.threadId || comment.id),
  );
  const unresolved = comments.filter(
    (comment) =>
      !comment.resolved && comment.body.trim() && comment.kind !== "review",
  );
  const request =
    task.replyRequest?.scope === scope ? task.replyRequest : undefined;
  const verifyImport = async () => {
    if (!request || !snapshot)
      throw new Error("Start a draft-reply request for this PR first.");
    const current = loadBoard().tasks.find((entry) => entry.id === task.id);
    const lane = current?.workstreams.find((entry) => entry.id === ws.id);
    if (
      !lane ||
      deliveryKey(lane) !== deliveryKey(ws) ||
      current?.replyRequest?.id !== request.id
    )
      throw new Error("Task or reply request changed. Reopen the PR tab.");
    const fresh = await probeDelivery(lane, { fresh: true });
    if (snapshotIdentity(fresh) !== request.identity)
      throw new Error(
        "Provider or revision changed. Review a new draft request.",
      );
    const thread = await loadComments(lane, fresh);
    const items = (thread.comments as ReviewComment[])
      .map(commentEvidence)
      .filter((item) =>
        request.threadIds.includes(item.id.replace(/^comment:/, "")),
      );
    if (evidenceFingerprint(items) !== request.fingerprint)
      throw new Error("Selected comments changed. Review a new draft request.");
    const latest = loadBoard().tasks.find(
      (entry) => entry.id === task.id && !entry.archived,
    );
    // `?? ws` would mask a removed lane — the stale prop always matches itself.
    const latestLane = latest?.workstreams.find((entry) => entry.id === ws.id);
    if (
      !latest ||
      latest.replyRequest?.id !== request.id ||
      !latestLane ||
      deliveryKey(latestLane) !== deliveryKey(lane)
    )
      throw new Error("Task or reply request changed. Reopen the PR tab.");
  };
  const importReplies = async (preparsed?: Reply[]) => {
    if (!request || preview || importBusy || importBusyRef.current) return;
    importBusyRef.current = true;
    setImportBusy(true);
    setError("");
    try {
      await verifyImport();
      let replies = preparsed;
      if (!replies) {
        const session =
          sessions.find((session) => session.id === request.sessionId) ??
          (await getSession(request.sessionId));
        const output = [...(session?.blocks ?? [])]
          .reverse()
          .find(
            (block) =>
              block.role === "assistant" &&
              !block.streaming &&
              block.text.includes(request.id),
          );
        if (!output)
          throw new Error(
            "No completed reply bundle yet. Open the draft session to review its output.",
          );
        replies = parseReplyBundle(output.text, request);
      }
      if (
        loadBoard().tasks.find((entry) => entry.id === task.id)?.replyRequest
          ?.id !== request.id
      )
        throw new Error("Reply request changed. Reopen the PR tab.");
      importBaseline.current = {
        ...loadBoard().tasks.find((entry) => entry.id === task.id)?.replyDrafts,
      };
      const existing = (reply: Reply) =>
        importBaseline.current[replyDraftKey(scope, reply.threadId)];
      // An empty draft is a tombstone — the user cleared or discarded it, so
      // auto-import leaves it alone. Manual Import still offers it in the
      // review modal (the deliberate restore path).
      const pending = replies.filter(
        (reply) =>
          existing(reply) !== reply.body && !(existing(reply) === "" && preparsed),
      );
      const conflicts = pending.filter((reply) => existing(reply) !== undefined);
      if (!conflicts.length) {
        // Nothing to overwrite — land the replies straight in the draft
        // editors; the preview step only exists to gate replacements. The
        // updater re-checks the request and skips keys that gained a draft
        // since the baseline snapshot.
        if (pending.length)
          updateTask(task.id, (current) => {
            if (current.replyRequest?.id !== request.id)
              throw new Error(
                "Task or reply request changed. Reopen the PR tab.",
              );
            return {
              replyDrafts: {
                ...current.replyDrafts,
                ...Object.fromEntries(
                  pending
                    .filter(
                      (reply) =>
                        current.replyDrafts?.[
                          replyDraftKey(scope, reply.threadId)
                        ] === undefined,
                    )
                    .map((reply) => [
                      replyDraftKey(scope, reply.threadId),
                      reply.body,
                    ]),
                ),
              },
            };
          });
        const skipped = replies.length - pending.length;
        setNotice(
          !pending.length
            ? "All reply drafts are already up to date."
            : skipped
              ? `Replies imported — ${skipped} already up to date${preparsed ? " or discarded" : ""}.`
              : "Replies imported — edit the drafts under each thread.",
        );
        return;
      }
      setPreview(pending);
      setImportSelection(
        new Set(
          pending
            .filter((reply) => !existing(reply))
            .map((reply) => reply.threadId),
        ),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      importBusyRef.current = false;
      setImportBusy(false);
    }
  };
  const saveImport = async () => {
    if (!preview || importBusy) return;
    setImportBusy(true);
    setError("");
    try {
      await verifyImport();
      updateTask(task.id, (current) => {
        if (
          current.replyRequest?.id !== request?.id ||
          preview.some(
            (reply) =>
              importSelection.has(reply.threadId) &&
              current.replyDrafts?.[replyDraftKey(scope, reply.threadId)] !==
                importBaseline.current[replyDraftKey(scope, reply.threadId)],
          )
        )
          throw new Error(
            "A reply draft changed after preview. Import again to review the latest drafts.",
          );
        return {
          replyDrafts: {
            ...current.replyDrafts,
            ...Object.fromEntries(
              preview
                .filter((reply) => importSelection.has(reply.threadId))
                .map((reply) => [
                  replyDraftKey(scope, reply.threadId),
                  reply.body,
                ]),
            ),
          },
        };
      });
      setPreview(undefined);
      setNotice("Replies imported — edit the drafts under each thread.");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setImportBusy(false);
    }
  };
  const runComments = (kind: HandoffKind, roots = chosen) =>
    onHandoff(
      kind,
      roots.map((comment) => commentEvidence(comment).id),
    );
  const draftSession = request
    ? sessions.find((session) => session.id === request.sessionId)
    : undefined;
  // When the drafting session finishes a valid bundle, import it on its
  // own — straight into the draft editors when nothing is overwritten, or
  // into the review modal when a reply would replace an existing draft.
  // Only output that parses against this request triggers either; other
  // chatter in a reused session leaves the manual Import button as the path.
  const seenBundle = useRef("");
  useEffect(() => {
    if (!request || preview || importBusy) return;
    const session = sessions.find((entry) => entry.id === request.sessionId);
    if (!session || session.busy) return;
    // Latest completed block naming this request — scan backward without
    // copying; this runs on every sessions-list update while drafting.
    let output;
    for (let index = session.blocks.length - 1; index >= 0; index--) {
      const block = session.blocks[index];
      if (
        block.role === "assistant" &&
        !block.streaming &&
        block.text.includes(request.id)
      ) {
        output = block;
        break;
      }
    }
    if (!output || seenBundle.current === output.text) return;
    // Mark before parsing — a non-bundle would otherwise re-parse on every
    // sessions update.
    seenBundle.current = output.text;
    try {
      void importReplies(parseReplyBundle(output.text, request));
    } catch {
      // Not a reply bundle — the user chatted in this session instead.
    }
    // importReplies is captured fresh each render; the guards above make a
    // re-run harmless (the seen-check dedupes on the exact output text).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, sessions, preview, importBusy]);
  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex items-center gap-2 text-[11px] text-content/50">
        <span className="min-w-0 flex-1 break-words">
          {snapshot ? (
            `${PROVIDER_NAMES[tab === "checks" ? (snapshot.ciSource?.provider ?? snapshot.source.provider) : snapshot.source.provider]} · ${tab === "checks" ? (snapshot.ciSource?.repo ?? snapshot.source.repo) : snapshot.source.repo} · ${snapshot.headSha.slice(0, 8)}`
          ) : (
            <LoaderCircle
              className="size-3 animate-spin"
              role="status"
              aria-label="Loading repository status"
            />
          )}
        </span>
        <button
          className={iconAction}
          onClick={() => {
            setRefresh((value) => value + 1);
            onRefresh?.();
          }}
          aria-label="Refresh delivery evidence"
        >
          <RefreshCw className="size-3" />
        </button>
        <button className={action} onClick={onSources}>
          Sources
        </button>
      </div>
      {!!status?.fetchedAt && Date.now() - status.fetchedAt > 60_000 && (
        <p role="status" className="text-amber-700 dark:text-amber-300">
          Status is stale. Refresh before reviewing; sending always revalidates
          evidence.
        </p>
      )}
      {status?.error && (
        <p role="alert" className="text-amber-700 dark:text-amber-300">
          {status.error}
        </p>
      )}
      {error && (
        <p role="alert" className="text-amber-700 dark:text-amber-300">
          {error}
        </p>
      )}
      {notice && !error && (
        <p role="status" className="text-content/55">
          {notice}
        </p>
      )}
      {tab === "checks" ? (
        <>
          {status?.ciError && (
            <p role="alert">
              Partial or unavailable CI evidence: {status.ciError}
            </p>
          )}
          {failures.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {chosenChecks.length > 0 && (
                <button
                  className={accentAction}
                  disabled={!!status?.ciError}
                  onClick={() =>
                    onHandoff(
                      "ci",
                      chosenChecks.map((check) => check.id),
                    )
                  }
                >
                  Fix selected ({chosenChecks.length})
                </button>
              )}
              <button
                className={accentAction}
                disabled={!!status?.ciError}
                onClick={() =>
                  onHandoff(
                    "ci",
                    failures.map((check) => check.id),
                  )
                }
              >
                Fix all failures ({failures.length})
              </button>
            </div>
          )}
          <ul>
            {groupedDeliveryChecks(snapshot?.checks ?? []).map((group) => {
              const rows = group.checks.map((check) => (
                <CheckRow
                  key={check.id}
                  ws={ws}
                  check={check}
                  refresh={status?.fetchedAt}
                  selected={checkSelection.has(check.id)}
                  onSelect={() => toggle(setCheckSelection, check.id)}
                  onFix={() => onHandoff("ci", [check.id])}
                />
              ));
              return group.parent ? (
                <CheckRow
                  key={group.id}
                  ws={ws}
                  check={group.parent}
                  refresh={status?.fetchedAt}
                  selected={false}
                  onSelect={() => {}}
                  selectable={!group.checks.length}
                  onFix={
                    !group.checks.length
                      ? () => onHandoff("ci", [group.parent!.id])
                      : undefined
                  }
                >
                  {group.checks.length ? <ul>{rows}</ul> : undefined}
                </CheckRow>
              ) : group.name ? (
                <li key={group.id}>
                  <p className="pt-3 text-[11px] text-content/45">
                    {group.name}
                  </p>
                  <ul>{rows}</ul>
                </li>
              ) : (
                <li key={group.id}>
                  <ul>{rows}</ul>
                </li>
              );
            })}
          </ul>
          {snapshot && !snapshot.checks.length && !status?.ciError && (
            <p className="text-content/50">No CI runs for this revision.</p>
          )}
        </>
      ) : (
        <>
          {snapshot?.pr ? (
            <button
              className="flex w-full items-start gap-2 text-left text-content/85"
              onClick={() => void openUrl(snapshot.pr!.url)}
            >
              <span className="min-w-0 flex-1">
                #{snapshot.pr.number} · {snapshot.pr.title}
                <span className="block text-[11px] text-content/50">
                  {snapshot.pr.state} ·{" "}
                  {snapshot.pr.reviewDecision?.toLowerCase().replace(/_/g, " ")}
                </span>
              </span>
              <ExternalLink className="mt-1 size-3 shrink-0" />
            </button>
          ) : (
            <p className="text-content/50">No pull request for this branch.</p>
          )}
          {snapshot?.pr && (
            <>
              <div className="flex flex-wrap gap-1">
                <button
                  className={action}
                  onClick={() => setAllComments((value) => !value)}
                >
                  {allComments ? "Show unresolved" : "Show all discussion"}
                </button>
                {chosen.length > 0 && (
                  <button
                    className={accentAction}
                    disabled={loading}
                    onClick={() => runComments("comments")}
                  >
                    Address selected ({chosen.length})
                  </button>
                )}
                {unresolved.length > 0 && (
                  <button
                    className={accentAction}
                    disabled={loading}
                    onClick={() => runComments("comments", unresolved)}
                  >
                    {truncated
                      ? "Address all loaded"
                      : "Address all unresolved"}{" "}
                    ({unresolved.length})
                  </button>
                )}
                {chosen.length > 0 && (
                  <button
                    className={accentAction}
                    disabled={loading}
                    onClick={() =>
                      setComposerThreads(
                        chosen.map((comment) => comment.threadId || comment.id),
                      )
                    }
                  >
                    Draft selected replies
                  </button>
                )}
              </div>
              {composerThreads && (
                <ReplyComposer
                  task={task}
                  ws={ws}
                  snapshot={snapshot}
                  comments={comments}
                  threadIds={composerThreads}
                  sessions={sessions}
                  onSpawn={onSpawn}
                  onSend={onSend}
                  onDone={() => setComposerThreads(undefined)}
                />
              )}
              {request && (
                <div className="space-y-1.5">
                  {draftSession?.busy && (
                    <p
                      role="status"
                      className="flex items-center gap-1.5 text-[11px] text-content/55"
                    >
                      <LoaderCircle className="size-3 animate-spin" />
                      {draftSession.title} is drafting replies…
                    </p>
                  )}
                  <div className="flex gap-1">
                    <button
                      className={action}
                      onClick={() => onOpenSession(request.sessionId)}
                    >
                      Open draft session
                    </button>
                    <button
                      className={accentAction}
                      disabled={importBusy}
                      onClick={() => void importReplies()}
                    >
                      {importBusy && (
                        <LoaderCircle
                          className="size-3 animate-spin"
                          strokeWidth={2}
                        />
                      )}
                      Import replies from session
                    </button>
                  </div>
                </div>
              )}
              {loading && (
                <p
                  role="status"
                  aria-label="Loading comments"
                  className="flex justify-center py-2 text-content/50"
                >
                  <LoaderCircle className="size-4 animate-spin" />
                </p>
              )}
              {truncated && (
                <p role="status" className="text-content/50">
                  Only loaded comments are shown. Open the PR for the complete
                  discussion.
                </p>
              )}
              {(allComments ? comments : unresolved).map((comment) => {
                const id = comment.threadId || comment.id,
                  key = replyDraftKey(scope, id),
                  draft = task.replyDrafts?.[key] ?? "";
                return (
                  <div
                    key={id}
                    className="space-y-2 border-t border-content/8 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-1">
                      <Checkbox
                        label={`Select thread by ${comment.author}`}
                        checked={selection.has(id)}
                        onChange={() => toggle(setSelection, id)}
                      />
                      <button
                        className={rowAction}
                        onClick={() => runComments("comments", [comment])}
                      >
                        Address this
                      </button>
                      <button
                        className={rowAction}
                        onClick={() => setComposerThreads([id])}
                      >
                        Draft reply
                      </button>
                    </div>
                    <div className="[&_header]:text-content/70">
                      <InboxComments
                        showHeader={false}
                        thread={{ comments: [comment], truncated: false }}
                        loading={false}
                        error={null}
                        cwd={ws.worktreePath || ws.projectPath}
                        provider={snapshot.source.provider}
                      />
                    </div>
                    <ReplyDraft
                      id={id}
                      draft={draft}
                      url={comment.url || snapshot.pr!.url}
                      onChange={(value) =>
                        updateTask(task.id, (current) => ({
                          replyDrafts: {
                            ...current.replyDrafts,
                            [key]: value,
                          },
                        }))
                      }
                      onDiscard={() =>
                        // "" is a tombstone — auto-import treats it as
                        // declined, so a discarded draft can't silently come
                        // back on the next completed bundle.
                        updateTask(task.id, (current) => ({
                          replyDrafts: {
                            ...current.replyDrafts,
                            [key]: "",
                          },
                        }))
                      }
                      onError={(reason) => setError(String(reason))}
                    />
                  </div>
                );
              })}
              {!loading && !comments.length && !error && (
                <p className="text-content/50">No comments yet.</p>
              )}
            </>
          )}
        </>
      )}
      {preview && (
        <Modal
          title="Review reply drafts"
          fitViewport
          onClose={() => {
            if (!importBusy) setPreview(undefined);
          }}
          footer={
            <div className="flex justify-end gap-2 p-3">
              <button
                className={action}
                disabled={importBusy}
                onClick={() => setPreview(undefined)}
              >
                Cancel
              </button>
              <button
                className={accentAction}
                disabled={importBusy || !importSelection.size}
                onClick={() => void saveImport()}
              >
                Import selected drafts
              </button>
            </div>
          }
        >
          <div className="space-y-3 p-4">
            {preview.map((reply) => (
              <div key={reply.threadId}>
                <Checkbox
                  label={
                    task.replyDrafts?.[replyDraftKey(scope, reply.threadId)]
                      ? `Replace existing draft · ${reply.threadId}`
                      : `Import · ${reply.threadId}`
                  }
                  checked={importSelection.has(reply.threadId)}
                  onChange={() => toggle(setImportSelection, reply.threadId)}
                  disabled={importBusy}
                />
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[12px] text-content/75">
                  {reply.body}
                </pre>
              </div>
            ))}
            {error && <p role="alert">{error}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Inline reply drafting for the PR tab: pick a lane-bound session or spawn
 * the configured default, keep instructions editable, then dispatch through
 * `sendHandoff` — the same send-time validation the handoff dialog runs. The
 * answer lands back in this panel via `replyRequest`; the user never leaves
 * task details. */
function ReplyComposer({
  task,
  ws,
  snapshot,
  comments,
  threadIds,
  sessions,
  onSpawn,
  onSend,
  onDone,
}: {
  task: BoardTask;
  ws: TaskWorkstream;
  snapshot: DeliverySnapshot;
  comments: ReviewComment[];
  threadIds: readonly string[];
  sessions: Session[];
  onSpawn: (
    ws: TaskWorkstream,
  ) => Promise<{ sessionId: string; worktreePath: string }>;
  onSend: SendToSession;
  onDone: () => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [target, setTarget] = useState<DeliveryTarget>();
  const [candidates, setCandidates] = useState<Session[]>([]);
  const [recipient, setRecipient] = useState("");
  const [instructions, setInstructions] = useState(
    "Draft clear replies for the selected PR threads without changing code.",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Ref mirror — a same-tick second click would still see busy=false.
  const busyRef = useRef(false);
  // A session spawned by this composer is reused on retry — otherwise a
  // spawn-then-fail would stack a fresh agent per attempt.
  const spawnedRef = useRef<{ lane: string; id: string } | undefined>(undefined);
  const loadedKey = useRef("");
  const liveSessions = useRef(sessions);
  liveSessions.current = sessions;
  const items = useMemo(
    () =>
      comments
        .filter((comment) =>
          threadIds.includes(comment.threadId || comment.id),
        )
        .map(commentEvidence)
        .map((item) => ({ ...item, selected: true })),
    [comments, threadIds],
  );
  // replyRequest is one slot per task — warn when sending would displace a
  // request that's still running or hasn't been imported yet.
  const inFlight =
    task.replyRequest && task.replyRequest.scope === replyScope(snapshot)
      ? sessions.find(
          (session) => session.id === task.replyRequest!.sessionId,
        )
      : undefined;
  useEffect(() => {
    let on = true;
    void (async () => {
      if (!ws.worktreePath)
        throw new Error(
          "Choose a working copy in Manage worktree before drafting replies.",
        );
      const trees = await listWorktrees(ws.projectPath);
      const tree = trees.worktrees.find(
        (t) => pathKey(t.path) === pathKey(ws.worktreePath!),
      );
      if (!tree || tree.missing || tree.branch !== ws.branch)
        throw new Error(
          "Working copy is missing or its branch changed. Update it in Manage worktree.",
        );
      const dest = { cwd: tree.path, branch: ws.branch, head: tree.head };
      const stored = await Promise.all(
        (ws.sessionIds ?? []).map(
          (id) =>
            liveSessions.current.find((s) => s.id === id) ?? getSession(id),
        ),
      );
      if (!on) return;
      loadedKey.current = deliveryKey(ws);
      setTarget(dest);
      setCandidates(
        stored.filter(
          (s): s is Session =>
            !!s &&
            matchesTarget(s, dest) &&
            !s.inboxAsk &&
            !s.orchestrationLeadId,
        ),
      );
      setRecipient("new");
    })().catch((reason) => {
      if (on) setError(String(reason));
    });
    return () => {
      on = false;
    };
    // Mount-time load only — the send itself revalidates lane and evidence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const send = async () => {
    if (busyRef.current || !target || !recipient || !items.length) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await sendHandoff({
        taskId: task.id,
        kind: "draft-replies",
        workstream: ws,
        loadedKey: loadedKey.current,
        snapshot,
        target,
        items,
        instructions,
        recipient,
        requestId,
        reuseSession: spawnedRef.current,
        onSpawned: (spawned) => {
          spawnedRef.current = spawned;
        },
        evidenceNow: async (current, fresh) =>
          (
            (await loadComments(current, fresh)).comments as ReviewComment[]
          ).map(commentEvidence),
        onSpawn,
        onSend,
      });
      onDone();
    } catch (reason) {
      setError(String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div
      className="space-y-2 rounded-md border border-accent/15 bg-accent/[0.04] p-2.5"
      aria-label="Draft replies with an agent"
      onKeyDown={(event) => {
        // Escape dismisses this card only — preventDefault keeps the board's
        // global Escape from closing the whole details panel.
        if (event.key === "Escape" && !busyRef.current) {
          event.preventDefault();
          onDone();
        }
      }}
    >
      <div className="flex items-center gap-2 text-[11px] text-content/55">
        <span className="min-w-0 flex-1">
          {items.length === 1
            ? "Agent drafts a reply — nothing is posted or resolved."
            : `Agent drafts replies for ${items.length} threads — nothing is posted or resolved.`}
        </span>
        <button
          className={iconAction}
          aria-label="Close reply drafting"
          disabled={busy}
          onClick={onDone}
        >
          <X className="size-3" />
        </button>
      </div>
      {inFlight && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
          {inFlight.busy
            ? `${inFlight.title} is still drafting replies — sending replaces that request.`
            : `A previous draft request from ${inFlight.title} hasn't been imported — sending replaces it.`}
        </p>
      )}
      <SearchableSelect
        label="Drafting agent"
        variant="transparent"
        value={recipient}
        disabled={busy || !target}
        onChange={setRecipient}
        placeholder={
          target
            ? "Choose a session…"
            : error
              ? "Working copy unavailable"
              : "Checking working copy…"
        }
        options={[
          ...candidates.map((s) => ({
            value: s.id,
            label: `${s.title} · ${s.harness}${s.busy ? " · running (native queue/steering)" : ""}`,
          })),
          { value: "new", label: "New agent · configured default" },
        ]}
      />
      <textarea
        aria-label="Reply instructions"
        className="min-h-16 w-full resize-y rounded-md border border-stroke bg-background-base px-2 py-1.5 text-[12px] text-content outline-none focus-visible:ring-1 focus-visible:ring-accent"
        disabled={busy}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      {error && (
        <p role="alert" className="break-words text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <button className={action} disabled={busy} onClick={onDone}>
          Cancel
        </button>
        <button
          className={accentAction}
          disabled={
            busy ||
            !target ||
            !recipient ||
            !instructions.trim() ||
            !items.length
          }
          onClick={() => void send()}
        >
          {busy && <LoaderCircle className="size-3 animate-spin" />}
          {busy ? "Sending…" : "Draft replies"}
        </button>
      </div>
    </div>
  );
}
