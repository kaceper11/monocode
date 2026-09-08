import { inheritWorktreeConnections } from "../lib/connections";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { notifyGitChanged } from "../lib/fs";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Folder,
  GitBranch,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "./icons";

type Worktree = {
  path: string;
  head: string;
  branch: string | null;
  main: boolean;
  locked: string | null;
  prunable: string | null;
  missing: boolean;
  users: string[];
};
type Ref = { name: string; commit: string };

export function WorktreePanel({
  cwd,
  onClose,
  onOpen,
  onBusyChange,
  initialBase = "",
}: {
  cwd: string;
  onClose: () => void;
  onOpen: (path: string) => void;
  onBusyChange: (busy: boolean) => void;
  initialBase?: string;
}) {
  const [entries, setEntries] = useState<Worktree[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [base, setBase] = useState(initialBase);
  const [creating, setCreating] = useState(Boolean(initialBase));
  const [choosingBase, setChoosingBase] = useState(false);
  const [baseQuery, setBaseQuery] = useState("");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const [editPath, setEditPath] = useState(false);
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{
    entry: Worktree;
    action: "open" | "remove";
  } | null>(null);
  const pending = useRef(false);
  const selected = refs.find((ref) => ref.name === base);
  const refresh = async () => {
    const [trees, branches] = await Promise.all([
      invoke<Worktree[]>("git_worktrees", { cwd }),
      invoke<Ref[]>("git_worktree_refs", { cwd }),
    ]);
    setEntries(trees);
    setRefs(branches);
  };
  const run = async (work: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      await work();
    } catch (err) {
      setError(String(err));
    } finally {
      try {
        await refresh();
      } catch (err) {
        setError((previous) => `${previous}\nRefresh failed: ${err}`.trim());
      }
      pending.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  useEffect(() => {
    void run(async () => {});
  }, []);
  useEffect(() => {
    if (!busy && !creating && !choosingBase && !confirmation)
      search.current?.focus();
  }, [busy, creating, choosingBase, confirmation]);
  const name = query.trim();
  const visibleEntries = entries.filter((entry) =>
    `${entry.branch ?? ""} ${entry.path}`
      .toLowerCase()
      .includes(name.toLowerCase()),
  );
  const canCreate =
    name.length > 0 && !refs.some((ref) => ref.name === `refs/heads/${name}`);
  const prepareCreate = () => {
    setBranch(name);
    setPath(`${cwd}-${name.replace(/\//g, "-")}`);
    const current = entries.find((entry) => entry.path === cwd)?.branch;
    if (!base && current) setBase(current);
    setCreating(true);
    if (!base && !current) {
      setBaseQuery("");
      setChoosingBase(true);
    }
  };
  const selectedName = base.replace(/^refs\/(heads|remotes)\//, "");
  const rowClass =
    "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/5 disabled:opacity-40";
  const inputClass =
    "min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/40 disabled:opacity-60";
  const openWorktree = (path: string) => {
    try {
      inheritWorktreeConnections(cwd, path);
    } catch (error) {
      setError(
        `Worktree is available, but its connection settings could not be copied: ${error}`,
      );
      return;
    }
    onOpen(path);
    onClose();
  };
  const openEntry = (entry: Worktree) => {
    if (entry.users.length) {
      setConfirmation({ entry, action: "open" });
      return;
    }
    openWorktree(entry.path);
  };
  const createAndOpen = () => {
    if (!selected || !branch || !path) return;
    let created: string | undefined;
    void run(async () => {
      created = await invoke<string>("git_worktree_create", {
        cwd,
        base,
        commit: selected.commit,
        branch,
        path,
      });
      notifyGitChanged();
    }).then(() => {
      if (created) {
        openWorktree(created);
      }
    });
  };
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-none text-[12px]"
      aria-busy={busy}
    >
      {confirmation ? (
        <div className="space-y-2 px-3 py-2.5">
          <p className="font-medium">
            {confirmation.action === "remove"
              ? "Remove worktree?"
              : "Share this worktree?"}
          </p>
          <p className="truncate font-mono">
            {confirmation.entry.branch?.replace("refs/heads/", "")} ·{" "}
            {confirmation.entry.head.slice(0, 10)}
          </p>
          <p className="break-all text-[11px] text-content/50">
            {confirmation.entry.path}
          </p>
          <p className="text-[11px] leading-4 text-content/60">
            {confirmation.action === "remove"
              ? "The branch and conversations stay. Unsaved files and running work block removal."
              : "Other conversations use this folder. Their agents can change the same files."}
          </p>
          {confirmation.entry.users.length > 0 && (
            <details className="max-h-24 overflow-auto text-[11px] text-content/50">
              <summary>Existing conversations</summary>
              {confirmation.entry.users.map((user) => (
                <p key={user}>{user}</p>
              ))}
            </details>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              className="rounded-md px-2 py-1.5 text-content/50 hover:bg-content/5"
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-md bg-content/10 px-2 py-1.5 hover:bg-content/15"
              onClick={() => {
                const { entry, action } = confirmation;
                if (action === "open") {
                  openWorktree(entry.path);
                  return;
                }
                void run(async () => {
                  await invoke("git_worktree_remove", {
                    cwd,
                    path: entry.path,
                    head: entry.head,
                  });
                  notifyGitChanged();
                  setConfirmation(null);
                });
              }}
            >
              {confirmation.action === "remove"
                ? "Remove"
                : "Open conversation"}
            </button>
          </div>
        </div>
      ) : choosingBase ? (
        <>
          <label className="flex items-center gap-2 border-b border-content/10 px-2 py-2.5 text-content/50">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              autoFocus
              className={inputClass}
              aria-label="Choose base branch"
              placeholder="Search base branches…"
              value={baseQuery}
              onChange={(e) => setBaseQuery(e.target.value)}
            />
          </label>
          <div className="px-1.5 py-1.5">
            {refs
              .filter((ref) =>
                ref.name.toLowerCase().includes(baseQuery.toLowerCase()),
              )
              .slice(0, 200)
              .map((ref) => (
                <button
                  type="button"
                  key={ref.name}
                  className={rowClass}
                  onClick={() => {
                    setBase(ref.name);
                    setChoosingBase(false);
                    setCreating(true);
                  }}
                >
                  <GitBranch
                    className="size-3.5 shrink-0 text-content/50"
                    strokeWidth={1.75}
                  />
                  <span className="truncate font-mono">
                    {ref.name.replace(/^refs\/(heads|remotes)\//, "")}
                  </span>
                </button>
              ))}
          </div>
        </>
      ) : creating ? (
        <>
          <div className="flex items-center gap-2 border-b border-content/10 px-2 py-2 text-content/60">
            <button
              type="button"
              disabled={busy}
              aria-label="Back to worktrees"
              className="rounded p-0.5 hover:bg-content/10"
              onClick={() => setCreating(false)}
            >
              <ArrowLeft className="size-3.5" strokeWidth={1.75} />
            </button>
            <span>New branch and worktree</span>
          </div>
          <label className="flex items-center gap-2 border-b border-content/10 px-2.5 py-2.5 text-content/50">
            <GitBranch className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              autoFocus
              disabled={busy}
              className={inputClass}
              aria-label="New branch name"
              placeholder="New branch name…"
              value={branch}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  createAndOpen();
                }
              }}
              onChange={(e) => {
                setBranch(e.target.value);
                if (!path || path === `${cwd}-${branch.replace(/\//g, "-")}`)
                  setPath(`${cwd}-${e.target.value.replace(/\//g, "-")}`);
              }}
            />
          </label>
          <div className="space-y-0.5 px-1.5 py-1.5">
            <button
              type="button"
              disabled={busy}
              className={rowClass}
              onClick={() => {
                setBaseQuery("");
                setChoosingBase(true);
              }}
            >
              <GitBranch
                className="size-3.5 shrink-0 text-content/50"
                strokeWidth={1.75}
              />
              <span className="text-content/50">From</span>
              <span className="min-w-0 flex-1 truncate font-mono">
                {selectedName || "Choose branch"}
              </span>
              <ChevronRight className="size-3 shrink-0 text-content/40" />
            </button>
            <button
              type="button"
              disabled={busy}
              title={path || "Choose a folder"}
              className={rowClass}
              onClick={() => setEditPath(!editPath)}
            >
              <Folder
                className="size-3.5 shrink-0 text-content/50"
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-content/50">
                {path.split("/").pop() || "Folder chosen from branch name"}
              </span>
              <ChevronRight className="size-3 shrink-0 text-content/40" />
            </button>
            {editPath && (
              <input
                aria-label="Worktree folder"
                disabled={busy}
                className="mb-1 w-full rounded-md bg-content/5 px-2 py-1.5 font-mono text-[11px] text-content outline-none"
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
            )}
            <button
              type="button"
              disabled={busy || !selected || !branch || !path}
              className="mt-1 flex h-8 w-full items-center gap-2 rounded-md bg-content/10 px-2 text-left text-content hover:bg-content/15 disabled:opacity-40"
              onClick={createAndOpen}
            >
              <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
              {busy ? "Creating…" : "Create branch and worktree"}
            </button>
          </div>
          {selected && (
            <p
              className="border-t border-content/10 px-2.5 py-2 font-mono text-[10px] text-content/40"
              title={`Base ${selected.name} at ${selected.commit}. Remote refs use the local cache; fetch explicitly and refresh.`}
            >
              Base commit {selected.commit.slice(0, 10)}
            </p>
          )}
        </>
      ) : (
        <>
          <label className="flex items-center gap-2 border-b border-content/10 px-2 py-2.5 text-content/50">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              ref={search}
              autoFocus
              disabled={busy}
              className={inputClass}
              aria-label="Search or create a worktree"
              placeholder="Search or create a worktree…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(e) => {
                const count = visibleEntries.length + Number(canCreate);
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIndex((index) =>
                    count
                      ? (index + (e.key === "ArrowDown" ? 1 : count - 1)) %
                        count
                      : 0,
                  );
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const entry = visibleEntries[activeIndex];
                  if (entry && !entry.missing && !entry.prunable)
                    openEntry(entry);
                  else if (!entry && canCreate) prepareCreate();
                }
              }}
            />
          </label>
          <div className="px-1.5 py-1.5">
            {visibleEntries.map((entry, index) => (
              <div key={entry.path} className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={busy || entry.missing || !!entry.prunable}
                  title={`${entry.path} · Local${entry.users.length ? ` · ${entry.users.length} conversations` : ""}`}
                  className={`${rowClass} ${index === activeIndex ? "bg-content/10" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => openEntry(entry)}
                >
                  {entry.path === cwd ? (
                    <Check className="size-3.5 shrink-0" strokeWidth={1.75} />
                  ) : (
                    <GitBranch
                      className="size-3.5 shrink-0 text-content/50"
                      strokeWidth={1.75}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {entry.branch?.replace("refs/heads/", "") ??
                      `Detached ${entry.head.slice(0, 8)}`}
                  </span>
                  <span className="shrink-0 text-[10px] text-content/40">
                    {entry.missing
                      ? "missing"
                      : entry.locked
                        ? "locked"
                        : entry.main
                          ? "main"
                          : entry.path === cwd
                            ? "current"
                            : ""}
                  </span>
                </button>
                {!entry.main && entry.branch && (
                  <button
                    type="button"
                    disabled={
                      busy ||
                      entry.path === cwd ||
                      entry.missing ||
                      !!entry.locked ||
                      !!entry.prunable
                    }
                    title="Remove worktree"
                    aria-label={`Remove worktree ${entry.branch.replace("refs/heads/", "")}`}
                    className="shrink-0 rounded p-1 text-content/40 hover:bg-content/10 hover:text-red-400 disabled:opacity-20"
                    onClick={() => setConfirmation({ entry, action: "remove" })}
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                  </button>
                )}
              </div>
            ))}
            <div className="mt-1 border-t border-content/10 pt-1">
              {canCreate && (
                <button
                  type="button"
                  disabled={busy}
                  className={`${rowClass} ${activeIndex === visibleEntries.length ? "bg-content/10" : ""}`}
                  onMouseEnter={() => setActiveIndex(visibleEntries.length)}
                  onClick={prepareCreate}
                >
                  <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="truncate">
                    Create worktree <span className="font-mono">{name}</span>
                  </span>
                </button>
              )}
              {name && !visibleEntries.length && !canCreate && (
                <p className="px-2 py-1.5 text-content/50">
                  Branch already exists. Create its worktree from Branches.
                </p>
              )}
              <button
                type="button"
                disabled={busy}
                className={`${rowClass} text-content/50`}
                onClick={() => void run(async () => {})}
              >
                <RefreshCw className="size-3.5" strokeWidth={1.75} />
                {busy ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>
        </>
      )}
      {error && (
        <p
          role="alert"
          className="max-h-24 overflow-auto whitespace-pre-wrap border-t border-content/10 px-2.5 py-2 text-[11px] leading-4 text-red-400/90"
        >
          {error}
        </p>
      )}
    </div>
  );
}
