import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { InboxProviderMark } from "../chrome/InboxProviderMark";
import { Modal } from "../chrome/Modal";
import { SearchableSelect } from "../chrome/SearchableSelect";
import { Check, GitBranch, LoaderCircle, Plus, Search, X } from "../chrome/icons";
import { inboxItemRef, type InboxItem } from "../lib/githubTasks";
import { LAYER } from "../lib/layers";
import { projectName } from "../lib/paths";
import type { RecentProject } from "../lib/recents";
import type { LinkedWorkItem } from "../lib/session";
import { linkedWorkItemInboxKey } from "../lib/sessionWorkItem";
import { namedWorktreeBranch } from "../lib/worktrees";
import { useProjectBranchesState } from "../hooks/useProjectBranches";
import { boardTicketOptions } from "./boardData";

export type TaskWorkstreamSpec = {
  projectPath: string;
  branch: string;
  base: string;
  /** Bind this existing worktree instead of creating a new one. */
  worktreePath?: string;
};

export type NewTaskSpec = {
  title: string;
  links: LinkedWorkItem[];
  workstreams: TaskWorkstreamSpec[];
};

/** kebab-case fragment for `mc/<fragment>` branch names. */
function branchSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function suggestedBranch(title: string, links: LinkedWorkItem[]): string {
  const key = links
    .map((link) => link.identifier ?? "")
    .find((identifier) => /[A-Za-z][A-Za-z0-9]+-\d+/.test(identifier));
  const fragment = branchSlug(
    `${key ? `${key.toLowerCase()}-` : ""}${title}`.slice(0, 64),
  );
  return namedWorktreeBranch(fragment) ?? "mc/task";
}

/** Repo select options from recents — shared by this dialog and the
 * details panel's add-lane row. */
export function workstreamProjectOptions(recents: RecentProject[]) {
  return recents.map((project) => ({
    value: project.path,
    label: projectName(project.path) || project.path,
  }));
}

type DraftWorkstream = {
  key: number;
  projectPath: string;
  /** "" → auto from title/tickets on submit. */
  branch: string;
  base: string;
};

/** Repo + branch + base inputs — shared by this dialog and the details
 * panel's add-workstream row. `tail` is the trailing button (remove/add). */
export function WorkstreamFields({
  draft,
  projects,
  onChange,
  tail,
  compact,
  layer,
}: {
  draft: { projectPath: string; branch: string; base: string };
  projects: { value: string; label: string }[];
  onChange: (
    patch: Partial<{ projectPath: string; branch: string; base: string }>,
  ) => void;
  tail: ReactNode;
  compact?: boolean;
  /** Popover layer — pass `LAYER.dialogPopover` when inside a modal. */
  layer?: number;
}) {
  const { branches } = useProjectBranchesState(
    draft.projectPath,
    !!draft.projectPath,
  );
  const baseOptions = useMemo(() => {
    const list = (branches?.branches ?? []).map((branch) => ({
      value: branch.remote ? `${branch.remote}/${branch.name}` : branch.name,
      label: branch.remote ? `${branch.remote}/${branch.name}` : branch.name,
    }));
    const current = branches?.current;
    return current && !list.some((option) => option.value === current)
      ? [{ value: current, label: current }, ...list]
      : list;
  }, [branches]);
  const repoSelect = (
    <SearchableSelect
      label="Repository"
      value={draft.projectPath}
      options={projects}
      onChange={(projectPath) => onChange({ projectPath })}
      placeholder={compact ? "Repo…" : "Choose repo…"}
      searchPlaceholder="Search projects…"
      layer={layer}
      compact={compact}
    />
  );
  const baseSelect = (
    <SearchableSelect
      label="Base branch"
      value={draft.base}
      options={baseOptions}
      onChange={(base) => onChange({ base })}
      placeholder={branches ? "base…" : "…"}
      searchPlaceholder="Branches…"
      disabled={!draft.projectPath}
      layer={layer}
      compact={compact}
      minMenuWidth={260}
    />
  );
  const branchInput = (
    <input
      value={draft.branch}
      onChange={(event) => onChange({ branch: event.target.value })}
      placeholder={compact ? "mc/branch" : "mc/branch-name"}
      aria-label="Branch name"
      className={`${compact ? "h-8 min-w-0 flex-1" : "h-9 w-36 shrink-0"} rounded-md border border-content/10 bg-background-base px-2 font-mono text-[12px] text-content outline-none placeholder:text-content/35 focus:border-content/25`}
    />
  );
  // Compact rows live in the narrow details panel — stack the repo over
  // branch+base so every field stays readable.
  return compact ? (
    <div className="flex flex-col gap-1.5">
      {repoSelect}
      <div className="flex items-center gap-1.5">
        {branchInput}
        <div className="w-28 shrink-0">{baseSelect}</div>
        {tail}
      </div>
    </div>
  ) : (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">{repoSelect}</div>
      {branchInput}
      <div className="w-40 shrink-0">{baseSelect}</div>
      {tail}
    </div>
  );
}

export function NewTaskDialog({
  items,
  recents,
  busy,
  error,
  initialTitle,
  onSubmit,
  onCancel,
}: {
  items: InboxItem[];
  recents: RecentProject[];
  busy: boolean;
  /** Per-workstream errors from the last submit, joined for display. */
  error: string;
  /** Prefilled title — used when promoting a board-local card. */
  initialTitle?: string;
  onSubmit: (spec: NewTaskSpec) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle ?? "");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, LinkedWorkItem>>(
    new Map(),
  );
  const [streams, setStreams] = useState<DraftWorkstream[]>([
    { key: 0, projectPath: "", branch: "", base: "" },
  ]);
  const nextKey = useRef(1);
  const titleRef = useRef<HTMLInputElement>(null);
  // The modal focuses its close button on mount — land title focus a frame
  // later so the composer starts on the field.
  useEffect(() => {
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const projects = useMemo(() => workstreamProjectOptions(recents), [recents]);

  // Ticket picker lists everything the inbox knows that can become a link —
  // issues and PRs; delivery runs are status rows, not tickets.
  const tickets = useMemo(
    () => boardTicketOptions(items, query),
    [items, query],
  );

  const toggleTicket = (linked: LinkedWorkItem) => {
    const key = linkedWorkItemInboxKey(linked);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, linked);
      return next;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const links = [...selected.values()];
    const fallback = suggestedBranch(title, links);
    onSubmit({
      title: title.trim(),
      links,
      workstreams: streams
        .filter((stream) => stream.projectPath)
        .map((stream) => ({
          projectPath: stream.projectPath,
          branch: namedWorktreeBranch(stream.branch) || fallback,
          base: stream.base.trim() || "HEAD",
        })),
    });
  };

  return (
    <Modal
      title="New task"
      description="Link tickets to workstreams — each repo lane gets a branch and worktree."
      size="md"
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 px-4 pb-4 pt-1">
        <label className="flex flex-col gap-1.5 text-[12px] text-content/70">
          Title
          <input
            ref={titleRef}
            value={title}
            required
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Auth token refresh across services"
            className="h-9 rounded-md border border-content/10 bg-background-base px-2.5 text-[13px] text-content outline-none placeholder:text-content/40 focus:border-content/25"
          />
        </label>

        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
              Tickets
            </h3>
            {selected.size ? (
              <span className="text-[11px] text-content/45">
                {selected.size} linked
              </span>
            ) : null}
          </div>
          {selected.size ? (
            // Linked tickets stay visible as chips — the list scrolls away.
            <div className="mb-1.5 flex flex-wrap gap-1">
              {[...selected.entries()].map(([key, link]) => (
                <button
                  key={key}
                  type="button"
                  title="Unlink ticket"
                  onClick={() => toggleTicket(link)}
                  className="flex max-w-44 items-center gap-1 rounded-md bg-content/7 px-1.5 py-0.5 text-[11px] text-content/70 outline-none hover:bg-content/10 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
                >
                  {link.provider ? (
                    <InboxProviderMark
                      provider={link.provider}
                      className="size-3 shrink-0 text-content/55"
                    />
                  ) : null}
                  <span className="truncate">
                    {link.identifier ?? link.title ?? key}
                  </span>
                  <X className="size-2.5 shrink-0" strokeWidth={2} />
                </button>
              ))}
            </div>
          ) : null}
          <label className="relative mb-1.5 flex items-center">
            <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search inbox items…"
              aria-label="Search tickets"
              className="h-7 w-full rounded-md bg-content/6 pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/40 focus:ring-1 focus:ring-accent/40"
            />
          </label>
          <div
            role="group"
            aria-label="Tickets"
            className="max-h-44 overflow-y-auto overscroll-none rounded-lg border border-content/8"
          >
            {tickets.map(({ item, linked }) => {
              const key = linkedWorkItemInboxKey(linked);
              const checked = selected.has(key);
              return (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggleTicket(linked)}
                  className="flex w-full items-center gap-2 border-b border-content/5 px-2 py-1.5 text-left outline-none last:border-0 hover:bg-content/5 focus-visible:bg-content/6"
                >
                  <InboxProviderMark
                    provider={item.provider}
                    className="size-3.5 shrink-0 text-content/60"
                  />
                  <span className="shrink-0 rounded bg-content/8 px-1 py-px text-[10px] font-medium text-content/55">
                    {inboxItemRef(item)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-content/85">
                    {item.title}
                  </span>
                  {checked ? (
                    <Check
                      className="size-3.5 shrink-0 text-accent"
                      strokeWidth={2.25}
                    />
                  ) : null}
                </button>
              );
            })}
            {!tickets.length ? (
              <p className="px-3 py-2.5 text-[12px] text-content/40">
                No inbox items match. You can still create the task and link
                tickets later.
              </p>
            ) : null}
          </div>
        </section>

        <section>
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-content/40">
              Workstreams
            </h3>
            <button
              type="button"
              onClick={() =>
                setStreams((current) => [
                  ...current,
                  { key: nextKey.current++, projectPath: "", branch: "", base: "" },
                ])
              }
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-content/55 outline-none hover:bg-content/8 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
            >
              <Plus className="size-3" strokeWidth={2} />
              Add repo
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {streams.map((stream) => (
              <WorkstreamFields
                key={stream.key}
                draft={stream}
                projects={projects}
                layer={LAYER.dialogPopover}
                onChange={(patch) =>
                  setStreams((current) =>
                    current.map((entry) =>
                      entry.key === stream.key ? { ...entry, ...patch } : entry,
                    ),
                  )
                }
                tail={
                  streams.length > 1 ? (
                    <button
                      type="button"
                      aria-label="Remove workstream"
                      onClick={() =>
                        setStreams((current) =>
                          current.filter((entry) => entry.key !== stream.key),
                        )
                      }
                      className="grid size-7 shrink-0 place-items-center rounded-md text-content/40 outline-none hover:bg-content/8 hover:text-content focus-visible:ring-1 focus-visible:ring-accent/60"
                    >
                      <X className="size-3.5" strokeWidth={1.75} />
                    </button>
                  ) : null
                }
              />
            ))}
          </div>
          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-content/40">
            <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
            Each repo gets a new worktree on its branch, with a session bound
            to it.
          </p>
        </section>

        {error ? (
          <p role="alert" className="text-[12px] text-red-300">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12px] text-content/70 outline-none hover:bg-content/8 focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-[0.97] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base outline-none transition-transform focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.97] disabled:opacity-40"
          >
            {busy ? (
              <LoaderCircle
                className="size-3.5 animate-spin"
                strokeWidth={2}
              />
            ) : null}
            Create task
          </button>
        </div>
      </form>
    </Modal>
  );
}
