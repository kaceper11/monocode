import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { Toggle } from "./Toggle";
import { loadAgentActions } from "../lib/agentActions";
import { displayPath } from "../lib/paths";
import {
  HARNESS_TITLE,
  sessionDisplayTitle,
  sessionWorkCwd,
  HARNESSES,
  type HarnessId,
  type Session,
} from "../lib/session";
import {
  sameDeliverySource,
  saveWatcher,
  watcherSourceLabel,
  WATCHER_COOLDOWN_DEFAULT,
  WATCHER_INTERVAL_DEFAULT,
  type WatcherMode,
  type WatcherSource,
  type WatchSheetRequest,
} from "../lib/watchers";
import { pollWatcherNow } from "../lib/watcherEngine";

const inputClass =
  "w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none ring-accent/40 focus:ring-1";
const labelClass =
  "mb-1 block text-[11px] font-medium uppercase tracking-wide text-content/45";

const INTERVAL_OPTIONS = [60, 120, 300, 600, 900, 1800, 3600].map((sec) => ({
  value: String(sec),
  label: sec < 3600 ? `Every ${sec / 60} min` : "Every hour",
}));

const COOLDOWN_OPTIONS = [300, 900, 1800, 3600, 14400, 86400].map((sec) => ({
  value: String(sec),
  label:
    sec < 3600
      ? `${sec / 60} min between runs`
      : `${sec / 3600} h between runs`,
}));

/**
 * Create/edit a watcher (#23). The source is bound by the place the sheet was
 * opened from — it is shown read-only here; mode, action, target, and cadence
 * are the editable policy.
 */
export function WatchSheet({
  request,
  sessions,
  defaultCwd,
  onClose,
}: {
  request: WatchSheetRequest;
  sessions: Session[];
  defaultCwd: string;
  onClose: () => void;
}) {
  const existing = request.existing;
  const [name, setName] = useState(existing?.name ?? request.name);
  const [mode, setMode] = useState<WatcherMode>(existing?.mode ?? "notify");
  const [actionId, setActionId] = useState(existing?.actionId ?? "");
  const [intervalSec, setIntervalSec] = useState(
    String(existing?.intervalSec ?? WATCHER_INTERVAL_DEFAULT),
  );
  const [cooldownSec, setCooldownSec] = useState(
    String(existing?.cooldownSec ?? WATCHER_COOLDOWN_DEFAULT),
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  // github-items sources can arrive unbound when the query spans repos — the
  // user pins the repository here before the watcher can be saved.
  const [repoPick, setRepoPick] = useState(() =>
    Math.max(
      0,
      request.repos?.findIndex(
        (option) =>
          request.source.kind === "github-items" &&
          option.repo === request.source.repo,
      ) ?? 0,
    ),
  );
  const [itemKind, setItemKind] = useState<"issue" | "pr">(
    request.source.kind === "github-items" ? request.source.itemKind : "issue",
  );
  const sourceCwd =
    "cwd" in request.source ? request.source.cwd : undefined;
  const [targetCwd, setTargetCwd] = useState(
    existing?.target?.cwd ?? sourceCwd ?? defaultCwd,
  );
  const [targetHarness, setTargetHarness] = useState<HarnessId>(
    existing?.target?.harness ?? "claude",
  );
  const [targetModel, setTargetModel] = useState(existing?.target?.model ?? "");
  const [targetSessionId, setTargetSessionId] = useState(
    existing?.target?.sessionId ?? "",
  );
  const [error, setError] = useState("");

  const actions = useMemo(() => loadAgentActions(), []);
  const sessionOptions = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            !session.inboxAsk && sessionWorkCwd(session) === targetCwd,
        )
        .map((session) => ({
          value: session.id,
          label: sessionDisplayTitle(session.title, session.harness),
        })),
    [sessions, targetCwd],
  );

  const source: WatcherSource = useMemo(() => {
    const base = request.source;
    if (base.kind === "github-items") {
      const next = { ...base, itemKind };
      const picked = request.repos?.[repoPick];
      if (picked) return { ...next, cwd: picked.cwd, repo: picked.repo };
      return next;
    }
    return base;
  }, [request.source, request.repos, repoPick, itemKind]);

  const save = () => {
    // The sheet can't re-point a delivery source — when this edits the
    // watcher already covering the delivery, keep ITS source (owner and
    // watermark intact) and its managed `auto` status; only policy changes.
    const keepDelivery =
      existing && sameDeliverySource(source, existing.source);
    const result = saveWatcher(
      {
        name,
        source: keepDelivery ? existing.source : source,
        enabled,
        mode,
        ...(keepDelivery && existing.auto ? { auto: true } : {}),
        ...(actionId ? { actionId } : {}),
        ...(mode === "run"
          ? {
              target: {
                cwd: targetCwd,
                harness: targetHarness,
                model: targetModel,
                ...(targetSessionId ? { sessionId: targetSessionId } : {}),
              },
            }
          : {}),
        intervalSec: Number(intervalSec),
        cooldownSec: Number(cooldownSec),
      },
      existing?.id,
    );
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.watcher && enabled) pollWatcherNow(result.watcher.id);
    onClose();
  };

  const runNeedsTarget = mode === "run";

  return (
    <Modal
      onClose={onClose}
      title={existing ? "Edit watcher" : "New watcher"}
      description="Polls only while MonoCode is open."
      size="md"
    >
      <div className="space-y-4 p-4">
        <div>
          <label className={labelClass} htmlFor="watch-name">
            Name
          </label>
          <input
            id="watch-name"
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={160}
          />
        </div>

        <div>
          <span className={labelClass}>Source</span>
          <p className="text-[13px] text-content/70">
            {watcherSourceLabel(source)}
          </p>
          {request.source.kind === "github-items" &&
          request.repos &&
          request.repos.length > 1 ? (
            <div className="mt-2">
              <Select
                label="Repository"
                value={String(repoPick)}
                options={request.repos.map((option, index) => ({
                  value: String(index),
                  label: `${option.repo} · ${displayPath(option.cwd)}`,
                }))}
                onChange={(value) => setRepoPick(Number(value))}
              />
            </div>
          ) : null}
          {request.source.kind === "github-items" ? (
            <div className="mt-2">
              <Select
                label="Item kind"
                value={itemKind}
                options={[
                  { value: "issue", label: "Issues" },
                  { value: "pr", label: "Pull requests" },
                ]}
                onChange={(value) => setItemKind(value as "issue" | "pr")}
              />
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={labelClass}>When something changes</span>
            <Select
              label="Mode"
              value={mode}
              options={[
                { value: "notify", label: "Notify in the queue" },
                { value: "draft", label: "Prepare a draft" },
                { value: "run", label: "Run an action" },
              ]}
              onChange={(value) => setMode(value as WatcherMode)}
            />
          </div>
          <div>
            <span className={labelClass}>Check</span>
            <Select
              label="Poll interval"
              value={intervalSec}
              options={INTERVAL_OPTIONS}
              onChange={setIntervalSec}
            />
          </div>
        </div>

        {mode !== "notify" ? (
          <div>
            <span className={labelClass}>Action</span>
            <Select
              label="Saved action"
              value={actionId}
              options={[
                { value: "", label: "Choose an action…" },
                ...actions.map((action) => ({
                  value: action.id,
                  label: action.name,
                })),
              ]}
              onChange={setActionId}
            />
            <p className="mt-1 text-[11px] text-content/45">
              {mode === "draft"
                ? "The action's instructions prefill a draft you confirm before it runs."
                : "The action runs automatically, subject to the cooldown."}
            </p>
          </div>
        ) : null}

        {runNeedsTarget ? (
          <div className="space-y-3 rounded-lg border border-content/10 p-3">
            <div>
              <label className={labelClass} htmlFor="watch-target-cwd">
                Checkout
              </label>
              <input
                id="watch-target-cwd"
                className={inputClass}
                value={targetCwd}
                onChange={(event) => {
                  setTargetCwd(event.target.value);
                  // A session bound to the old checkout must not follow the
                  // target to a different repository.
                  setTargetSessionId("");
                }}
                placeholder="/path/to/checkout"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className={labelClass}>Agent</span>
                <Select
                  label="Harness"
                  value={targetHarness}
                  options={HARNESSES.map((id) => ({
                    value: id,
                    label: HARNESS_TITLE[id],
                  }))}
                  onChange={(value) => setTargetHarness(value as HarnessId)}
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="watch-target-model">
                  Model (optional)
                </label>
                <input
                  id="watch-target-model"
                  className={inputClass}
                  value={targetModel}
                  onChange={(event) => setTargetModel(event.target.value)}
                  placeholder="Harness default"
                />
              </div>
            </div>
            <div>
              <span className={labelClass}>Conversation</span>
              <Select
                label="Bound conversation"
                value={targetSessionId}
                options={[
                  { value: "", label: "A new conversation each run" },
                  ...sessionOptions,
                ]}
                onChange={setTargetSessionId}
              />
            </div>
            <div>
              <span className={labelClass}>Cooldown</span>
              <Select
                label="Run cooldown"
                value={cooldownSec}
                options={COOLDOWN_OPTIONS}
                onChange={setCooldownSec}
              />
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2 text-[13px] text-content/80">
          <Toggle label="Enabled" on={enabled} onChange={setEnabled} />
          Enabled — polls while MonoCode is open
        </div>

        {error ? (
          <p role="alert" className="text-[12px] text-red-400">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[12px] text-content/60 hover:bg-content/10"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/80"
            onClick={save}
          >
            {existing ? "Save watcher" : "Create watcher"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
