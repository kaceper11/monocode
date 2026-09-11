import { Select } from "./Select";
import { deliveryProvider, saveDeliveryProvider, repositoryProvider, openGitHubDelivery, DELIVERY_PROVIDERS_CHANGED, type DeliveryProvider } from "../lib/deliveryProviders";
import { loadAzurePrAssociations, AZURE_PR_ASSOCIATIONS_CHANGED } from "../lib/azureRepos";
import { loadCiSources, ciState, ciContext, AZURE_CI_SOURCES_CHANGED } from "../lib/azurePipelines";
import type { DeliveryTabSource } from "../lib/layout";
import { contextFromChanges, requestAgentContext } from "../lib/agentContext";
import {
  loadTaskWorkspaces,
  projectForTask,
  subscribeTaskWorkspaces,
  taskWorkspacesSnapshot,
} from "../lib/taskWorkspaces";
import { projectName } from "../lib/paths";
import { Popover } from "./Popover";
import { ContextCheckbox } from "./InboxContextPicker";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  CircleDashed,
  SquarePlus,
  ChevronDown,
  Task,
  X,
  ChevronRight,
  CloudUpload,
  ExternalLink,
  FileDiff,
  FolderTree,
  GitBranch,
  GitPullRequest,
  ListBullet,
  Loader,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  WandSparkles,
} from "./icons";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { FileTypeIcon } from "./FileTypeIcon";
import {
  GitHistoryGraph,
  GraphResizeSash,
  GRAPH_PANEL_DEFAULT,
  GRAPH_PANEL_MIN,
  loadGraphPanelHeight,
  saveGraphPanelHeight,
} from "./GitHistoryGraph";
import {
  basename,
  gitCommit,
  gitDiffIndex,
  gitDiscardAll,
  gitDiscardFile,
  gitPrCreate,
  gitPrStatus,
  gitPush,
  gitStageAll,
  gitStageFile,
  gitSync,
  gitUnstageAll,
  gitUnstageFile,
  notifyGitChanged,
  subscribeGitChanged,
  type GitChangedFile,
  type GitDiffIndex,
  type GitFileDiffKind,
  type GitHistoryCommit,
  type GitPr,
} from "../lib/fs";
import type { HarnessId } from "../lib/session";
import {
  loadChangesView,
  saveChangesView,
  type ChangesView,
} from "../lib/appearance";
import { generateCommitMessage, generatePrContent } from "../lib/harness";
import { invalidateWatchedFiles } from "../lib/fileWatch";
import { MOD } from "../lib/platform";
import { applyProjectDiffStats } from "../hooks/useProjectDiffStats";
import { useLockOverscroll } from "../hooks/useLockOverscroll";

const GIT_POLL_MS = 2000;

function confirmNative(message: string, okLabel?: string): Promise<boolean> {
  return ask(message, {
    title: "MonoCode",
    kind: "warning",
    ...(okLabel ? { okLabel } : {}),
  });
}

let stagedOpen = true;
let changesOpen = true;
let graphOpen = true;
let changesView: ChangesView = loadChangesView();
/** Folders the user collapsed in tree view, keyed `<kind>:<dir>`. */
const collapsedDirs = new Set<string>();
const indexByCwd = new Map<string, GitDiffIndex>();
const prByCwd = new Map<string, GitPr | null>();
const EMPTY_FILES: GitChangedFile[] = [];

type Props = {
  sourceSessionId?: string;
  cwd: string;
  enabled: boolean;
  textHarness?: HarnessId;
  selectedPath?: string;
  selectedKind?: GitFileDiffKind;
  selectedSha?: string;
  onOpenFile: (path: string, kind: GitFileDiffKind) => void;
  onOpenDelivery?: (cwd: string, source: DeliveryTabSource) => void;
  onOpenAllChanges: () => void;
  onOpenCommit: (commit: GitHistoryCommit) => void;
};

export function GitChangesPanel({
  sourceSessionId,
  cwd,
  enabled,
  textHarness,
  selectedPath,
  selectedKind,
  selectedSha,
  onOpenFile,
  onOpenAllChanges,
  onOpenDelivery,
  onOpenCommit,
}: Props) {
  const { index, patch } = useDiffIndex(cwd, enabled);
  const files = index?.files ?? EMPTY_FILES;
  const [, refreshDelivery] = useState(0);
  useEffect(() => {
    const refresh = () => refreshDelivery(value => value + 1);
    window.addEventListener(AZURE_PR_ASSOCIATIONS_CHANGED, refresh);
    window.addEventListener(AZURE_CI_SOURCES_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener(DELIVERY_PROVIDERS_CHANGED, refresh);
    return () => {
      window.removeEventListener(AZURE_PR_ASSOCIATIONS_CHANGED, refresh);
      window.removeEventListener(AZURE_CI_SOURCES_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(DELIVERY_PROVIDERS_CHANGED, refresh);
    };
  }, []);
  const prs = loadAzurePrAssociations(cwd, index?.branch ?? "", sourceSessionId);
  const pipelines = loadCiSources(cwd, index?.branch ?? "", sourceSessionId);

  const [repository, setRepository] = useState<{cwd: string; branch: string; provider?: DeliveryProvider}>();
  const [choosingProviders, setChoosingProviders] = useState(false);
  const [deliveryError, setDeliveryError] = useState("");
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const deliveryGeneration = useRef(0);
  const deliveryPending = useRef(false);
  useEffect(() => {
    const generation = ++deliveryGeneration.current;
    setRepository(undefined);
    setDeliveryError("");
    setDeliveryBusy(false);
    deliveryPending.current = false;
    if (enabled && index?.branch) void ciContext(cwd).then(context => {
      if (generation === deliveryGeneration.current && context?.branch === index.branch)
        setRepository({cwd, branch: context.branch, provider: repositoryProvider(context.remotes, index.remote)});
    }).catch(() => { /* Explicit provider selection remains available. */ });
    return () => { deliveryGeneration.current++; };
  }, [cwd, index?.branch, index?.remote, sourceSessionId, enabled]);
  const defaultProvider = repository?.cwd === cwd && repository.branch === index?.branch ? repository.provider : undefined;
  const providerFor = (kind: "pr" | "ci") => deliveryProvider(cwd, index?.branch ?? "", sourceSessionId, kind)
    ?? ((kind === "pr" ? prs.length : pipelines.length) ? "azure" : defaultProvider);
  const openDelivery = async (kind: "pr" | "ci") => {
    const provider = providerFor(kind);
    if (!provider) { setChoosingProviders(true); return; }
    if (deliveryPending.current) return;
    deliveryPending.current = true;
    const generation = deliveryGeneration.current;
    setDeliveryBusy(true); setDeliveryError("");
    try {
      if (provider === "github") await openGitHubDelivery(cwd, kind, () => generation === deliveryGeneration.current);
      else onOpenDelivery?.(cwd, {kind, branch: index?.branch ?? "", sourceSessionId});
    } catch (error) { if (generation === deliveryGeneration.current) setDeliveryError(String(error instanceof Error ? error.message : error)); }
    finally { if (generation === deliveryGeneration.current) { deliveryPending.current = false; setDeliveryBusy(false); } }
  };

  const paneRef = useRef<HTMLDivElement>(null);
  const [graphHeight, setGraphHeight] = useState(loadGraphPanelHeight);
  const [graphExpanded, setGraphExpanded] = useState(graphOpen);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane || pane.clientHeight < GRAPH_PANEL_MIN + 160) return;
    const max = pane.clientHeight - 160;
    if (graphHeight > max) {
      setGraphHeight(max);
      saveGraphPanelHeight(max);
    }
  }, [graphHeight]);

  if (!cwd || cwd === "~") {
    return (
      <p className="px-3 py-2 text-[12px] text-content/50">No project folder</p>
    );
  }

  return (
    <div
      ref={paneRef}
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-content/10 px-3">
        <span className="text-[12px] font-medium text-content">Changes</span>
        {index?.branch ? (
          <span className="ml-auto flex min-w-0 items-center gap-1 text-[11px] text-content/50">
            <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 truncate">{index.branch}</span>
            {index.ahead > 0 ? (
              <span className="shrink-0 tabular-nums text-content/40">
                ↑{index.ahead}
              </span>
            ) : null}
            {index.behind > 0 ? (
              <span className="shrink-0 tabular-nums text-content/40">
                ↓{index.behind}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="ml-auto" />
        )}
      </header>
      <div className="shrink-0 border-b border-content/10 py-1">
        {(
          [
            ["pr", "Pull requests"],
            ["ci", "CI"],
          ] as const
        ).map(([kind, label]) => {
          const provider = providerFor(kind);
          const providerLabel = provider === "github" ? (kind === "pr" ? "GitHub" : "GitHub checks") : provider === "azure" ? (kind === "pr" ? "Azure Repos" : "Azure Pipelines") : "Choose provider";
          const linked = provider === "azure";
          return (
          <button
            key={kind}
            type="button"
            aria-label={label}
            disabled={!enabled || !index || deliveryBusy || (provider === "azure" && !onOpenDelivery)}
            className="group flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-content/70 hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-40"
            onClick={() => void openDelivery(kind)}
          >
            {kind === "pr" ? (
              <GitPullRequest
                className="size-3.5 shrink-0 text-content/45"
                strokeWidth={1.75}
              />
            ) : (
              <CircleDashed
                className="size-3.5 shrink-0 text-content/45"
                strokeWidth={1.75}
              />
            )}
            <span className="min-w-0 flex-1">
            <span className="block truncate" title={linked ? (kind === "pr" ? prs[0]?.pr.title : pipelines.map(source => source.definitionName).join(", ")) : providerLabel}>
              {linked && kind === "pr" && prs.length ? `#${prs[0].pr.pullRequestId} ${prs[0].pr.title}${prs.length > 1 ? ` +${prs.length - 1}` : ""}` : linked && kind === "ci" && pipelines.length ? `CI · ${pipelines.map(source => source.definitionName).join(", ")}` : label}
            </span>
            <span className="block truncate text-[11px] text-content/45">
              {linked && (kind === "pr" ? prs.length : pipelines.length) ? `${providerLabel} · ` : ""}
              {linked && kind === "pr" && prs.length ? `${prs[0].pr.status === "active" && prs[0].pr.reviewers.some(reviewer => reviewer.vote < 0) ? "Needs attention" : prs[0].pr.status === "active" ? "Open" : prs[0].pr.status} · saved` : linked && kind === "ci" && pipelines.length ? (pipelines.length === 1 && pipelines[0].last ? `${ciState(pipelines[0].last.run.status, pipelines[0].last.run.result)} · ${pipelines[0].last.run.commit?.slice(0, 8) || "unknown commit"} · saved` : `${pipelines.length} linked`) : providerLabel}
            </span>
            </span>
            <ChevronRight
              className="size-3 shrink-0 text-content/30"
              strokeWidth={1.75}
            />
          </button>
        );})}
        <details open={choosingProviders} onToggle={event => setChoosingProviders(event.currentTarget.open)} className="px-3 text-[11px] text-content/45">
          <summary className="cursor-pointer py-1">Providers</summary>
          <div className="space-y-1 pb-2">{(["pr", "ci"] as const).map(kind => <div key={kind} className="flex items-center justify-between gap-2"><span>{kind === "pr" ? "PR" : "CI"}</span><Select disabled={!enabled || !index || deliveryBusy} label={kind === "pr" ? "PR provider" : "CI provider"} value={deliveryProvider(cwd, index?.branch ?? "", sourceSessionId, kind) ?? ""} options={[{value:"",label:"Automatic"},{value:"github",label:kind === "pr" ? "GitHub" : "GitHub checks"},{value:"azure",label:kind === "pr" ? "Azure Repos" : "Azure Pipelines"}]} onChange={value => {
            try { saveDeliveryProvider(cwd, index?.branch ?? "", sourceSessionId, kind, value as DeliveryProvider | ""); setDeliveryError(""); }
            catch { setDeliveryError("Could not save provider choice. Try again."); }
          }} /></div>)}</div>
        </details>
        {deliveryError ? <p role="alert" className="px-3 py-1 text-[11px] text-red-400">{deliveryError}</p> : null}
      </div>
      <ChangedFiles
        cwd={cwd}
        textHarness={textHarness}
        sourceSessionId={sourceSessionId}
        index={index}
        files={files}
        selected={selectedPath}
        selectedKind={selectedKind}
        enabled={enabled}
        fill
        onOpenFile={onOpenFile}
        onOpenAllChanges={onOpenAllChanges}
        onMutated={(paths, apply, touchWorktree) => {
          if (apply) patch(apply);
          notifyGitChanged(cwd);
          // Only discard and sync rewrite worktree bytes; staging and
          // committing must not reload open editors.
          if (touchWorktree) {
            invalidateWatchedFiles(paths);
            window.setTimeout(() => invalidateWatchedFiles(paths), 150);
          }
        }}
      />
      {graphExpanded ? (
        <GraphResizeSash
          height={graphHeight}
          onHeightPaint={setGraphHeight}
          onHeightCommit={(next) => {
            setGraphHeight(next);
            saveGraphPanelHeight(next);
          }}
          maxHeight={() => {
            const pane = paneRef.current;
            if (!pane) return GRAPH_PANEL_DEFAULT * 2;
            return Math.max(GRAPH_PANEL_MIN, pane.clientHeight - 160);
          }}
        />
      ) : null}
      <div
        className={`shrink-0 overflow-hidden border-t border-content/10 ${
          graphExpanded ? "min-h-0" : "h-7"
        }`}
        style={graphExpanded ? { height: graphHeight } : undefined}
      >
        <GitHistoryGraph
          cwd={cwd}
          enabled={enabled}
          expanded={graphExpanded}
          selectedSha={selectedSha}
          onToggleExpanded={() => {
            graphOpen = !graphExpanded;
            setGraphExpanded(graphOpen);
          }}
          onOpenCommit={onOpenCommit}
        />
      </div>
    </div>
  );
}

function ChangedFiles({
  cwd,
  textHarness,
  sourceSessionId,
  index,
  files,
  selected,
  selectedKind,
  enabled,
  fill,
  onOpenFile,
  onOpenAllChanges,
  onMutated,
}: {
  cwd: string;
  textHarness?: HarnessId;
  sourceSessionId?: string;
  index: GitDiffIndex | null;
  files: GitChangedFile[];
  selected?: string;
  selectedKind?: GitFileDiffKind;
  enabled: boolean;
  fill: boolean;
  onOpenFile: (path: string, kind: GitFileDiffKind) => void;
  onOpenAllChanges: () => void;
  onMutated: (
    paths?: string[],
    apply?: (index: GitDiffIndex) => GitDiffIndex,
    touchWorktree?: boolean,
  ) => void;
}) {
  const [selectingContext, setSelectingContext] = useState(false);
  const [contextSelected, setContextSelected] = useState<Set<string>>(
    new Set(),
  );
  const [contextBusy, setContextBusy] = useState(false);
  const [contextError, setContextError] = useState("");
  const contextGeneration = useRef(0);
  const contextBusyRef = useRef(contextBusy);
  contextBusyRef.current = contextBusy;
  useEffect(() => {
    setContextSelected(new Set());
    return () => {
      contextGeneration.current++;
    };
  }, [cwd]);
  const toggleContext = useCallback(
    (relative: string, kind: GitFileDiffKind) => {
      if (contextBusyRef.current) return;
      const key = JSON.stringify([relative, kind]);
      setContextSelected((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else if (next.size < 20) next.add(key);
        return next;
      });
    },
    [],
  );
  const contextSelection = useMemo(
    () =>
      selectingContext
        ? { selected: contextSelected, toggle: toggleContext }
        : undefined,
    [selectingContext, contextSelected, toggleContext],
  );
  const toggleContextSelection = () => {
    contextGeneration.current++;
    setContextSelected(new Set());
    setSelectingContext((value) => !value);
    setContextBusy(false);
    setContextError("");
  };
  const selectContextAction = {
    title: selectingContext
      ? "Cancel file selection"
      : "Select files for agent",
    icon: <SquarePlus className="size-3.5" strokeWidth={1.75} />,
    onClick: toggleContextSelection,
  };
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const menuRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusyState] = useState<string | null>(null);
  // Ref mirror keeps action callbacks stable so memoized rows do not
  // re-render when an unrelated row starts or finishes a git operation.
  const busyRef = useRef<string | null>(null);
  const setBusy = (value: string | null) => {
    busyRef.current = value;
    setBusyState(value);
  };
  const onMutatedRef = useRef(onMutated);
  onMutatedRef.current = onMutated;
  const mutated = useCallback(
    (
      paths?: string[],
      apply?: (index: GitDiffIndex) => GitDiffIndex,
      touchWorktree?: boolean,
    ) => onMutatedRef.current(paths, apply, touchWorktree),
    [],
  );
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const openFile = useCallback(
    (path: string, kind: GitFileDiffKind) =>
      onOpenFileRef.current(path, kind),
    [],
  );
  const [message, setMessage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [stagedExpanded, setStagedExpanded] = useState(stagedOpen);
  const [changesExpanded, setChangesExpanded] = useState(changesOpen);
  const [view, setView] = useState<ChangesView>(changesView);
  const { pr, reload: reloadPr } = usePrStatus(cwd, index?.branch);
  const staged = useMemo(() => files.filter((file) => file.staged), [files]);
  const unstaged = useMemo(
    () => files.filter((file) => file.unstaged),
    [files],
  );
  const hasRemote = Boolean(index?.remote);
  const hasOpenPr = pr?.state === "open";
  const diverged = (index?.ahead ?? 0) > 0 && (index?.behind ?? 0) > 0;
  const onDefault =
    !!index?.branch &&
    !!index.defaultBranch &&
    index.branch === index.defaultBranch;
  const canGenerate = files.length > 0 && !busy;
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;
  const canCreatePr =
    hasRemote &&
    !hasOpenPr &&
    !onDefault &&
    !diverged &&
    files.length === 0 &&
    (index?.aheadOfDefault ?? 0) > 0 &&
    (index?.behind ?? 0) === 0;
  const canViewPr = hasOpenPr && !!pr?.url;
  const canPublish = hasRemote && !index?.upstream;
  const canSync =
    hasRemote &&
    Boolean(index?.upstream) &&
    ((index?.ahead ?? 0) > 0 || (index?.behind ?? 0) > 0);
  const canCommitPush = canCommit && hasRemote && !diverged;
  const canCommitPushPr = canCommitPush && !hasOpenPr && !onDefault;
  const canEditMessage = staged.length > 0 && !busy;

  useEffect(() => {
    if (!enabled) return;
    const el = messageRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [message, enabled]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [menuOpen]);

  const toggleView = () => {
    changesView = view === "tree" ? "list" : "tree";
    saveChangesView(changesView);
    setView(changesView);
  };

  const fail = (error: unknown) => {
    window.alert(error instanceof Error ? error.message : String(error));
  };

  const confirmDefault = async (kind: "push" | "pr") => {
    if (!onDefault || !index?.branch) return true;
    const branch = index.branch;
    return confirmNative(
      kind === "pr"
        ? `Create a pull request from default branch "${branch}"?`
        : `Push to default branch "${branch}"?`,
    );
  };

  const run = useCallback(
    async (
      file: GitChangedFile,
      action: "stage" | "unstage" | "discard",
    ) => {
      if (busyRef.current) return;
      setBusy(file.relative);
      try {
        if (action === "discard") {
          const name = basename(file.relative);
          const untracked = file.status === "untracked";
          const ok = await confirmNative(
            untracked
              ? `Delete untracked file ${name}?`
              : `Discard changes in ${name}? This cannot be undone.`,
            untracked ? "Delete" : "Discard",
          );
          if (!ok) return;
        }
        if (action === "stage") await gitStageFile(cwd, file.relative);
        else if (action === "unstage") await gitUnstageFile(cwd, file.relative);
        else await gitDiscardFile(cwd, file.relative);
        mutated(
          [file.path],
          (index) => indexAfterFileAction(index, file.relative, action),
          action === "discard",
        );
      } catch (error) {
        fail(error);
      } finally {
        setBusy(null);
      }
    },
    [cwd, mutated],
  );

  const runAll = async (action: "stage" | "unstage" | "discard") => {
    if (busyRef.current) return;
    setBusy(action);
    try {
      if (action === "discard") {
        const n = unstaged.length;
        if (n === 0) return;
        const only = unstaged[0];
        const untrackedOnly = n === 1 && only?.status === "untracked";
        const ok = await confirmNative(
          untrackedOnly
            ? `Delete untracked file ${basename(only.relative)}?`
            : n === 1 && only
              ? `Discard changes in ${basename(only.relative)}? This cannot be undone.`
              : `Discard all unstaged changes in ${n} files? This cannot be undone.`,
          untrackedOnly ? "Delete" : "Discard",
        );
        if (!ok) return;
      }
      if (action === "stage") await gitStageAll(cwd);
      else if (action === "unstage") await gitUnstageAll(cwd);
      else await gitDiscardAll(cwd);
      mutated(
        action === "discard" ? unstaged.map((file) => file.path) : undefined,
        (index) => indexAfterAllAction(index, action),
        action === "discard",
      );
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (!canGenerate) return;
    setBusy("generate");
    try {
      setMessage(await generateCommitMessage(cwd, textHarness));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const commit = async (push: boolean, createPr = false) => {
    if (!canCommit) return;
    setBusy(createPr ? "pr" : "commit");
    setMenuOpen(false);
    try {
      if (
        (push || createPr) &&
        !(await confirmDefault(createPr ? "pr" : "push"))
      ) {
        return;
      }
      await gitCommit(cwd, message);
      if (push || createPr) await gitPush(cwd);
      setMessage("");
      mutated();
      if (createPr) {
        await openCreatedPr();
        reloadPr();
      }
    } catch (error) {
      fail(error);
      mutated();
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    if (!index || !(canSync || canPublish)) return;
    setBusy("sync");
    try {
      await gitSync(cwd);
      mutated(undefined, undefined, true);
      reloadPr();
    } catch (error) {
      fail(error);
      mutated(undefined, undefined, true);
    } finally {
      setBusy(null);
    }
  };

  const openCreatedPr = async () => {
    const content = await generatePrContent(cwd, textHarness);
    if (!content) throw new Error("Could not prepare pull request content");
    const url = await gitPrCreate(
      cwd,
      content.title,
      content.body,
      content.base,
      content.head,
    );
    await openUrl(url.trim());
  };

  const createPr = async () => {
    if (!canCreatePr) return;
    setBusy("pr");
    try {
      if (!(await confirmDefault("pr"))) return;
      if ((index?.ahead ?? 0) > 0) await gitPush(cwd);
      await openCreatedPr();
      mutated();
      reloadPr();
    } catch (error) {
      fail(error);
      mutated();
    } finally {
      setBusy(null);
    }
  };

  const contextLoading = useRef(false);
  const taskMenuButton = useRef<HTMLButtonElement | null>(null);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const tasksRaw = useSyncExternalStore(
    subscribeTaskWorkspaces,
    taskWorkspacesSnapshot,
  );
  const contextTasks = useMemo(
    () => loadTaskWorkspaces().filter((task) => !task.archived),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasksRaw],
  );
  const prepareSelected = async (
    route: { prepareInSource: true } | { taskId: string } | { newTask: true },
  ) => {
    if (contextLoading.current) return;
    contextLoading.current = true;
    const generation = contextGeneration.current;
    setContextBusy(true);
    setContextError("");
    try {
      const selections = [...contextSelected].map((key) => {
        const [relative, kind] = JSON.parse(key) as [string, GitFileDiffKind];
        return { relative, kind };
      });
      if (
        selections.some(
          (selection) =>
            !files.some(
              (file) =>
                file.relative === selection.relative &&
                (selection.kind === "staged" ? file.staged : file.unstaged),
            ),
        )
      )
        throw new Error(
          "A selected change is no longer available. Select changes again.",
        );
      const context = await contextFromChanges(cwd, selections);
      if (generation === contextGeneration.current) {
        setTaskMenuOpen(false);
        requestAgentContext({
          context,
          cwd,
          sourceSessionId,
          ...route,
          onPrepared: () => {
            if (generation !== contextGeneration.current) return;
            setContextSelected(new Set());
            setSelectingContext(false);
          },
        });
      }
    } catch (reason) {
      if (generation === contextGeneration.current)
        setContextError(String(reason));
    } finally {
      contextLoading.current = false;
      if (generation === contextGeneration.current) setContextBusy(false);
    }
  };
  return (
    <aside
      className={`relative flex min-h-0 min-w-0 flex-col ${fill ? "flex-1" : "shrink-0"}`}
    >
      <div className="shrink-0 border-b border-content/10 p-2">
        <div className="relative">
          <textarea
            ref={messageRef}
            rows={1}
            value={message}
            placeholder={`Message (${MOD}↩ to commit)`}
            disabled={!canEditMessage}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.metaKey || event.ctrlKey) &&
                event.key === "Enter" &&
                canCommit
              ) {
                event.preventDefault();
                void commit(false);
              }
            }}
            className="max-h-40 w-full resize-none overflow-y-auto rounded-md bg-content/10 py-1 pr-8 pl-2 text-[13px] leading-5 text-content outline-none placeholder:text-content/35 disabled:opacity-40"
          />
          <button
            type="button"
            title="Generate commit message"
            aria-label="Generate commit message"
            disabled={!canGenerate}
            onClick={() => void generate()}
            className="absolute top-1 right-1 grid size-5 place-items-center rounded-md text-content bg-content/10 hover:bg-content/20 hover:text-content disabled:opacity-40"
          >
            {busy === "generate" ? (
              <Loader className="size-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <WandSparkles className="size-3" strokeWidth={1} />
            )}
          </button>
        </div>
        <div ref={menuRef} className="relative mt-1.5 flex">
          <button
            type="button"
            disabled={!canCommit}
            onClick={() => void commit(false)}
            className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-content text-[12px] font-medium text-background-base disabled:opacity-40"
          >
            <Check className="size-3.5" strokeWidth={2} />
            Commit
          </button>

          <button
            type="button"
            title="Commit options"
            aria-label="Commit options"
            disabled={!canCommit}
            onClick={() => setMenuOpen((open) => !open)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-r-md border-l border-background-base/10 bg-content text-background-base disabled:opacity-40"
          >
            <ChevronDown className="size-3.5" strokeWidth={2} />
          </button>
          {menuOpen ? (
            <div className="absolute top-full right-0 z-30 mt-1 min-w-48 rounded-md border border-content/10 bg-background-base py-1 shadow-lg">
              <button
                type="button"
                disabled={!canCommitPush}
                onClick={() => void commit(true)}
                className="flex h-7 w-full items-center px-3 text-left text-[12px] text-content hover:bg-content/10 disabled:opacity-40"
              >
                Commit & Push
              </button>
              <button
                type="button"
                disabled={!canCommitPushPr}
                onClick={() => void commit(true, true)}
                className="flex h-7 w-full items-center px-3 text-left text-[12px] text-content hover:bg-content/10 disabled:opacity-40"
              >
                Commit, Push & Create PR
              </button>
            </div>
          ) : null}
        </div>
        {index ? (
          <GitSyncActions
            index={index}
            pr={pr}
            busy={busy}
            hasRemote={hasRemote}
            hasOpenPr={hasOpenPr}
            onDefault={onDefault}
            canSync={canSync}
            canPublish={canPublish}
            canCreatePr={canCreatePr}
            canViewPr={canViewPr}
            onSync={() => void sync()}
            onCreatePr={() => void createPr()}
            onViewPr={() => {
              if (pr?.url) void openUrl(pr.url);
            }}
          />
        ) : null}
      </div>
      <div
        ref={lockOverscroll}
        className={`relative min-h-0 flex-1 overflow-y-auto overscroll-none py-1 ${selectingContext ? "pb-20" : ""}`}
      >
        {files.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-content/45">
            {index
              ? index.ahead > 0 || index.behind > 0
                ? syncStatusLabel(index)
                : "No uncommitted changes"
              : "Loading changes…"}
          </p>
        ) : (
          <>
            {staged.length > 0 ? (
              <FileSection
                title="Staged Changes"
                count={staged.length}
                open={stagedExpanded}
                onToggle={() => {
                  stagedOpen = !stagedExpanded;
                  setStagedExpanded(stagedOpen);
                }}
                view={view}
                onToggleView={toggleView}
                headerActions={[
                  selectContextAction,
                  {
                    title: "Open All Changes",
                    icon: <FileDiff className="size-3.5" strokeWidth={1.75} />,
                    onClick: onOpenAllChanges,
                  },
                  {
                    title: "Unstage All Changes",
                    icon: <Minus className="size-3.5" strokeWidth={1.75} />,
                    onClick: () => void runAll("unstage"),
                  },
                ]}
              >
                <ChangeList
                  contextSelection={contextSelection}
                  files={staged}
                  view={view}
                  kind="staged"
                  selected={selected}
                  selectedKind={selectedKind}
                  busy={busy}
                  onOpenFile={openFile}
                  onAction={run}
                />
              </FileSection>
            ) : null}
            {unstaged.length > 0 ? (
              <FileSection
                title="Changes"
                count={unstaged.length}
                open={changesExpanded}
                onToggle={() => {
                  changesOpen = !changesExpanded;
                  setChangesExpanded(changesOpen);
                }}
                view={view}
                onToggleView={toggleView}
                headerActions={[
                  ...(staged.length ? [] : [selectContextAction]),
                  {
                    title: "Open All Changes",
                    icon: <FileDiff className="size-3.5" strokeWidth={1.75} />,
                    onClick: onOpenAllChanges,
                  },
                  {
                    title: "Discard All Changes",
                    icon: <Undo2 className="size-3.5" strokeWidth={1.75} />,
                    onClick: () => void runAll("discard"),
                  },
                  {
                    title: "Stage All Changes",
                    icon: <Plus className="size-3.5" strokeWidth={1.75} />,
                    onClick: () => void runAll("stage"),
                  },
                ]}
              >
                <ChangeList
                  contextSelection={contextSelection}
                  files={unstaged}
                  view={view}
                  kind="unstaged"
                  selected={selected}
                  selectedKind={selectedKind}
                  busy={busy}
                  onOpenFile={openFile}
                  onAction={run}
                />
              </FileSection>
            ) : null}
          </>
        )}
      </div>
      {selectingContext ? (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 z-10">
          <div className="pointer-events-auto overflow-hidden rounded-xl border border-content/15 bg-background-base/85 shadow-xl backdrop-blur-xl">
            <div className="flex items-center gap-2 border-b border-content/10 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-content/70">
                {contextSelected.size
                  ? `${contextSelected.size} file${contextSelected.size === 1 ? "" : "s"} selected`
                  : "Select files to send"}
              </span>
              <button
                type="button"
                aria-label="Cancel selection"
                title="Cancel selection"
                className="grid size-5.5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
                onClick={toggleContextSelection}
              >
                <X className="size-3.5" strokeWidth={1.75} />
              </button>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <button
                type="button"
                disabled={!contextSelected.size || contextBusy}
                className="h-7 flex-1 rounded-md text-[12px] text-content/80 hover:bg-content/5 disabled:opacity-40"
                onClick={() => void prepareSelected({ prepareInSource: true })}
              >
                {contextBusy ? "Loading…" : "Add to chat"}
              </button>
              <button
                ref={taskMenuButton}
                type="button"
                disabled={!contextSelected.size || contextBusy}
                aria-haspopup="menu"
                aria-expanded={taskMenuOpen}
                title="Send the selected changes to a task"
                className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-accent/15 text-[12px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
                onClick={() => setTaskMenuOpen((open) => !open)}
              >
                Send to task
                <ChevronDown className="size-3" strokeWidth={1.75} />
              </button>
            </div>
            {contextError ? (
              <p role="alert" className="px-3 pb-2 text-[11px] text-red-400">
                {contextError}
              </p>
            ) : null}
          </div>
          {taskMenuOpen ? (
            <ContextTaskMenu
              anchor={taskMenuButton}
              tasks={contextTasks}
              onPick={(taskId) => void prepareSelected({ taskId })}
              onNewTask={() => void prepareSelected({ newTask: true })}
              onClose={() => setTaskMenuOpen(false)}
            />
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function usePrStatus(
  cwd: string,
  branch: string | null | undefined,
): { pr: GitPr | null; reload: () => void } {
  const [pr, setPr] = useState<GitPr | null>(() => cachedPr(cwd, branch));
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!cwd || cwd === "~" || !branch) {
      setPr(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      void gitPrStatus(cwd)
        .then((next) => {
          if (cancelled) return;
          prByCwd.set(cwd, next);
          setPr(next);
        })
        .catch(() => {
          if (cancelled) return;
          prByCwd.set(cwd, null);
          setPr(null);
        });
    };
    load();
    const onResume = () => load();
    window.addEventListener("focus", onResume);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onResume);
    };
  }, [branch, cwd, nonce]);

  return { pr, reload };
}

function cachedPr(
  cwd: string,
  branch: string | null | undefined,
): GitPr | null {
  if (!cwd || cwd === "~" || !branch) return null;
  return prByCwd.get(cwd) ?? null;
}

function syncStatusLabel(index: GitDiffIndex): string {
  if (index.ahead > 0 && index.behind > 0) {
    return `Diverged from ${index.upstream ?? "upstream"}`;
  }
  if (index.ahead > 0) {
    const n = index.ahead;
    return `${n} unpushed commit${n === 1 ? "" : "s"}`;
  }
  if (index.behind > 0) {
    const n = index.behind;
    return `${n} incoming commit${n === 1 ? "" : "s"}`;
  }
  return "No files";
}

function GitSyncActions({
  index,
  pr,
  busy,
  hasRemote,
  hasOpenPr,
  onDefault,
  canSync,
  canPublish,
  canCreatePr,
  canViewPr,
  onSync,
  onCreatePr,
  onViewPr,
}: {
  index: GitDiffIndex;
  pr: GitPr | null;
  busy: string | null;
  hasRemote: boolean;
  hasOpenPr: boolean;
  onDefault: boolean;
  canSync: boolean;
  canPublish: boolean;
  canCreatePr: boolean;
  canViewPr: boolean;
  onSync: () => void;
  onCreatePr: () => void;
  onViewPr: () => void;
}) {
  if (!hasRemote) return null;
  const ahead = index.ahead;
  const behind = index.behind;
  const dest =
    index.upstream ?? `${index.remote ?? "origin"}/${index.branch ?? "HEAD"}`;
  const syncing = busy === "sync";
  const syncTitle = syncing
    ? "Synchronizing Changes..."
    : canPublish
      ? index.branch
        ? `Publish Branch "${index.branch}"`
        : "Publish Branch"
      : behind > 0 && ahead > 0
        ? `Pull ${behind} and push ${ahead} commits between ${dest}`
        : behind > 0
          ? `Pull ${behind} commit${behind === 1 ? "" : "s"} from ${dest}`
          : `Push ${ahead} commit${ahead === 1 ? "" : "s"} to ${dest}`;
  const createTitle = index.defaultBranch
    ? `Create a pull request into ${index.defaultBranch}`
    : "Create pull request";
  const viewTitle = pr?.title
    ? `View PR #${pr.number}: ${pr.title}`
    : "View pull request";
  const btn =
    "flex h-7 w-full min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] font-medium disabled:opacity-40";
  const secondary = `${btn} bg-content/10 text-content hover:bg-content/15`;
  const showCreatePr = !hasOpenPr && !onDefault;
  const showViewPr = hasOpenPr;
  if (!canPublish && !canSync && !showCreatePr && !showViewPr) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {canPublish ? (
        <button
          type="button"
          title={syncTitle}
          disabled={!!busy}
          onClick={onSync}
          className={secondary}
        >
          {syncing ? (
            <Loader
              className="size-3.5 shrink-0 animate-spin"
              strokeWidth={1.75}
            />
          ) : (
            <CloudUpload className="size-3.5 shrink-0" strokeWidth={1.75} />
          )}
          <span className="min-w-0 truncate">Publish Branch</span>
        </button>
      ) : canSync ? (
        <button
          type="button"
          title={syncTitle}
          disabled={!!busy}
          onClick={onSync}
          className={secondary}
        >
          <RefreshCw
            className={`size-3.5 shrink-0 ${syncing ? "animate-spin" : ""}`}
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate">Sync Changes</span>
          {behind > 0 ? (
            <span className="shrink-0 tabular-nums text-content/55">
              ↓{behind}
            </span>
          ) : null}
          {ahead > 0 ? (
            <span className="shrink-0 tabular-nums text-content/55">
              ↑{ahead}
            </span>
          ) : null}
        </button>
      ) : null}
      {showCreatePr ? (
        <button
          type="button"
          title={createTitle}
          disabled={!canCreatePr || !!busy}
          onClick={onCreatePr}
          className={secondary}
        >
          {busy === "pr" ? (
            <Loader
              className="size-3.5 shrink-0 animate-spin"
              strokeWidth={1.75}
            />
          ) : (
            <GitPullRequest className="size-3.5 shrink-0" strokeWidth={1.75} />
          )}
          Create PR
        </button>
      ) : null}
      {showViewPr ? (
        <button
          type="button"
          title={viewTitle}
          disabled={!canViewPr || !!busy}
          onClick={onViewPr}
          className={secondary}
        >
          <ExternalLink className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">
            {pr?.number ? `View PR #${pr.number}` : "View PR"}
          </span>
        </button>
      ) : null}
    </div>
  );
}

function FileSection({
  title,
  count,
  open,
  onToggle,
  view,
  onToggleView,
  headerActions,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  view: ChangesView;
  onToggleView: () => void;
  headerActions: { title: string; icon: ReactNode; onClick: () => void }[];
  children: ReactNode;
}) {
  return (
    <div>
      <div className="flex h-7 items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          {open ? (
            <ChevronDown
              className="size-3.5 shrink-0 text-content/50"
              strokeWidth={1.75}
            />
          ) : (
            <ChevronRight
              className="size-3.5 shrink-0 text-content/50"
              strokeWidth={1.75}
            />
          )}
          <span className="min-w-0 truncate text-[10px] font-semibold tracking-[0.04em] text-content/55 uppercase">
            {title}
          </span>
          <span className="ml-1 grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-accent/80 px-1 text-[8px] text-white">
            {count}
          </span>
        </button>
        <IconAction
          title={view === "tree" ? "View as List" : "View as Tree"}
          onClick={onToggleView}
        >
          {view === "tree" ? (
            <ListBullet className="size-3.5" strokeWidth={1.75} />
          ) : (
            <FolderTree className="size-3.5" strokeWidth={1.75} />
          )}
        </IconAction>
        {headerActions.map((action) => (
          <IconAction
            key={action.title}
            title={action.title}
            onClick={action.onClick}
          >
            {action.icon}
          </IconAction>
        ))}
      </div>
      {open ? <ul>{children}</ul> : null}
    </div>
  );
}

type ChangeDir = {
  name: string;
  /** Path relative to the repo root; "" for the implicit root. */
  path: string;
  dirs: ChangeDir[];
  files: GitChangedFile[];
  /** Status shared by every descendant, or null when they differ. */
  status: string | null;
};

type ContextSelection = {
  selected: ReadonlySet<string>;
  toggle: (relative: string, kind: GitFileDiffKind) => void;
};
type ChangeRowProps = {
  contextSelection?: ContextSelection;
  files: GitChangedFile[];
  view: ChangesView;
  kind: GitFileDiffKind;
  selected?: string;
  selectedKind?: GitFileDiffKind;
  busy: string | null;
  onOpenFile: (path: string, kind: GitFileDiffKind) => void;
  onAction: (
    file: GitChangedFile,
    action: "stage" | "unstage" | "discard",
  ) => void;
};

const ChangeList = memo(function ChangeList({
  files,
  view,
  ...rest
}: ChangeRowProps) {
  const tree = useMemo(() => buildChangeTree(files), [files]);
  if (view === "tree") {
    return <ChangeDirChildren dir={tree} depth={0} {...rest} />;
  }
  return (
    <>
      {files.map((file) => (
        <ChangeRow
          key={`${rest.kind}:${file.relative}`}
          file={file}
          active={isActive(file, rest.selected, rest.selectedKind, rest.kind)}
          busy={rest.busy === file.relative}
          kind={rest.kind}
          onOpenFile={rest.onOpenFile}
          onAction={rest.onAction}
          contextChecked={
            rest.contextSelection
              ? rest.contextSelection.selected.has(
                  JSON.stringify([file.relative, rest.kind]),
                )
              : undefined
          }
          onToggleContext={rest.contextSelection?.toggle}
        />
      ))}
    </>
  );
});

function ChangeDirChildren({
  dir,
  depth,
  kind,
  selected,
  selectedKind,
  busy,
  onOpenFile,
  onAction,
  contextSelection,
}: Omit<ChangeRowProps, "files" | "view"> & {
  dir: ChangeDir;
  depth: number;
}) {
  return (
    <>
      {dir.dirs.map((child) => (
        <ChangeDirRow
          key={child.path}
          dir={child}
          depth={depth}
          kind={kind}
          selected={selected}
          selectedKind={selectedKind}
          busy={busy}
          onOpenFile={onOpenFile}
          onAction={onAction}
          contextSelection={contextSelection}
        />
      ))}
      {dir.files.map((file) => (
        <ChangeRow
          key={`${kind}:${file.relative}`}
          file={file}
          active={isActive(file, selected, selectedKind, kind)}
          busy={busy === file.relative}
          kind={kind}
          depth={depth}
          onOpenFile={onOpenFile}
          onAction={onAction}
          contextChecked={
            contextSelection
              ? contextSelection.selected.has(
                  JSON.stringify([file.relative, kind]),
                )
              : undefined
          }
          onToggleContext={contextSelection?.toggle}
        />
      ))}
    </>
  );
}

const ChangeDirRow = memo(function ChangeDirRow({
  dir,
  depth,
  kind,
  ...rest
}: Omit<ChangeRowProps, "files" | "view"> & {
  dir: ChangeDir;
  depth: number;
}) {
  const key = `${kind}:${dir.path}`;
  const [open, setOpen] = useState(() => !collapsedDirs.has(key));
  const toggle = () => {
    if (open) collapsedDirs.add(key);
    else collapsedDirs.delete(key);
    setOpen(!open);
  };
  return (
    <li>
      <button
        type="button"
        title={dir.path}
        aria-expanded={open}
        onClick={toggle}
        style={{ paddingLeft: 8 + depth * 12 }}
        className="flex h-7 w-full items-center gap-1.5 pr-2 text-left leading-none text-content hover:bg-content/5"
      >
        <span className="grid size-4 shrink-0 place-items-center text-content/50">
          {open ? (
            <ChevronDown className="size-3.5" strokeWidth={1.75} />
          ) : (
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          )}
        </span>
        <FileTypeIcon name={dir.name} isDir isOpen={open} size={16} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {dir.name}
        </span>
        <span
          className={`grid w-3.5 shrink-0 place-items-center ${
            dir.status ? statusColor(dir.status) : "text-content/40"
          }`}
          aria-hidden
        >
          <span className="size-1.5 rounded-full bg-current" />
        </span>
      </button>
      {open ? (
        <ul>
          <ChangeDirChildren
            dir={dir}
            depth={depth + 1}
            kind={kind}
            {...rest}
          />
        </ul>
      ) : null}
    </li>
  );
});

function isActive(
  file: GitChangedFile,
  selected: string | undefined,
  selectedKind: GitFileDiffKind | undefined,
  kind: GitFileDiffKind,
): boolean {
  return selected === file.relative && (!selectedKind || selectedKind === kind);
}

/** Nests changed files under their directories, VS Code's tree view. */
function buildChangeTree(files: GitChangedFile[]): ChangeDir {
  const root: ChangeDir = {
    name: "",
    path: "",
    dirs: [],
    files: [],
    status: null,
  };
  const dirByPath = new Map<string, ChangeDir>([["", root]]);
  for (const file of files) {
    const segments = file.relative.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const path = node.path ? `${node.path}/${segment}` : segment;
      let next = dirByPath.get(path);
      if (!next) {
        next = { name: segment, path, dirs: [], files: [], status: null };
        node.dirs.push(next);
        dirByPath.set(path, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  sortChangeDir(root);
  return root;
}

/** Sorts each level (folders first) and rolls descendant status upward. */
function sortChangeDir(dir: ChangeDir): string | null {
  dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
  dir.files.sort((a, b) =>
    basename(a.relative).localeCompare(basename(b.relative)),
  );
  let status: string | null = null;
  let mixed = false;
  const merge = (next: string | null) => {
    if (next === null) mixed = true;
    else if (status === null) status = next;
    else if (status !== next) mixed = true;
  };
  for (const child of dir.dirs) merge(sortChangeDir(child));
  for (const file of dir.files) merge(file.status);
  dir.status = mixed ? null : status;
  return dir.status;
}

function sameChangedFile(a: GitChangedFile, b: GitChangedFile): boolean {
  return (
    a === b ||
    (a.path === b.path &&
      a.relative === b.relative &&
      a.status === b.status &&
      a.staged === b.staged &&
      a.unstaged === b.unstaged &&
      a.additions === b.additions &&
      a.deletions === b.deletions)
  );
}

const ChangeRow = memo(
  function ChangeRow({
    file,
    active,
    busy,
    kind,
    depth,
    onOpenFile,
    onAction,
    contextChecked,
    onToggleContext,
  }: {
    /** Selection-mode state for this file; undefined hides the checkbox. */
    contextChecked?: boolean;
    onToggleContext?: (relative: string, kind: GitFileDiffKind) => void;
    file: GitChangedFile;
    active: boolean;
    busy: boolean;
    kind: GitFileDiffKind;
    /** Set in tree view: nesting level, and the folder path moves to the tree. */
    depth?: number;
    onOpenFile: (path: string, kind: GitFileDiffKind) => void;
    onAction: (
      file: GitChangedFile,
      action: "stage" | "unstage" | "discard",
    ) => void;
  }) {
    const name = basename(file.relative);
    const tree = depth !== undefined;
    const dir = tree ? "" : dirname(file.relative);
    const canOpen = file.status !== "deleted";
    const selecting = onToggleContext !== undefined;
    return (
      <li>
        <div
          style={tree ? { paddingLeft: 8 + depth * 12 } : undefined}
          className={`group flex h-7 w-full items-center gap-1 pr-2 leading-none ${
            tree ? "" : "pl-2"
          } ${
            contextChecked
              ? "bg-accent/10 text-content"
              : active
                ? "bg-content/10 text-content"
                : "text-content hover:bg-content/5"
          }`}
        >
          {selecting ? (
            <ContextCheckbox
              className=""
              label={`Select ${kind} ${file.relative}`}
              checked={contextChecked ?? false}
              onChange={() => onToggleContext(file.relative, kind)}
            />
          ) : null}
        <button
          type="button"
          title={file.relative}
          aria-pressed={selecting ? contextChecked : undefined}
          onClick={() => {
            if (selecting) onToggleContext(file.relative, kind);
            else if (canOpen) onOpenFile(file.path, kind);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {tree ? <span className="size-4 shrink-0" /> : null}
          <FileTypeIcon name={name} isDir={false} size={16} />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-[13px] font-medium">{name}</span>
            {dir ? (
              <span className="ml-1.5 text-[11px] text-content/40">{dir}</span>
            ) : null}
          </span>
        </button>
        {selecting ? null : (
        <div
          className={` shrink-0 items-center ${
            active ? "flex" : "hidden group-focus-within:flex group-hover:flex"
          }`}
        >
          {kind === "unstaged" ? (
            <IconAction
              title="Discard Changes"
              disabled={busy}
              onClick={() => onAction(file, "discard")}
            >
              <Undo2 className="size-3.5" strokeWidth={1.75} />
            </IconAction>
          ) : null}
          {kind === "staged" ? (
            <IconAction
              title="Unstage Changes"
              disabled={busy}
              onClick={() => onAction(file, "unstage")}
            >
              <Minus className="size-3.5" strokeWidth={1.75} />
            </IconAction>
          ) : (
            <IconAction
              title="Stage Changes"
              disabled={busy}
              onClick={() => onAction(file, "stage")}
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
            </IconAction>
          )}
        </div>
        )}
        <span
          className={`w-3.5 shrink-0 text-right font-mono text-[11px] font-semibold ${statusColor(file.status)}`}
        >
          {statusLetter(file.status)}
        </span>
      </div>
    </li>
  );
  },
  (prev, next) =>
    prev.active === next.active &&
    prev.busy === next.busy &&
    prev.kind === next.kind &&
    prev.depth === next.depth &&
    prev.contextChecked === next.contextChecked &&
    prev.onOpenFile === next.onOpenFile &&
    prev.onAction === next.onAction &&
    prev.onToggleContext === next.onToggleContext &&
    sameChangedFile(prev.file, next.file),
);

function IconAction({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="grid size-5 place-items-center rounded text-content/55 hover:bg-content/10 hover:text-content disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function dirname(relative: string): string {
  const i = relative.lastIndexOf("/");
  return i > 0 ? relative.slice(0, i) : "";
}

function statusLetter(status: string): string {
  if (status === "untracked") return "U";
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

function statusColor(status: string): string {
  if (status === "untracked") return "text-sky-400";
  if (status === "added") return "text-emerald-400";
  if (status === "deleted") return "text-red-400";
  return "text-amber-400";
}

function useDiffIndex(
  cwd: string,
  enabled: boolean,
): {
  index: GitDiffIndex | null;
  patch: (update: (index: GitDiffIndex) => GitDiffIndex) => void;
} {
  const [index, setIndex] = useState<GitDiffIndex | null>(() =>
    cachedIndex(cwd),
  );
  const indexRef = useRef(index);
  indexRef.current = index;
  // The cwd that produced indexRef.current. Between a cwd-change render and
  // this hook's effect, indexRef still holds the previous repo's index —
  // patch must not apply to or store under the new cwd.
  const indexCwd = useRef(cwd);
  // Bumped by every local patch so an in-flight load started before the
  // mutation cannot clobber optimistic state with a pre-mutation snapshot.
  const patchEpoch = useRef(0);

  // Apply a local mutation result instantly; the next load still reconciles.
  const patch = useCallback(
    (update: (index: GitDiffIndex) => GitDiffIndex) => {
      patchEpoch.current += 1;
      if (indexCwd.current !== cwd) return;
      const prev = indexRef.current;
      if (!prev) return;
      const next = update(prev);
      if (next === prev) return;
      indexByCwd.set(cwd, next);
      indexRef.current = next;
      setIndex(next);
    },
    [cwd],
  );

  useEffect(() => {
    if (!enabled || !cwd || cwd === "~") {
      return;
    }
    indexCwd.current = cwd;
    const cached = cachedIndex(cwd);
    if (
      cached ? !sameIndex(indexRef.current, cached) : indexRef.current !== null
    ) {
      indexRef.current = cached;
      setIndex(cached);
    }
    let cancelled = false;
    let inFlight = false;
    let pending = false;
    let selfNotify = false;

    const load = async () => {
      if (inFlight) {
        pending = true;
        return;
      }
      if (document.hidden) return;
      inFlight = true;
      const epoch = patchEpoch.current;
      try {
        const next = await gitDiffIndex(cwd);
        if (cancelled) return;
        applyProjectDiffStats(cwd, {
          files: next.files.length,
          additions: next.additions,
          deletions: next.deletions,
        });
        // A patch landed while this fetch was in flight; the mutation's
        // git-changed notification already queued a follow-up load.
        if (patchEpoch.current !== epoch) return;
        const prev = indexRef.current;
        if (sameIndex(prev, next)) return;
        indexByCwd.set(cwd, next);
        indexRef.current = next;
        setIndex(next);
        if (prev) {
          const paths = changedFilePaths(prev, next);
          invalidateWatchedFiles(paths);
          // Fan the detected change out to other consumers without
          // re-triggering this hook's own subscription into a second fetch.
          selfNotify = true;
          try {
            notifyGitChanged(cwd);
          } finally {
            selfNotify = false;
          }
        }
      } catch {
        if (!cancelled) {
          indexByCwd.delete(cwd);
          indexRef.current = null;
          setIndex(null);
        }
      } finally {
        inFlight = false;
        if (pending && !cancelled) {
          pending = false;
          void load();
        }
      }
    };

    void load();
    const onResume = () => {
      if (selfNotify || document.hidden) return;
      void load();
    };
    const timer = window.setInterval(onResume, GIT_POLL_MS);
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    const unsubGit = subscribeGitChanged(onResume, cwd);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
      unsubGit();
    };
  }, [cwd, enabled]);

  return { index, patch };
}

function cachedIndex(cwd: string | undefined): GitDiffIndex | null {
  if (!cwd || cwd === "~") return null;
  return indexByCwd.get(cwd) ?? null;
}

function changedFilePaths(prev: GitDiffIndex, next: GitDiffIndex): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const previous = new Map(prev.files.map((file) => [file.relative, file]));
  const current = new Set(next.files.map((file) => file.relative));
  for (const file of next.files) {
    const before = previous.get(file.relative);
    if (
      !before ||
      before.status !== file.status ||
      before.additions !== file.additions ||
      before.deletions !== file.deletions ||
      before.staged !== file.staged ||
      before.unstaged !== file.unstaged
    ) {
      paths.push(file.path);
      seen.add(file.path);
    }
  }
  for (const file of prev.files) {
    if (!current.has(file.relative) && !seen.has(file.path)) {
      paths.push(file.path);
    }
  }
  return paths;
}

/**
 * Local result of a row mutation applied before the refreshed index lands.
 * Only section membership (staged/unstaged flags) is predicted; status,
 * stats, and anything unexpected get corrected by the next `load()`.
 */
function indexAfterFileAction(
  index: GitDiffIndex,
  relative: string,
  action: "stage" | "unstage" | "discard",
): GitDiffIndex {
  const files: GitChangedFile[] = [];
  for (const file of index.files) {
    if (file.relative !== relative) {
      files.push(file);
      continue;
    }
    if (action === "stage") {
      if (file.staged && !file.unstaged) return index;
      files.push({
        ...file,
        staged: true,
        unstaged: false,
        status: file.status === "untracked" ? "added" : file.status,
      });
    } else if (action === "unstage") {
      if (!file.staged && file.unstaged) return index;
      files.push({
        ...file,
        staged: false,
        unstaged: true,
        status: file.status === "added" ? "untracked" : file.status,
      });
    } else if (file.staged) {
      files.push({ ...file, unstaged: false });
    }
  }
  return { ...index, files };
}

function indexAfterAllAction(
  index: GitDiffIndex,
  action: "stage" | "unstage" | "discard",
): GitDiffIndex {
  let changed = false;
  const files: GitChangedFile[] = [];
  for (const file of index.files) {
    if (action === "stage") {
      if (file.staged && !file.unstaged) {
        files.push(file);
      } else {
        changed = true;
        files.push({
          ...file,
          staged: true,
          unstaged: false,
          status: file.status === "untracked" ? "added" : file.status,
        });
      }
    } else if (action === "unstage") {
      if (!file.staged && file.unstaged) {
        files.push(file);
      } else {
        changed = true;
        files.push({
          ...file,
          staged: false,
          unstaged: true,
          status: file.status === "added" ? "untracked" : file.status,
        });
      }
    } else if (file.staged) {
      if (file.unstaged) {
        changed = true;
        files.push({ ...file, unstaged: false });
      } else {
        files.push(file);
      }
    } else {
      changed = true;
    }
  }
  return changed ? { ...index, files } : index;
}

function sameIndex(prev: GitDiffIndex | null, next: GitDiffIndex): boolean {
  if (!prev) return false;
  if (
    prev.branch !== next.branch ||
    prev.additions !== next.additions ||
    prev.deletions !== next.deletions ||
    prev.files.length !== next.files.length ||
    prev.remote !== next.remote ||
    prev.upstream !== next.upstream ||
    prev.defaultBranch !== next.defaultBranch ||
    prev.ahead !== next.ahead ||
    prev.behind !== next.behind ||
    prev.aheadOfDefault !== next.aheadOfDefault
  ) {
    return false;
  }
  return prev.files.every((file, i) => {
    const other = next.files[i];
    return (
      other &&
      file.relative === other.relative &&
      file.status === other.status &&
      file.additions === other.additions &&
      file.deletions === other.deletions &&
      file.staged === other.staged &&
      file.unstaged === other.unstaged
    );
  });
}

/** Task target menu for prepared change context — existing tasks, or a new
 * task whose sheet opens with the selection summarized into its brief. */
function ContextTaskMenu({
  anchor,
  tasks,
  onPick,
  onNewTask,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  tasks: readonly import("../lib/taskWorkspaces").TaskWorkspace[];
  onPick: (taskId: string) => void;
  onNewTask: () => void;
  onClose: () => void;
}) {
  const itemClass =
    "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5";
  return (
    <Popover
      anchor={anchor}
      align="end"
      onDismiss={onClose}
      role="menu"
      aria-label="Send changes to a task"
      className="w-64 overflow-hidden"
    >
      <div className="px-1.5 py-1.5">
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={onNewTask}
        >
          <Plus className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">New task…</span>
        </button>
        {tasks.length ? (
          <div
            role="separator"
            className="mx-1 my-1 border-t border-content/10"
          />
        ) : null}
        {tasks.map((task) => {
          const project = projectForTask(task);
          const projectLabel = project
            ? project.name?.trim() ||
              (project.anchor ? projectName(project.anchor) : "Project")
            : "";
          return (
            <button
              type="button"
              role="menuitem"
              key={task.id}
              className={itemClass}
              onClick={() => onPick(task.id)}
            >
              <Task
                className="size-3.5 shrink-0 text-content/50"
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate">{task.name}</span>
              <span className="shrink-0 truncate text-[10px] text-content/40">
                {projectLabel}
              </span>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
