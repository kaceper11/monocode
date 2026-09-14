import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { forgetRemovedWorktree, loadRecents } from "../lib/recents";
import {
  isEqualOrInside,
  pathKey,
  prettyCwd,
  wslLocation,
  wslPath,
} from "../lib/paths";
import {
  getVerifiedFamilies,
  publishRepositoryFamilies,
  hiddenWorkingCopies,
  hiddenWorkingCopiesSnapshot,
  subscribeWorkingCopyPreferences,
  setWorkingCopyHidden,
  lastWorkingCopyUse,
  staleWorkingCopy,
  workingCopyAge,
  oldestWorkingCopies,
} from "../lib/repositoryFamilies";
import { notifyGitChanged } from "../lib/fs";
import {
  subscribeTaskWorkspaces,
  taskChildrenForWorkingCopy,
  taskWorkspacesSnapshot,
} from "../lib/taskWorkspaces";
import {
  bulkRemovalPlan,
  executeWorktreeRemovals,
  openBoundProcess,
  preflightWorktrees,
  removalFallbackLabel,
  removalFallbacks,
  type BulkSkip,
  type BoundProcess,
  type WorktreeSafety,
} from "../lib/worktreeRemoval";
import { WorktreeRemovalBatch } from "./WorktreeRemovalBatch";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Eye,
  Folder,
  GitBranch,
  Loader,
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
  lastUsed?: number | null;
};

/** Short status chip for a row or the detail heading — the same ordering
 * the list footer uses: availability first, then role, then use. */
function statusLabel(entry: Worktree, cwd: string, activeCwd: string) {
  return entry.missing
    ? "missing"
    : entry.prunable
      ? "stale"
      : entry.locked
        ? "locked"
        : entry.main
          ? "main"
          : pathKey(entry.path) === pathKey(cwd)
            ? "current"
            : isEqualOrInside(activeCwd, entry.path)
              ? "in use"
              : !entry.branch
                ? "detached"
                : null;
}

/** Same displayed entry — lets refresh() keep detail object identity so the
 * safety fetch effect does not refire and flash "Checking worktree…". */
function sameWorktree(a: Worktree, b: Worktree): boolean {
  return (
    a.path === b.path &&
    a.head === b.head &&
    a.branch === b.branch &&
    a.main === b.main &&
    a.locked === b.locked &&
    a.prunable === b.prunable &&
    a.missing === b.missing &&
    (a.lastUsed ?? null) === (b.lastUsed ?? null) &&
    a.users.length === b.users.length &&
    a.users.every((user, index) => user === b.users[index])
  );
}
type Ref = { name: string; commit: string };

export function WorktreePanel({
  cwd,
  onClose,
  onOpen,
  onBusyChange,
  initialBase = "",
  initialCreate = false,
  initialPath,
  initialSelect,
  initialAction,
  activeCwd = cwd,
}: {
  cwd: string;
  onClose: () => void;
  onOpen: (path: string) => void;
  onBusyChange: (busy: boolean) => void;
  initialBase?: string;
  initialCreate?: boolean;
  initialPath?: string;
  /** Mount straight into select mode with these paths checked — the stale
   * set an attention row derived, or a caller-reviewed batch. */
  initialSelect?: string[];
  /** With `initialPath`: skip the detail view and land on the reviewed
   * removal confirmation. */
  initialAction?: "remove";
  activeCwd?: string;
}) {
  const location = wslLocation(cwd);
  const rootPath = location?.path ?? cwd;
  const [entries, setEntries] = useState<Worktree[]>(() =>
    (getVerifiedFamilies().get(pathKey(cwd))?.worktrees ?? []).map((entry) => ({
      ...entry,
      users: entry.users ?? [],
    })),
  );
  const hiddenRaw = useSyncExternalStore(
    subscribeWorkingCopyPreferences,
    hiddenWorkingCopiesSnapshot,
  );
  const hidden = hiddenWorkingCopies(hiddenRaw);
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const recents = loadRecents();
  const [oldestFirst, setOldestFirst] = useState(false);
  // The manage affordance opens straight on the entry it was clicked for;
  // seeding from the published family avoids a list flash before refresh.
  const [detail, setDetail] = useState<Worktree | null>(() => {
    if (!initialPath) return null;
    const seeded = getVerifiedFamilies()
      .get(pathKey(cwd))
      ?.worktrees.find((entry) => pathKey(entry.path) === pathKey(initialPath));
    return seeded ? { ...seeded, users: seeded.users ?? [] } : null;
  });
  const [safety, setSafety] = useState<WorktreeSafety | null>(null);
  const [safetyError, setSafetyError] = useState("");
  const openedInitial = useRef(detail != null);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [base, setBase] = useState(initialBase);
  const [creating, setCreating] = useState(
    initialCreate || Boolean(initialBase),
  );
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
    processes?: BoundProcess[];
    fallbacks?: Worktree[];
    host?: string;
  } | null>(null);
  const [fallbackPath, setFallbackPath] = useState<string | null>(null);
  const [stopConfirm, setStopConfirm] = useState(false);
  // The confirmation mounts while run()'s trailing refresh still holds busy;
  // its buttons track the destructive call itself instead of that generic
  // flag, so they never flash disabled-then-enabled on open.
  const [removing, setRemoving] = useState(false);
  const [removalFailure, setRemovalFailure] = useState<string | null>(null);
  // A failed removal must stay visible across refresh()'s new detail object;
  // it clears only when a different checkout (or repository) is viewed.
  useEffect(() => {
    setRemovalFailure(null);
  }, [cwd, detail?.path]);
  // A mounted `initialAction` runs its own preflight inside the mount
  // `run` — the display-safety fetch stays quiet until it settles so the
  // detail never paints a racy "Checking…" state ahead of the confirm.
  const [actionPending, setActionPending] = useState(
    () => initialAction === "remove",
  );
  useEffect(() => {
    if (!detail || confirmation || actionPending) return;
    let cancelled = false;
    setSafety(null);
    setSafetyError("");
    void invoke<WorktreeSafety>("git_worktree_safety", {
      cwd,
      path: detail.path,
    })
      .then((value) => {
        if (!cancelled) setSafety(value);
      })
      .catch((error) => {
        if (!cancelled) setSafetyError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, detail, confirmation, actionPending]);
  const [forceReview, setForceReview] = useState<{
    token: string;
    fileCount: number;
    files: string[];
  } | null>(null);
  const [forceFiles, setForceFiles] = useState<string[] | null>(null);
  // Bulk select mode: checkboxes on each removable row, a staged plan that
  // re-preflights every target, and a summary instead of silent removal.
  const [selecting, setSelecting] = useState(() => !!initialSelect?.length);
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set((initialSelect ?? []).map(pathKey)),
  );
  const [bulk, setBulk] = useState<{
    phase: "confirm" | "removing" | "done";
    removable: WorktreeSafety[];
    skipped: BulkSkip[];
    removed: string[];
    failures: { entry: Worktree; message: string }[];
  } | null>(null);
  const pending = useRef(false);
  const selected = refs.find((ref) => ref.name === base);
  // A pending removal may switch the project under this panel; refresh must
  // query the path the panel is showing now, not the one it captured.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const refresh = async () => {
    const current = cwdRef.current;
    const [trees, branches] = await Promise.all([
      invoke<Worktree[]>("git_worktrees", { cwd: current }),
      invoke<Ref[]>("git_worktree_refs", { cwd: current }),
    ]);
    setEntries(trees);
    setDetail((shown) => {
      if (!shown) return null;
      const found = trees.find(
        (entry) => pathKey(entry.path) === pathKey(shown.path),
      );
      if (!found) return null;
      return sameWorktree(found, shown) ? shown : found;
    });
    const previous = getVerifiedFamilies();
    const family = previous.get(pathKey(current));
    if (family) {
      const next = new Map(previous);
      for (const [key, value] of next) {
        if (pathKey(value.commonDir) === pathKey(family.commonDir))
          next.delete(key);
      }
      const updated = { ...family, worktrees: trees };
      next.set(pathKey(current), updated);
      for (const tree of trees)
        if (!tree.missing && !tree.prunable)
          next.set(pathKey(tree.path), updated);
      publishRepositoryFamilies(next);
    }
    if (initialPath && !openedInitial.current) {
      openedInitial.current = true;
      setDetail(
        trees.find((entry) => pathKey(entry.path) === pathKey(initialPath)) ??
          null,
      );
    }
    setRefs(branches);
    if (initialCreate && !pendingDefaults.current) {
      pendingDefaults.current = true;
      const defaults = branches.filter((ref) =>
        /^refs\/remotes\/[^/]+\/HEAD$/.test(ref.name),
      );
      const main = trees.find((entry) => entry.main)?.branch;
      setBase(
        initialBase || (defaults.length === 1 ? defaults[0].name : main) || "",
      );
      let suggestion = "work";
      for (
        let n = 2;
        branches.some((ref) => ref.name === `refs/heads/${suggestion}`);
        n++
      )
        suggestion = `work-${n}`;
      setBranch(suggestion);
      setPath(`${rootPath}-${suggestion}`);
    }
  };
  const pendingDefaults = useRef(false);
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
    void run(async () => {
      // Land straight on the reviewed confirmation inside the mount pass —
      // one busy cycle, one refresh, no detail-view flicker.
      if (initialAction === "remove" && detail) {
        initialActionFired.current = true;
        try {
          await preflightRemove(detail);
        } finally {
          setActionPending(false);
        }
      }
    }).finally(() => {
      // An unseeded target defers to the `initialActionFired` effect —
      // release the gate so the detail/list can render. StrictMode's
      // second mount run early-returns here; it must not drop the gate
      // while the first run's preflight is still in flight.
      if (initialAction === "remove" && !initialActionFired.current)
        setActionPending(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);
  useEffect(() => {
    if (!busy && !creating && !choosingBase && !confirmation && !detail && !bulk)
      search.current?.focus();
  }, [busy, creating, choosingBase, confirmation, detail, bulk]);
  const name = query.trim();
  const visibleEntries = (
    oldestFirst ? oldestWorkingCopies(entries, recents) : entries
  ).filter((entry) =>
    `${entry.branch ?? ""} ${entry.path}`
      .toLowerCase()
      .includes(name.toLowerCase()),
  );
  const canCreate =
    name.length > 0 && !refs.some((ref) => ref.name === `refs/heads/${name}`);
  /** First non-archived task claiming each listed copy — the "· Task X" marker. */
  const taskClaims = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries) {
      const claim = taskChildrenForWorkingCopy(entry.path)[0];
      if (claim) map.set(pathKey(entry.path), claim.task.name);
    }
    return map;
    // tasksRaw changes on every store write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, tasksRaw]);
  const prepareCreate = () => {
    setBranch(name);
    setPath(`${rootPath}-${name.replace(/\//g, "-")}`);
    const current = entries.find(
      (entry) => pathKey(entry.path) === pathKey(cwd),
    )?.branch;
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
  const openEntry = (entry: Worktree) => {
    if (entry.users.length) {
      setConfirmation({ entry, action: "open" });
      return;
    }
    onOpen(entry.path);
    onClose();
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
        path: location ? wslPath(location.distribution, path) : path,
      });
      notifyGitChanged(cwd);
    }).then(() => {
      if (created) {
        onOpen(created);
        onClose();
      }
    });
  };
  const family = getVerifiedFamilies().get(pathKey(cwd));
  // The panel is family-scoped and `cwd` may be any member — resolve the
  // repository root from the family's main checkout so the context line
  // always names the repository, not whichever copy opened the panel.
  const repoRoot =
    family?.worktrees.find((entry) => entry.main)?.path ??
    family?.checkout ??
    cwd;
  const repoName = repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
  /** Fresh preflight for one removal: identity, file state, target-bound
   * processes — then the reviewed confirmation. Shared by the row/detail
   * actions and the mounted `initialAction`. */
  const preflightRemove = async (entry: Worktree) => {
    setForceReview(null);
    setForceFiles(null);
    setStopConfirm(false);
    setRemoving(false);
    setRemovalFailure(null);
    const current = await invoke<WorktreeSafety>("git_worktree_safety", {
      cwd,
      path: entry.path,
    });
    if (current.entry.locked)
      throw new Error(
        `This working copy is locked (${current.entry.locked}). Unlock it with Git, then retry.`,
      );
    const fallbacks = removalFallbacks(entry.path, current.siblings, recents);
    if (current.dirty) {
      const review = await invoke<NonNullable<typeof forceReview>>(
        "git_worktree_removal_preview",
        { cwd, path: entry.path, includeFiles: false },
      );
      setForceReview(review);
    }
    setFallbackPath(fallbacks[0]?.path ?? null);
    setConfirmation({
      entry: current.entry,
      action: "remove",
      processes: current.processes,
      fallbacks,
      host: current.host,
    });
  };
  const startRemove = (entry: Worktree) =>
    void run(() => preflightRemove(entry));
  // When `initialPath` seeds no cached entry, the mount refresh finds it
  // first — the action then fires once the detail and a free `pending`
  // slot exist. The guard must read the ref: `busy` is still false during
  // the mount effect pass.
  const initialActionFired = useRef(false);
  useEffect(() => {
    if (
      initialAction !== "remove" ||
      !detail ||
      pending.current ||
      initialActionFired.current
    )
      return;
    initialActionFired.current = true;
    startRemove(detail);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on the seeded detail
  }, [detail, busy]);
  const confirmRemove = confirmation?.action === "remove";
  const confirmProcesses = confirmation?.processes ?? [];
  const confirmFallbacks = confirmation?.fallbacks ?? [];
  /** A row can join a batch only when it isn't protected outright — the
   * active project context never moves during bulk removal, so an entry
   * containing it is handled by the single-removal switch flow instead. */
  const bulkSelectable = (entry: Worktree) =>
    !entry.main &&
    !entry.missing &&
    !entry.prunable &&
    // Detached-HEAD entries can never join a batch — the plan always
    // skips them for individual review.
    !!entry.branch &&
    pathKey(entry.path) !== pathKey(cwd) &&
    !isEqualOrInside(activeCwd, entry.path);
  const toggleChecked = (entry: Worktree) => {
    const key = pathKey(entry.path);
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  /** Batch-check the selectable rows matching a predicate — quick-select
   * can never arm a protected or in-use row. */
  const selectMatching = (match: (entry: Worktree) => boolean) =>
    setChecked(
      new Set(
        entries
          .filter((entry) => bulkSelectable(entry) && match(entry))
          .map((entry) => pathKey(entry.path)),
      ),
    );
  const checkedCount = entries.filter((entry) =>
    checked.has(pathKey(entry.path)),
  ).length;
  // Bulk-select works on the filtered list, so a search can stage a batch.
  const selectableVisible = visibleEntries.filter(bulkSelectable);
  const allVisibleChecked =
    selectableVisible.length > 0 &&
    selectableVisible.every((entry) => checked.has(pathKey(entry.path)));
  const toggleAllVisible = () =>
    setChecked((current) => {
      const next = new Set(current);
      for (const entry of selectableVisible) {
        if (allVisibleChecked) next.delete(pathKey(entry.path));
        else next.add(pathKey(entry.path));
      }
      return next;
    });
  // Stable family context for the batch: a just-removed path can never
  // serve as cwd for the next call. Prefer the surviving main checkout —
  // never a missing or prunable registration and never a removal target
  // (a seeded check can bypass `bulkSelectable`'s cwd guard).
  const removalContext = (excluded?: ReadonlySet<string>) =>
    entries.find(
      (entry) =>
        entry.main &&
        !entry.missing &&
        !entry.prunable &&
        !excluded?.has(pathKey(entry.path)),
    )?.path ??
    entries.find(
      (entry) =>
        !entry.missing &&
        !entry.prunable &&
        !excluded?.has(pathKey(entry.path)),
    )?.path ??
    cwdRef.current;
  const beginBulkRemove = () =>
    void run(async () => {
      // Seeded checks bypass `bulkSelectable` — re-apply the two guards
      // preflight cannot verify: the panel context and the active context
      // can never join a batch (a removal needs a switch-away).
      const targets = entries.filter(
        (entry) =>
          checked.has(pathKey(entry.path)) &&
          pathKey(entry.path) !== pathKey(cwd) &&
          !isEqualOrInside(activeCwd, entry.path),
      );
      const context = removalContext(checked);
      // A worktree that changed state since the last refresh (or is already
      // unregistered) fails preflight — skip it into the review list rather
      // than aborting the whole batch.
      const { results, failed } = await preflightWorktrees(
        targets,
        () => context,
      );
      const plan = bulkRemovalPlan(results.map((row) => row.safety));
      plan.skipped.push(...failed);
      if (!plan.removable.length && !plan.skipped.length) return;
      setBulk({ phase: "confirm", ...plan, removed: [], failures: [] });
    });
  /** Hand a skipped/failed bulk entry back to the single-entry flow. Leftover
   * work (dirty files, bound processes) goes straight to the guarded removal
   * confirmation — missing, prunable, locked or detached entries still land on
   * the detail view where their recovery guidance lives. */
  const reviewEntry = (skip: BulkSkip | { entry: Worktree }) => {
    const { entry } = skip;
    const safety = "safety" in skip ? skip.safety : undefined;
    // The batch stays staged underneath — backing out of the detail or the
    // guarded confirmation returns to the remaining rows. The detail always
    // mounts so a failed removal has somewhere to report.
    setDetail(entry);
    if (safety && (safety.dirty || safety.processes.length))
      startRemove(entry);
  };
  const confirmBulkRemove = () =>
    void run(async () => {
      if (!bulk) return;
      const plan = bulk;
      setBulk({ ...plan, phase: "removing" });
      const context = removalContext(
        new Set(plan.removable.map((safety) => pathKey(safety.entry.path))),
      );
      const { removed, failures } = await executeWorktreeRemovals({
        removable: plan.removable,
        contextFor: () => context,
        fallbackFor: (path, removedPaths) =>
          removalFallbacks(
            path,
            entries.filter(
              (entry) =>
                !removedPaths.some(
                  (removed) => pathKey(removed) === pathKey(entry.path),
                ),
            ),
            recents,
          )[0]?.path ?? context,
      });
      if (removed.length) notifyGitChanged(cwdRef.current);
      setChecked(new Set());
      setSelecting(false);
      if (!failures.length && !plan.skipped.length) {
        // Clean sweep — same as single removal, the panel is done.
        setBulk(null);
        onClose();
        return;
      }
      setBulk({ ...plan, phase: "done", removed, failures });
    });
  // Removing the selected worktree — or a worktree containing the selected
  // project — switches the visible context first.
  const confirmSwitch =
    confirmRemove &&
    !!confirmation &&
    isEqualOrInside(activeCwd, confirmation.entry.path);
  const confirmFallback =
    confirmFallbacks.find(
      (candidate) => pathKey(candidate.path) === pathKey(fallbackPath ?? ""),
    ) ?? confirmFallbacks[0];
  const processRow = (process: BoundProcess) => (
    <div
      key={`${process.kind}:${process.id}`}
      className="flex items-center gap-2 text-[11px] text-content/70"
    >
      <span
        className="min-w-0 flex-1 truncate"
        title={prettyCwd(process.cwd)}
      >
        {process.label}
      </span>
      <button
        type="button"
        className="shrink-0 rounded border border-content/10 px-1.5 py-0.5 hover:bg-content/5"
        onClick={() => openBoundProcess(process)}
      >
        Open
      </button>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[12px]" aria-busy={busy}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
        {bulk && !confirmation && !detail ? (
          <WorktreeRemovalBatch
            phase={bulk.phase}
            removable={bulk.removable}
            skipped={bulk.skipped}
            removed={bulk.removed}
            failures={bulk.failures}
            busy={busy}
            onCancel={() => setBulk(null)}
            onConfirm={confirmBulkRemove}
            onReview={reviewEntry}
            onDone={onClose}
          />
        ) : confirmation ? (
        <div className="space-y-2 px-3 py-2.5">
          <p className="flex items-center gap-2 font-medium">
            {confirmRemove && (
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-600">
                <Trash2 className="size-3.5" aria-hidden="true" />
              </span>
            )}
            {confirmRemove
              ? forceReview
                ? "Permanently remove worktree?"
                : confirmSwitch && confirmFallback
                  ? `Switch to ${removalFallbackLabel(confirmFallback, family)} and remove ${confirmation.entry.branch?.replace("refs/heads/", "")}?`
                  : "Remove worktree?"
              : "Share this worktree?"}
          </p>
          <p className="truncate text-content/70">
            Repository: {prettyCwd(cwd)}
            {confirmation.host ? ` · ${confirmation.host}` : ""}
          </p>
          <p className="truncate font-mono">
            {confirmation.entry.branch?.replace("refs/heads/", "")} ·{" "}
            {confirmation.entry.head.slice(0, 10)}
          </p>
          <p className="break-all text-[11px] text-content/50">
            {prettyCwd(confirmation.entry.path)}
          </p>
          {confirmRemove && confirmSwitch && (
            <div className="space-y-1">
              {confirmFallback ? (
                <p className="truncate text-content/70">
                  Switches to {removalFallbackLabel(confirmFallback, family)} ·{" "}
                  <span className="text-content/50">
                    {prettyCwd(confirmFallback.path)}
                  </span>
                </p>
              ) : (
                <p className="text-[11px] text-red-400 [.theme-light_&]:text-red-700">
                  No other checkout can receive this project — the selected
                  worktree is the only usable one.
                </p>
              )}
              {confirmFallbacks.length > 1 && (
                <details className="text-[11px] text-content/70">
                  <summary className="cursor-pointer">
                    Choose another checkout
                  </summary>
                  {confirmFallbacks.map((candidate) => (
                    <button
                      key={candidate.path}
                      type="button"
                      className="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-left hover:bg-content/5"
                      onClick={() => setFallbackPath(candidate.path)}
                    >
                      <Check
                        className={`size-3 shrink-0 ${confirmFallback && pathKey(candidate.path) === pathKey(confirmFallback.path) ? "" : "opacity-0"}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {removalFallbackLabel(candidate, family)}
                      </span>
                      <span className="max-w-1/2 truncate text-content/40">
                        {prettyCwd(candidate.path)}
                      </span>
                    </button>
                  ))}
                </details>
              )}
            </div>
          )}
          {confirmRemove && confirmProcesses.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-content/80">
                Running in this checkout
              </p>
              {confirmProcesses.map(processRow)}
              <p className="text-[11px] text-content/50">
                Editors and agents outside MonoCode are not listed and keep
                running.
              </p>
            </div>
          )}
          <p className="text-[11px] leading-4 text-content/60">
            {confirmRemove
              ? forceReview
                ? `All files in this working copy, including uncommitted, untracked and ignored files, will be permanently deleted. Reviewed ${forceReview.fileCount} entries. The branch and conversations stay.`
                : stopConfirm
                  ? `Work running in this checkout will be stopped (${confirmProcesses.length} ${confirmProcesses.length === 1 ? "process" : "processes"} now, re-checked before removal), then the working copy is removed. This cannot be undone for running work.`
                  : "The branch and conversations stay. Files and running work are checked again before removal."
              : "Other conversations use this folder. Their agents can change the same files."}
          </p>
          {confirmation.action === "remove" && forceReview && (
            <details
              onToggle={(event) => {
                if (!event.currentTarget.open || forceFiles || busy) return;
                void run(async () => {
                  const latest = await invoke<typeof forceReview>(
                    "git_worktree_removal_preview",
                    { cwd, path: confirmation.entry.path, includeFiles: true },
                  );
                  if (latest.token !== forceReview.token) {
                    setForceReview(null);
                    setConfirmation(null);
                    throw new Error(
                      "Files changed; review again before force removal.",
                    );
                  }
                  setForceFiles(latest.files);
                });
              }}
              className="max-h-32 overflow-auto text-[11px] text-content/70"
            >
              <summary>Review files (first 100)</summary>
              {forceFiles?.map((file) => (
                <p key={file} className="break-all">
                  {file}
                </p>
              ))}
            </details>
          )}
          {confirmation.entry.users.length > 0 && (
            <details className="max-h-24 overflow-auto text-[11px] text-content/50">
              <summary>Existing conversations</summary>
              {confirmation.entry.users.map((user) => (
                <p key={user}>{user}</p>
              ))}
            </details>
          )}
          <div className="flex justify-end gap-2 border-t border-content/10 pt-2.5">
            <button
              type="button"
              disabled={removing}
              className="rounded-md border border-content/10 px-2.5 py-1.5 text-content/70 outline-none hover:bg-content/5 focus-visible:ring-2 focus-visible:ring-content/30 disabled:opacity-40"
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={
                removing || (confirmRemove && confirmSwitch && !confirmFallback)
              }
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background-base disabled:opacity-40 ${confirmRemove ? "bg-content/5 text-red-400 hover:bg-content/10 [.theme-light_&]:text-red-700 focus-visible:ring-red-500" : "bg-content/10 hover:bg-content/15 focus-visible:ring-content/30"}`}
              onClick={() => {
                const { entry, action } = confirmation;
                if (action === "open") {
                  onOpen(entry.path);
                  onClose();
                  return;
                }
                // Stopping bound processes needs its own explicit click.
                if (confirmProcesses.length > 0 && !stopConfirm) {
                  setStopConfirm(true);
                  return;
                }
                const fallback = confirmFallback;
                void run(async () => {
                  setRemoving(true);
                  if (confirmSwitch) {
                    if (!fallback) {
                      throw new Error(
                        "No surviving checkout can receive this project.",
                      );
                    }
                    // Move only the visible context; removal still validates
                    // identity, files and processes itself.
                    onOpen(fallback.path);
                  }
                  try {
                    await invoke("git_worktree_remove", {
                      cwd: confirmSwitch && fallback ? fallback.path : cwd,
                      path: entry.path,
                      head: entry.head,
                      reviewed: forceReview?.token ?? null,
                      stopProcesses:
                        confirmProcesses.length > 0 ? true : null,
                    });
                  } catch (error) {
                    // The checkout may or may not have been removed — the
                    // refresh below reports the true state; the detail view
                    // offers reopen or review-and-retry.
                    setConfirmation(null);
                    setForceReview(null);
                    setStopConfirm(false);
                    setRemoving(false);
                    setRemovalFailure(String(error));
                    return;
                  }
                  forgetRemovedWorktree(
                    entry.path,
                    confirmSwitch && fallback
                      ? fallback.path
                      : (entries.find(
                          (tree) =>
                            tree.main && !tree.missing && !tree.prunable,
                        )?.path ?? removalContext()),
                  );
                  setWorkingCopyHidden(entry.path, false);
                  notifyGitChanged(cwdRef.current);
                  // A staged batch resumes minus the just-removed row —
                  // with nothing left the whole flow is done. Outside a
                  // batch, a completed removal closes the panel outright.
                  if (bulk) {
                    const removedPath = pathKey(entry.path);
                    const notRemoved = (row: { entry: { path: string } }) =>
                      pathKey(row.entry.path) !== removedPath;
                    const remaining = {
                      ...bulk,
                      removable: bulk.removable.filter(notRemoved),
                      skipped: bulk.skipped.filter(notRemoved),
                      failures: bulk.failures.filter(notRemoved),
                      removed: [...bulk.removed, entry.path],
                    };
                    const left =
                      remaining.removable.length +
                      remaining.skipped.length +
                      remaining.failures.length;
                    setBulk(left ? remaining : null);
                    setChecked((current) => {
                      const next = new Set(current);
                      next.delete(removedPath);
                      return next;
                    });
                    setConfirmation(null);
                    if (!left) onClose();
                  } else {
                    onClose();
                  }
                });
              }}
            >
              {confirmRemove && (
                <Trash2 className="size-3.5" aria-hidden="true" />
              )}
              {confirmRemove
                ? confirmProcesses.length > 0
                  ? stopConfirm
                    ? forceReview
                      ? "Stop and permanently remove"
                      : "Stop and remove"
                    : "Stop and remove…"
                  : forceReview
                    ? "Permanently remove"
                    : confirmSwitch
                      ? "Switch and remove"
                      : "Remove"
                : "Open conversation"}
            </button>
          </div>
        </div>
      ) : actionPending && initialPath ? (
        <div className="space-y-2 px-3 py-2.5">
          <p className="flex items-center gap-2 text-content/60">
            <Loader
              className="size-3.5 shrink-0 animate-spin text-content/50"
              aria-hidden="true"
            />
            Checking worktree…
          </p>
        </div>
      ) : detail ? (
        <div className="space-y-2 px-3 py-2.5">
          <button
            type="button"
            className={`-ml-2 ${rowClass}`}
            disabled={busy}
            onClick={() => setDetail(null)}
          >
            <ArrowLeft className="size-3.5" />
            {repoName}
          </button>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-medium">
              {detail.branch?.replace("refs/heads/", "") ??
                "Detached worktree"}
            </p>
            {statusLabel(detail, cwd, activeCwd) ? (
              <span className="shrink-0 rounded bg-content/8 px-1.5 py-0.5 text-[10px] text-content/60">
                {statusLabel(detail, cwd, activeCwd)}
              </span>
            ) : null}
          </div>
          <div className="space-y-1 border-y border-content/10 py-2 text-[11px]">
            <div className="flex items-baseline gap-3">
              <span className="w-14 shrink-0 text-content/45">Path</span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-content/75"
                title={prettyCwd(detail.path)}
              >
                {prettyCwd(detail.path)}
              </span>
            </div>
            <div className="flex items-baseline gap-3">
              <span className="w-14 shrink-0 text-content/45">Commit</span>
              <span className="min-w-0 flex-1 truncate font-mono text-content/75">
                {detail.head.slice(0, 10)}
              </span>
            </div>
            <div
              className="flex items-baseline gap-3"
              title="Latest recorded conversation update or project open in MonoCode. External activity is not tracked."
            >
              <span className="w-14 shrink-0 text-content/45">Activity</span>
              <span className="min-w-0 flex-1 truncate text-content/75">
                {workingCopyAge(lastWorkingCopyUse(detail, recents))} in
                MonoCode
              </span>
            </div>
            {taskClaims.get(pathKey(detail.path)) ? (
              <div className="flex items-baseline gap-3">
                <span className="w-14 shrink-0 text-content/45">Task</span>
                <span className="min-w-0 flex-1 truncate text-content/75">
                  {taskClaims.get(pathKey(detail.path))}
                </span>
              </div>
            ) : null}
          </div>
          {!safety && (
            <p className="text-content/70">
              {detail.missing || detail.prunable
                ? "Unavailable checkout"
                : safetyError || "Checking worktree…"}
            </p>
          )}
          {safety && safety.processes.length > 0 && (
            <div className="space-y-1">
              <p className="text-content/70">
                {safety.processes.length === 1
                  ? "1 process runs"
                  : `${safety.processes.length} processes run`}{" "}
                in this checkout. Removal offers to stop them, or open and
                close them first.
              </p>
              {safety.processes.map(processRow)}
            </div>
          )}
          {removalFailure && (
            <div className="space-y-1.5 rounded-md border border-red-500/30 bg-red-500/5 p-2">
              <p className="break-words text-[11px] text-red-400 [.theme-light_&]:text-red-700">
                {removalFailure}
              </p>
              <div className="flex gap-2">
                {!detail.missing && !detail.prunable && (
                  <button
                    type="button"
                    className="rounded-md border border-content/10 px-2 py-1 text-[11px] text-content/70 hover:bg-content/5"
                    onClick={() => {
                      onOpen(detail.path);
                      onClose();
                    }}
                  >
                    Reopen target
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-md border border-content/10 px-2 py-1 text-[11px] text-content/70 hover:bg-content/5"
                  onClick={() => startRemove(detail)}
                >
                  Review and retry
                </button>
              </div>
            </div>
          )}
          <details className="text-[11px] text-content/70">
            <summary className="cursor-pointer">
              {detail.missing || detail.prunable || detail.locked
                ? "Recovery"
                : "Details"}
            </summary>
            {(detail.missing || detail.prunable) && (
              <p className="pt-1">
                Restore the original folder, or run Git worktree repair from a
                surviving checkout, then Retry. No metadata is pruned.
              </p>
            )}
            {detail.locked && (
              <p className="pt-1">
                {detail.locked}. Unlock with Git before removal.
              </p>
            )}
            <p className="pt-1">
              Activity covers MonoCode only. Hide keeps files and conversations;
              restore it from this list.
            </p>
          </details>
          {!detail.main && (
            <button
              type="button"
              disabled={busy}
              className={rowClass}
              onClick={() => {
                try {
                  setWorkingCopyHidden(
                    detail.path,
                    !hidden.some(
                      (path) => pathKey(path) === pathKey(detail.path),
                    ),
                  );
                } catch (err) {
                  setError(String(err));
                }
              }}
            >
              <Eye className="size-3.5" />
              {hidden.some((path) => pathKey(path) === pathKey(detail.path))
                ? "Show in project"
                : "Hide from project"}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            className={rowClass}
            onClick={() =>
              void run(async () => {
                setDetail({ ...detail });
                notifyGitChanged(cwd);
              })
            }
          >
            <RefreshCw className="size-3.5" />
            {safetyError || detail.missing || detail.prunable
              ? "Retry"
              : "Refresh status"}
          </button>
          <button
            type="button"
            disabled={
              busy ||
              detail.main ||
              !detail.branch ||
              detail.missing ||
              !!detail.locked ||
              !!detail.prunable ||
              !safety
            }
            className={`${rowClass} text-red-400! [.theme-light_&]:text-red-700! focus-visible:ring-2 focus-visible:ring-red-500`}
            onClick={() => startRemove(detail)}
          >
            <Trash2 className="size-3.5" />
            Remove Git worktree…
          </button>
          {detail.main && (
            <p className="text-[11px] text-content/70">
              The main checkout is protected. Use the project menu to archive
              its app association.
            </p>
          )}
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
          <p
            className="truncate px-2.5 py-2 text-content/50"
            title={prettyCwd(repoRoot)}
          >
            Repository · {repoName}
          </p>
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
              <span className="text-content/50">Base</span>
              <span className="min-w-0 flex-1 truncate font-mono">
                {selectedName || "Choose branch"}
              </span>
              <ChevronRight className="size-3 shrink-0 text-content/40" />
            </button>
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
                  if (
                    !path ||
                    path === `${rootPath}-${branch.replace(/\//g, "-")}`
                  )
                    setPath(
                      `${rootPath}-${e.target.value.replace(/\//g, "-")}`,
                    );
                }}
              />
            </label>
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
          <p
            className="flex items-center gap-1.5 truncate px-2.5 pt-2 text-[10px] text-content/50"
            title={prettyCwd(repoRoot)}
          >
            <Folder
              className="size-3 shrink-0 text-content/40"
              strokeWidth={1.75}
            />
            <span className="truncate">
              {repoName} · {entries.length}{" "}
              {entries.length === 1 ? "worktree" : "worktrees"}
            </span>
          </p>
          <label className="mt-0.5 flex items-center gap-2 border-b border-content/10 px-2 py-2 text-content/50">
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
                  if (selecting) {
                    if (entry && bulkSelectable(entry)) toggleChecked(entry);
                  } else if (entry && !entry.missing && !entry.prunable)
                    openEntry(entry);
                  else if (!entry && canCreate) prepareCreate();
                }
              }}
            />
          </label>
          <div className="flex items-center justify-between px-2.5 pt-2 text-[10px] text-content/60">
            <span>
              {selecting ? "Select worktrees to remove" : "Last used"}
            </span>
            <div className="flex items-center gap-1">
              {selecting ? (
                <button
                  type="button"
                  disabled={busy || !selectableVisible.length}
                  className="rounded px-1.5 py-1 hover:bg-content/10 disabled:opacity-40"
                  onClick={toggleAllVisible}
                >
                  {allVisibleChecked ? "None" : "All"}
                </button>
              ) : null}
              <button
                type="button"
                disabled={busy}
                aria-pressed={selecting}
                className={`rounded px-1.5 py-1 hover:bg-content/10 ${selecting ? "text-content" : ""}`}
                onClick={() => {
                  setSelecting((value) => !value);
                  setChecked(new Set());
                }}
              >
                {selecting ? "Done" : "Select"}
              </button>
              <button
                type="button"
                disabled={busy}
                aria-pressed={oldestFirst}
                className="rounded px-1.5 py-1 hover:bg-content/10"
                onClick={() => {
                  setOldestFirst(!oldestFirst);
                  setActiveIndex(0);
                }}
              >
                {oldestFirst ? "Oldest first ✓" : "Oldest first"}
              </button>
            </div>
          </div>
          <div className="px-1.5 py-1.5">
            {visibleEntries.map((entry, index) => {
              const selectable = bulkSelectable(entry);
              const isChecked = checked.has(pathKey(entry.path));
              return (
              <div key={entry.path} className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={
                    busy ||
                    (selecting
                      ? !selectable
                      : entry.missing || !!entry.prunable)
                  }
                  title={`${prettyCwd(entry.path)}${entry.users.length ? ` · ${entry.users.length} conversations` : ""}`}
                  aria-pressed={selecting ? isChecked : undefined}
                  className={`${rowClass} ${index === activeIndex ? "bg-content/10" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() =>
                    selecting ? toggleChecked(entry) : openEntry(entry)
                  }
                >
                  {selecting ? (
                    <span
                      aria-hidden="true"
                      className={`grid size-4 shrink-0 place-items-center rounded border transition-colors ${
                        isChecked
                          ? "border-content/60 bg-content/10 text-content"
                          : "border-content/25 text-transparent"
                      }`}
                    >
                      <Check className="size-3" strokeWidth={2} />
                    </span>
                  ) : pathKey(entry.path) === pathKey(cwd) ? (
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
                    <span className="block truncate font-sans text-[10px] text-content/70">
                      {workingCopyAge(lastWorkingCopyUse(entry, recents))}
                      {taskClaims.get(pathKey(entry.path))
                        ? ` · Task ${taskClaims.get(pathKey(entry.path))}`
                        : ""}
                      {hidden.some(
                        (path) => pathKey(path) === pathKey(entry.path),
                      )
                        ? " · Hidden"
                        : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-content/40">
                    {statusLabel(entry, cwd, activeCwd)}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Manage worktree ${entry.branch?.replace("refs/heads/", "") ?? entry.path}`}
                  title="Worktree details and cleanup"
                  className="shrink-0 rounded p-1 text-content/50 hover:bg-content/10"
                  onClick={() => setDetail(entry)}
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
              );
            })}
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
      {selecting && !bulk && !detail && !creating && !choosingBase && !confirmation ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-content/10 px-3 py-2">
          <span className="min-w-0 flex-1 text-[11px] text-content/50">
            {checkedCount} selected
          </span>
          <button
            type="button"
            disabled={busy}
            className="rounded px-1.5 py-1 text-[11px] text-content/60 hover:bg-content/10 disabled:opacity-40"
            onClick={() =>
              selectMatching((entry) =>
                staleWorkingCopy(entry, lastWorkingCopyUse(entry, recents)),
              )
            }
          >
            Stale
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-md border border-content/10 px-2 py-1 text-[11px] text-content/70 hover:bg-content/5 disabled:opacity-40"
            onClick={() => {
              setSelecting(false);
              setChecked(new Set());
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !checkedCount}
            className="inline-flex items-center gap-1.5 rounded-md bg-content/5 px-2 py-1 text-[11px] font-medium text-red-400 hover:bg-content/10 disabled:opacity-40 [.theme-light_&]:text-red-700"
            onClick={beginBulkRemove}
          >
            <Trash2 className="size-3" aria-hidden="true" />
            Remove…
          </button>
        </div>
      ) : null}
    </div>
  );
}
