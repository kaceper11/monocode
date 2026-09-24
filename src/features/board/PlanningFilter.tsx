import { useEffect, useRef, useState } from "react";
import type { InboxProvider } from "../inbox/model/githubTasks";
import { INBOX_SOURCE_LABELS } from "../inbox/model/inboxFilters";
import {
  periodKey,
  planningPeriods,
  planningScopes,
  type PlanningPeriod,
  type PlanningScope,
} from "../inbox/model/planning";
import type { RecentProject } from "../projects/model/recents";
import { projectName } from "../../shared/lib/paths";
import { SearchableSelect } from "../../shared/ui/SearchableSelect";
import {
  Check,
  ChevronDown,
  Search,
  X,
  LoaderCircle,
  RefreshCw,
} from "../../shared/ui/icons";
import { InboxProviderMark } from "../inbox/ui/InboxProviderMark";
import { LAYER } from "../../shared/lib/layers";

export function PlanningFilter({
  selected,
  onChange,
  recents,
}: {
  selected: PlanningPeriod[];
  onChange: (p: PlanningPeriod[]) => void;
  recents: RecentProject[];
}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<InboxProvider>(
    selected[0]?.scope.provider ?? "azuredevops",
  );
  const [cwd, setCwd] = useState(
    selected[0]?.scope.cwd ?? recents[0]?.path ?? "",
  );
  const [scopes, setScopes] = useState<PlanningScope[]>([]);
  const [scope, setScope] = useState<PlanningScope | null>(null);
  const [periods, setPeriods] = useState<PlanningPeriod[]>([]);
  const [scopeNext, setScopeNext] = useState<string | null>(null);
  const [periodNext, setPeriodNext] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [time, setTime] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const run = ++generation.current;
    setScopes([]);
    setScope(null);
    setPeriods([]);
    setScopeNext(null);
    setPeriodNext(null);
    if (!open || (provider === "github" && !cwd)) {
      setBusy(false);
      return;
    }
    setBusy(true);
    setError("");
    void planningScopes(provider, provider === "github" ? cwd : "")
      .then((page) => {
        if (run !== generation.current) return;
        setScopes(page.entries);
        setScopeNext(page.next);
      })
      .catch((error) => {
        if (run === generation.current) setError(String(error));
      })
      .finally(() => {
        if (run === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [open, provider, cwd]);
  const loadPeriods = async (selectedScope: PlanningScope, cursor = "") => {
    const run = ++generation.current;
    setScope(selectedScope);
    setBusy(true);
    setError("");
    if (!cursor) {
      setPeriods([]);
      setPeriodNext(null);
    }
    try {
      const page = await planningPeriods(selectedScope, cursor);
      if (run !== generation.current) return;
      setPeriods((old) => (cursor ? [...old, ...page.entries] : page.entries));
      setPeriodNext(page.next);
    } catch (error) {
      if (run === generation.current) setError(String(error));
    } finally {
      if (run === generation.current) setBusy(false);
    }
  };
  const now = Date.now();
  const choices = [
    ...new Map(
      [...selected, ...periods].map((p) => [periodKey(p), p]),
    ).values(),
  ].filter((p) => {
    if (
      !`${p.label} ${p.scope.name}`.toLowerCase().includes(search.toLowerCase())
    )
      return false;
    if (time === "all" || selected.some((s) => periodKey(s) === periodKey(p)))
      return true;
    const start = Date.parse(p.start),
      end =
        Date.parse(p.end) + (/^\d{4}-\d{2}-\d{2}$/.test(p.end) ? 86400000 : 0);
    return time === "current"
      ? start <= now && (!Number.isFinite(end) || end >= now)
      : time === "upcoming"
        ? start > now
        : end < now;
  });
  return (
    <section className="border-b border-content/8 py-1 text-[11px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-content/75 hover:bg-content/5 focus-visible:outline-accent"
      >
        <span>Sprint / cycle</span>
        <span className="ml-auto text-[11px] text-content/40">
          {selected.length ? `${selected.length} selected` : "All"}
        </span>
        <ChevronDown
          className={`size-3 text-content/40 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pb-1">
          {selected.map((p) => (
            <button
              type="button"
              key={periodKey(p)}
              onClick={() =>
                onChange(selected.filter((s) => periodKey(s) !== periodKey(p)))
              }
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent/10 px-1.5 py-1 text-accent hover:bg-accent/15"
              title={`${p.scope.name} — remove filter`}
            >
              <span className="truncate">{p.label}</span>
              <X className="size-3 shrink-0" />
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-2 px-2 pb-2">
          <div
            className="flex items-center gap-1 border-b border-content/8 pb-2"
            role="group"
            aria-label="Sprint provider"
          >
            {Object.entries(INBOX_SOURCE_LABELS).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={provider === value}
                onClick={() => setProvider(value as InboxProvider)}
                className={`flex h-7 flex-1 items-center justify-center rounded-md transition-colors focus-visible:outline-accent ${provider === value ? "bg-content/10 text-content" : "text-content/40 hover:bg-content/5 hover:text-content/75"}`}
              >
                <InboxProviderMark
                  provider={value as InboxProvider}
                  className="size-3.5"
                />
              </button>
            ))}
          </div>
          {provider === "github" && (
            <SearchableSelect
              variant="row"
              label="GitHub repository"
              value={cwd}
              options={recents.map((r) => ({
                value: r.path,
                label: projectName(r.path),
              }))}
              onChange={setCwd}
              layer={LAYER.submenu}
            />
          )}
          <SearchableSelect
            variant="row"
            label="Planning scope"
            value={scope?.id ?? ""}
            options={scopes.map((s) => ({ value: s.id, label: s.name }))}
            onChange={(id) => {
              const s = scopes.find((s) => s.id === id);
              if (s) void loadPeriods(s);
            }}
            placeholder={
              provider === "jira"
                ? "Choose Scrum board…"
                : provider === "linear"
                  ? "Choose team…"
                  : "Choose project…"
            }
            layer={LAYER.submenu}
          />
          {scopeNext && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const run = generation.current;
                setBusy(true);
                setError("");
                try {
                  const page = await planningScopes(
                    provider,
                    provider === "github" ? cwd : "",
                    scopeNext,
                  );
                  if (run === generation.current) {
                    setScopes((old) => [...old, ...page.entries]);
                    setScopeNext(page.next);
                  }
                } catch (error) {
                  if (run === generation.current) setError(String(error));
                } finally {
                  if (run === generation.current) setBusy(false);
                }
              }}
              className="rounded px-1 py-1 text-left text-content/50 hover:bg-content/5 hover:text-content disabled:opacity-40"
            >
              More projects / teams
            </button>
          )}
          <div
            className="flex gap-0.5 rounded-md bg-content/4 p-0.5"
            role="group"
            aria-label="Period dates"
          >
            {[
              ["all", "All"],
              ["current", "Current"],
              ["upcoming", "Upcoming"],
              ["completed", "Past"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={time === value}
                onClick={() => setTime(value)}
                className={`h-6 flex-1 rounded text-[10px] focus-visible:outline-accent ${time === value ? "bg-content/8 text-content" : "text-content/40 hover:text-content/75"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex h-7 items-center gap-1.5 border-b border-content/8 px-1 text-content/40 focus-within:border-accent/40">
            <Search className="size-3 shrink-0" />
            <input
              aria-label="Search sprints"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a sprint or cycle…"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-content outline-none placeholder:text-content/30"
            />
          </label>
          <div className="max-h-44 overflow-y-auto">
            {choices.map((p) => {
              const checked = selected.some(
                (s) => periodKey(s) === periodKey(p),
              );
              return (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  key={periodKey(p)}
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-left text-content/75 hover:bg-content/5 focus-visible:outline-accent disabled:opacity-40"
                  disabled={!checked && selected.length >= 20}
                  onClick={() =>
                    onChange(
                      checked
                        ? selected.filter((s) => periodKey(s) !== periodKey(p))
                        : [...selected, p],
                    )
                  }
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{p.label}</span>
                    <span className="block text-content/40">
                      {INBOX_SOURCE_LABELS[p.scope.provider]} · {p.scope.name}
                      {p.start ? ` · ${p.start.slice(0, 10)}` : ""}
                    </span>
                  </span>
                  {checked && <Check className="size-3 shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>
          {periodNext && scope && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void loadPeriods(scope, periodNext)}
              className="rounded px-1 py-1 text-left text-content/50 hover:bg-content/5 hover:text-content disabled:opacity-40"
            >
              More periods
            </button>
          )}
          {busy && (
            <p
              role="status"
              className="flex items-center gap-1.5 px-1 py-2 text-content/40"
            >
              <LoaderCircle className="size-3 animate-spin" />
              Loading…
            </p>
          )}
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
          {!busy && scope && !choices.length && !error && (
            <p>No periods found in this scope.</p>
          )}
          {scope && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void loadPeriods(scope)}
              className="rounded px-1 py-1 text-left text-content/50 hover:bg-content/5 hover:text-content disabled:opacity-40"
            >
              <RefreshCw className="mr-1 inline size-3" />
              Refresh periods
            </button>
          )}
          <p className="text-content/40">Match any selected sprint or cycle.</p>
        </div>
      )}
    </section>
  );
}
