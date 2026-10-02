import {
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from "../../shared/ui/icons";
import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Checkbox } from "../../shared/ui/Checkbox";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import { SecondaryButton } from "../../shared/ui/SecondaryButton";
import { Modal } from "../../shared/ui/Modal";
import { getSession } from "../sessions/data/sessionStore";
import { type Session } from "../sessions/model/session";
import { listWorktrees } from "../source-control/model/worktrees";
import { pathKey, prettyCwd, projectName } from "../../shared/lib/paths";
import { type TaskWorkstream } from "./boardStore";
import {
  checkEvidence,
  commentEvidence,
  deliveryKey,
  isFailedCheck,
  loadComments,
  matchesTarget,
  probeDelivery,
  type DeliverySnapshot,
  type DeliveryTarget,
  type Evidence,
  type ReviewComment,
  type SendToSession,
} from "./delivery";
import { sendHandoff, type HandoffKind } from "./handoff";
const inputClass =
  "w-full rounded-md border border-stroke bg-background-base px-2 py-1.5 text-[12px] text-content outline-none focus-visible:ring-1 focus-visible:ring-accent";
export function AgentHandoffDialog({
  workstreams,
  taskId,
  kind,
  sessions,
  onSpawn,
  onSend,
  onClose,
  evidenceIds,
}: {
  workstreams: TaskWorkstream[];
  taskId?: string;
  evidenceIds?: readonly string[];
  kind: HandoffKind;
  sessions: Session[];
  onSpawn: (
    ws: TaskWorkstream,
  ) => Promise<{ sessionId: string; worktreePath: string }>;
  onSend: SendToSession;
  onClose: () => void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [laneId, setLaneId] = useState(
    workstreams.length === 1 ? workstreams[0].id : "",
  );
  const ws = workstreams.find((w) => w.id === laneId);
  const [snapshot, setSnapshot] = useState<DeliverySnapshot>();
  const [target, setTarget] = useState<DeliveryTarget>();
  const [items, setItems] = useState<Evidence[]>([]);
  const [candidates, setCandidates] = useState<Session[]>([]);
  const [recipient, setRecipient] = useState("");
  const [instructions, setInstructions] = useState(
    kind === "ci"
      ? "Investigate and fix the selected CI failures, then verify the changes."
      : "Review the selected PR comments against the current code, address valid findings, and verify the changes.",
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const sendingRef = useRef(false);
  const loadedKey = useRef("");
  const createdSession = useRef<{ lane: string; id: string } | undefined>(
    undefined,
  );
  const generation = useRef(0);
  const liveSessions = useRef(sessions);
  liveSessions.current = sessions;

  async function evidence(
    current: TaskWorkstream,
    value: DeliverySnapshot,
    logs: boolean,
    epoch = generation.current,
  ) {
    if (kind === "ci") {
      if (value.ciError) throw new Error(value.ciError);
      const failed = value.checks.filter(
        (c) =>
          isFailedCheck(c, value.checks) &&
          (!evidenceIds || evidenceIds.includes(c.id)),
      );
      const result: Evidence[] = [];
      // ponytail: four 32 KiB log excerpts per review; remaining failures keep direct links.
      let excerpts = 0;
      for (const check of failed) {
        if (epoch !== generation.current) break;
        const includeLog = logs && excerpts < 4;
        if (includeLog) excerpts++;
        result.push(
          includeLog
            ? await checkEvidence(current, check)
            : {
                id: check.id,
                title: `${check.name} · failed`,
                body: `${check.name}: ${check.state}\nRevision: ${check.sha}`,
                url: check.url,
                selected: true,
                unavailable: logs
                  ? "Additional logs are available through the source link."
                  : undefined,
              },
        );
      }
      return { items: result, truncated: false };
    }
    const thread = await loadComments(current, value);
    return {
      items: (thread.comments as ReviewComment[]).map(commentEvidence).map(item => ({ ...item, selected: evidenceIds ? evidenceIds.includes(item.id) : item.selected })),
      truncated: thread.truncated,
    };
  }
  useEffect(() => {
    const epoch = ++generation.current;
    setSnapshot(undefined);
    setTarget(undefined);
    setItems([]);
    setError("");
    setNotice("");
    setRecipient("");
    setCandidates([]);
    if (!ws) return;
    setLoading(true);
    void (async () => {
      if (!ws.worktreePath)
        throw new Error(
          "Choose a working copy in Manage worktree before handing off.",
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
      const value = await probeDelivery(ws);
      if (epoch !== generation.current) return;
      const content = await evidence(ws, value, true, epoch);
      if (epoch !== generation.current) return;
      const ids = ws.sessionIds ?? [];
      const stored = await Promise.all(
        ids.map(
          (id) =>
            liveSessions.current.find((s) => s.id === id) ?? getSession(id),
        ),
      );
      const matching = stored.filter(
        (s): s is Session =>
          !!s &&
          matchesTarget(s, dest) &&
          !s.inboxAsk &&
          !s.orchestrationLeadId,
      );
      if (epoch !== generation.current) return;
      loadedKey.current = deliveryKey(ws);
      setSnapshot(value);
      setTarget(dest);
      setItems(content.items);
      setCandidates(matching);
      setRecipient("new");
      setNotice(
        content.truncated
          ? "Only the fetched comments are shown; more are available on the provider."
          : "",
      );
    })()
      .catch((e) => {
        if (epoch === generation.current) setError(String(e));
      })
      .finally(() => {
        if (epoch === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
    // Refresh is deliberate; incoming board polling must not replace reviewed evidence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId, refresh]);

  const send = async () => {
    if (
      sendingRef.current ||
      !ws ||
      !snapshot ||
      !target ||
      !recipient ||
      !items.some((i) => i.selected)
    )
      return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      await sendHandoff({
        taskId,
        kind,
        workstream: ws,
        loadedKey: loadedKey.current,
        snapshot,
        target,
        items,
        instructions,
        recipient,
        requestId,
        reuseSession: createdSession.current,
        onSpawned: (spawned) => {
          createdSession.current = spawned;
        },
        evidenceNow: async (current, fresh) =>
          (await evidence(current, fresh, false)).items,
        onSpawn,
        onSend,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  return (
    <Modal
      title={kind === "ci" ? "Fix CI with an agent" : "Address PR comments"}
      onClose={() => {
        if (!sending) onClose();
      }}
    >
      <div className="flex flex-col gap-3 p-4 text-[12px]">
        {workstreams.length > 1 && (
          <label>
            Repository
            <SearchableSelect
              label="Repository for handoff"
              variant="transparent"
              value={laneId}
              disabled={sending}
              onChange={setLaneId}
              placeholder="Choose a repository…"
              options={workstreams.map((w) => ({
                value: w.id,
                label: `${projectName(w.projectPath)} · ${w.branch}`,
              }))}
            />
          </label>
        )}
        {ws && (
          <div className="rounded-md bg-content/5 p-2 text-content/65">
            <div>
              {projectName(ws.projectPath)} · {ws.branch}
            </div>
            <div className="break-all text-[11px]">
              {prettyCwd(ws.worktreePath || ws.projectPath)}
            </div>
            <div className="mt-1 text-[10px]">
              {snapshot?.source.host} · {snapshot?.headSha.slice(0, 8)}
            </div>
          </div>
        )}
        {loading ? (
          <p
            role="status"
            aria-label="Loading current evidence"
            className="flex justify-center py-6 text-content/50"
          >
            <LoaderCircle className="size-4 animate-spin" />
          </p>
        ) : (
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {!!items.length && <div className="flex gap-3 text-[11px] text-content/60">
              <button type="button" disabled={sending} onClick={() => setItems(current => current.map(item => ({ ...item, selected: true })))}>Select all loaded</button>
              <button type="button" disabled={sending} onClick={() => setItems(current => current.map(item => ({ ...item, selected: false })))}>Clear selection</button>
            </div>}
            {items.map((item, index) => (
              <div
                key={item.id}
                className="rounded-md border border-stroke p-2"
              >
                <label className="flex items-start gap-2 font-medium">
                  <Checkbox
                    label={item.title}
                    disabled={sending}
                    checked={item.selected}
                    onChange={() =>
                      setItems((current) =>
                        current.map((v, i) =>
                          i === index ? { ...v, selected: !v.selected } : v,
                        ),
                      )
                    }
                  />
                  <span>{item.title}</span>
                </label>
                <details className="group ml-6 mt-1">
                  <summary className="flex cursor-pointer list-none items-center gap-1 rounded text-[11px] text-content/50 hover:text-content/80 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                      className="size-3 transition-transform group-open:rotate-90"
                      aria-hidden="true"
                    />
                    Show evidence
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] text-content/70">
                    {item.body}
                  </pre>
                </details>
                {item.unavailable && (
                  <p className="mt-1 text-amber-700 dark:text-amber-300">
                    {item.unavailable}
                  </p>
                )}
                {item.truncated && (
                  <p className="text-content/50">Excerpt truncated</p>
                )}
                {item.url && (
                  <button
                    className="ml-6 mt-1 inline-flex items-center gap-1 rounded text-[11px] text-content/50 hover:text-content focus-visible:outline-accent"
                    onClick={() => void openUrl(item.url)}
                  >
                    Open source{" "}
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
            {snapshot && !items.length && (
              <p>
                No {kind === "ci" ? "failing checks" : "comments"} available.
              </p>
            )}
          </div>
        )}
        {notice && <p className="text-content/55">{notice}</p>}
        <label>
          Agent
          <SearchableSelect
            label="Agent destination"
            variant="transparent"
            value={recipient}
            disabled={loading || sending || !target}
            onChange={setRecipient}
            placeholder="Choose a session…"
            options={[
              ...candidates.map((s) => ({
                value: s.id,
                label: `${s.title} · ${s.harness}${s.busy ? " · running (native queue/steering)" : ""}`,
              })),
              { value: "new", label: "New agent · configured default" },
            ]}
          />
        </label>
        <label>
          Instructions
          <textarea
            aria-label="Handoff instructions"
            className={`${inputClass} min-h-20 resize-y`}
            disabled={sending}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
        {error && (
          <p
            role="alert"
            className="break-words text-red-700 dark:text-red-400"
          >
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            disabled={sending || loading || !ws}
            className="mr-auto inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-content/60 hover:bg-content/8 focus-visible:outline-accent disabled:opacity-40"
            onClick={() => setRefresh((n) => n + 1)}
          >
            <RefreshCw className="size-3" aria-hidden="true" /> Refresh evidence
          </button>
          <SecondaryButton disabled={sending} onClick={onClose}>
            Cancel
          </SecondaryButton>
          <button
            disabled={
              sending ||
              loading ||
              !target ||
              !recipient ||
              !instructions.trim() ||
              !items.some((i) => i.selected)
            }
            className="rounded-md bg-accent/15 px-3 py-1.5 font-medium text-accent hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
            onClick={() => void send()}
          >
            {sending ? "Sending…" : "Send to agent"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
