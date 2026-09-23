import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Checkbox } from "../../shared/ui/Checkbox";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import { SecondaryButton } from "../../shared/ui/SecondaryButton";
import { Modal } from "../../shared/ui/Modal";
import { Popover } from "../../shared/ui/Popover";
import {
  ChevronRight,
  ExternalLink,
  RefreshCw,
  CheckCircle,
  CircleX,
  CircleDashed,
  Clock,
  AlertCircle,
} from "../../shared/ui/icons";
import {
  checkState,
  ciLabel,
  probeDelivery,
  PROVIDER_NAMES,
  type CiState,
  type CiBinding,
  type DeliveryProvider,
  type DeliverySnapshot,
} from "./delivery";
import type { TaskWorkstream } from "./boardStore";
import type { WorkstreamStatus } from "./boardData";

const buttonClass =
  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-content/8 focus-visible:ring-1 focus-visible:ring-accent";
const CHECK_APPEARANCE = {
  failed: {
    icon: CircleX,
    tone: "text-red-700 dark:text-red-400",
    badge: "bg-red-500/12 ring-red-500/20",
  },
  running: {
    icon: Clock,
    tone: "text-amber-700 dark:text-amber-300",
    badge: "bg-amber-500/12 ring-amber-500/20",
  },
  blocked: {
    icon: AlertCircle,
    tone: "text-amber-700 dark:text-amber-300",
    badge: "bg-amber-500/12 ring-amber-500/20",
  },
  passed: {
    icon: CheckCircle,
    tone: "text-emerald-700 dark:text-emerald-300",
    badge: "bg-emerald-500/12 ring-emerald-500/20",
  },
  canceled: {
    icon: CircleDashed,
    tone: "text-content/45",
    badge: "bg-content/5 ring-content/10",
  },
  skipped: {
    icon: CircleDashed,
    tone: "text-content/40",
    badge: "bg-content/5 ring-content/10",
  },
  unknown: {
    icon: AlertCircle,
    tone: "text-content/45",
    badge: "bg-content/5 ring-content/10",
  },
} satisfies Record<
  CiState,
  { icon: typeof CircleX; tone: string; badge: string }
>;
export function CiBadge({
  status,
  onFix,
}: {
  status?: WorkstreamStatus;
  onFix: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const checks = status?.checks ?? [];
  const stale = !!status?.fetchedAt && Date.now() - status.fetchedAt > 60_000;
  const error =
    status?.ciError ||
    status?.error ||
    (stale ? "CI status is stale — refresh the board" : undefined);
  const failing = checks.some((c) => checkState(c) === "failed");
  const states = checks.map(checkState);
  const summary =
    (["failed", "running", "blocked", "unknown", "canceled"] as const).find(
      (s) => states.includes(s),
    ) ?? (states.some((s) => s === "passed") ? "passed" : "skipped");
  const appearance = CHECK_APPEARANCE[summary];
  const StateIcon = error
    ? AlertCircle
    : !status
      ? Clock
      : !states.length
        ? CircleDashed
        : appearance.icon;
  const tone = error || !states.length ? "text-content/45" : appearance.tone;
  const summaryLabel = status ? ciLabel(checks, error) : "CI loading…";
  return (
    <>
      <button
        className={`${buttonClass} ${tone} ring-1 ring-inset font-medium ${error || !states.length ? "bg-content/5 ring-content/10" : appearance.badge}`}
        title={`${summaryLabel} · Show check details`}
        aria-label="Show CI checks"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <StateIcon
          aria-hidden="true"
          className="size-3 shrink-0"
          strokeWidth={1.75}
        />
        {summaryLabel}
        <ChevronRight
          className={`size-3 opacity-45 transition-transform ${anchor ? "rotate-90" : ""}`}
        />
      </button>
      {anchor && (
        <Popover
          anchor={anchor}
          width={300}
          maxHeight={360}
          onDismiss={() => setAnchor(null)}
          className="overflow-y-auto p-2"
        >
          <div className="mb-2 flex items-center gap-2 text-[12px] font-medium">
            <StateIcon className={`size-3.5 ${tone}`} />
            <span>{summaryLabel}</span>
            {!!checks.length && (
              <span className="ml-auto text-[10px] font-normal tabular-nums text-content/40">
                {states.filter((s) => s === "passed").length}/{checks.length}{" "}
                passed
              </span>
            )}
          </div>
          <div className="mb-2 break-words text-[10px] text-content/45">
            {status?.delivery?.ciSource
              ? `${PROVIDER_NAMES[status.delivery.ciSource.provider]} · ${status.delivery.ciSource.repo}`
              : "CI checks"}
            {status?.fetchedAt && (
              <span className="mt-0.5 block">
                Updated {new Date(status.fetchedAt).toLocaleTimeString()} ·{" "}
                {status.delivery?.headSha.slice(0, 8)}
              </span>
            )}
          </div>
          {error && (
            <p
              role="alert"
              className="mb-2 text-[12px] text-amber-700 dark:text-amber-300"
            >
              {error}
            </p>
          )}
          {checks.map((check, i) => {
            const state = checkState(check);
            const { icon: Icon, tone: checkTone } = CHECK_APPEARANCE[state];
            return (
              <div
                key={check.url + check.name + i}
                className="flex items-start gap-2 border-t border-content/6 py-2 text-[11px]"
              >
                <Icon
                  aria-hidden="true"
                  className={`mt-0.5 size-3.5 shrink-0 ${error ? "text-content/35" : checkTone}`}
                />
                <span className="min-w-0 flex-1 break-words text-content/80">
                  {check.name}
                  <span className="mt-0.5 block text-[10px] text-content/45">
                    {state}
                    {check.state.toLowerCase() !== state
                      ? ` · ${check.state.toLowerCase().replace(/_/g, " ")}`
                      : ""}
                  </span>
                </span>
                {check.url && (
                  <button
                    aria-label={`Open ${check.name}`}
                    title="Open check on provider"
                    className={`${buttonClass} text-content/45 hover:text-content`}
                    onClick={() => void openUrl(check.url)}
                  >
                    <ExternalLink className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
          {!checks.length && !error && (
            <p className="py-2 text-[12px] text-content/55">
              No runs for this revision.
            </p>
          )}
          {failing && !error && (
            <button
              className={`${buttonClass} mt-2 text-accent`}
              onClick={() => {
                setAnchor(null);
                onFix();
              }}
            >
              <RefreshCw className="size-3" />
              Fix CI with an agent…
            </button>
          )}
        </Popover>
      )}
    </>
  );
}
const inputClass =
  "w-full rounded-md border border-stroke bg-background-base px-2 py-1.5 text-[12px] text-content focus-visible:ring-1 focus-visible:ring-accent";
export function DeliverySettings({
  ws,
  snapshot,
  onSave,
  onClose,
}: {
  ws: TaskWorkstream;
  snapshot?: DeliverySnapshot;
  onSave: (patch: Pick<TaskWorkstream, "prProvider" | "prUrl" | "ci">) => void;
  onClose: () => void;
}) {
  const [prProvider, setPrProvider] = useState<DeliveryProvider | "">(
    ws.prProvider || "",
  );
  const [prUrl, setPrUrl] = useState(ws.prUrl || "");
  const [ci, setCi] = useState<CiBinding>(
    ws.ci || {
      provider:
        snapshot?.ciSource?.provider || snapshot?.source.provider || "github",
      repo: snapshot?.ciSource?.repo,
      host: snapshot?.ciSource?.host,
    },
  );
  const [definitions, setDefinitions] = useState<
    { id: number; name: string }[]
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState(false);
  const loadDefinitions = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await invoke<{
        host: string;
        definitions: { id: number; name: string }[];
        truncated: boolean;
      }>("task_delivery_definitions", { project: ci.project });
      setDefinitions(result.definitions);
      setPartial(result.truncated);
      setCi((c) => ({ ...c, host: result.host }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const patch = {
        prProvider: prProvider || undefined,
        prUrl: prUrl.trim() || undefined,
        ci,
      };
      const result = await probeDelivery({ ...ws, ...patch });
      if (result.ciError) throw new Error(result.ciError);
      onSave({ ...patch, ci: { ...ci, host: result.ciSource?.host } });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="PR and CI sources"
      size="sm"
      fitViewport
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="flex flex-col gap-3 p-4 text-[12px]">
        <label>
          Pull requests
          <SearchableSelect
            label="Pull request provider"
            variant="transparent"
            searchable={false}
            disabled={busy}
            value={prProvider}
            onChange={(value) => setPrProvider(value as DeliveryProvider | "")}
            options={[
              {
                value: "",
                label: snapshot
                  ? `Detected · ${PROVIDER_NAMES[snapshot.source.provider]}`
                  : "Detected from repository",
              },
              ...Object.entries(PROVIDER_NAMES).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
        </label>
        <label>
          PR / MR URL <span className="text-content/45">optional</span>
          <input
            aria-label="Pinned PR URL"
            className={inputClass}
            disabled={busy}
            value={prUrl}
            onChange={(e) => setPrUrl(e.target.value)}
            placeholder="Follow this branch, or paste a PR URL"
          />
        </label>
        <label>
          CI provider
          <SearchableSelect
            label="CI provider"
            variant="transparent"
            searchable={false}
            disabled={busy}
            value={ci.provider}
            onChange={(value) => {
              setCi({ provider: value as DeliveryProvider });
              setDefinitions([]);
              setPartial(false);
            }}
            options={Object.entries(PROVIDER_NAMES).map(([value, label]) => ({
              value,
              label: value === "azuredevops" ? "Azure Pipelines" : label,
            }))}
          />
        </label>
        {ci.provider === "azuredevops" ? (
          <>
            <label>
              Azure project
              <input
                aria-label="Azure project"
                className={inputClass}
                disabled={busy}
                value={ci.project || ""}
                onChange={(e) => {
                  setCi((c) => ({
                    ...c,
                    project: e.target.value,
                    definitionIds: [],
                  }));
                  setDefinitions([]);
                }}
              />
            </label>
            <SecondaryButton
              disabled={busy || !ci.project?.trim()}
              onClick={() => void loadDefinitions()}
            >
              Load pipelines
            </SecondaryButton>
            {definitions.map((d) => (
              <label key={d.id} className="flex items-center gap-2">
                <Checkbox
                  label={d.name}
                  disabled={busy}
                  checked={ci.definitionIds?.includes(d.id) || false}
                  onChange={() =>
                    setCi((c) => ({
                      ...c,
                      definitionIds: !c.definitionIds?.includes(d.id)
                        ? [...(c.definitionIds || []), d.id]
                        : (c.definitionIds || []).filter((id) => id !== d.id),
                    }))
                  }
                />
                {d.name}
              </label>
            ))}
            {!definitions.length && !!ci.definitionIds?.length && (
              <p>Selected pipeline IDs: {ci.definitionIds.join(", ")}</p>
            )}
            {partial && (
              <p className="text-amber-700 dark:text-amber-300">
                Only the first 100 pipelines are listed.
              </p>
            )}
          </>
        ) : (
          <label>
            CI repository
            <input
              aria-label="CI repository"
              className={inputClass}
              disabled={busy}
              value={ci.repo || ""}
              onChange={(e) => setCi((c) => ({ ...c, repo: e.target.value }))}
              placeholder="Use the selected provider’s repository remote"
            />
          </label>
        )}
        {ci.provider === "github" && (
          <label>
            GitHub host
            <input
              aria-label="GitHub CI host"
              className={inputClass}
              disabled={busy}
              value={ci.host || "github.com"}
              onChange={(e) => setCi((c) => ({ ...c, host: e.target.value }))}
            />
          </label>
        )}
        <p className="break-all text-[11px] text-content/50">
          {ci.host || "Uses the existing provider connection from Settings."} ·
          PR and CI sources are independent.
        </p>
        {error && (
          <p
            role="alert"
            className="break-words text-red-700 dark:text-red-400"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <SecondaryButton disabled={busy} onClick={onClose}>
            Cancel
          </SecondaryButton>
          <button
            disabled={busy}
            className="rounded-md bg-accent/15 px-3 py-1.5 font-medium text-accent hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
            onClick={() => void save()}
          >
            {busy ? "Checking…" : "Save sources"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
