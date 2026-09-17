import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { setGrabbing, suppressTextSelection } from "../lib/drag";
import {
  paneDropFromPoint,
  setExternalTitleTabDrop,
  titleTabDropFromPoint,
  useExternalPaneDrop,
  type TitleTabDropPosition,
} from "../lib/paneDrop";
import type { ApprovalDecision, UserQuestionReply } from "../lib/harness";
import type { EditorNavigationTarget } from "../lib/search";
import {
  layoutLeaves,
  layoutSashes,
  setSplitRatio,
  type BrowserMetaPatch,
  type EditorPane,
  type LayoutNode,
  type LayoutRect,
  type LayoutSash,
  type PaneEdge,
} from "../lib/layout";
import { sameProjectPath, type RecentProject } from "../lib/recents";
import type { TerminalMetaPatch } from "../lib/terminalTab";
import {
  sessionWorkCwd,
  type Attachment,
  type Block,
  type HarnessId,
  type LinkedWorkItem,
  type ModelTarget,
  type PlanBuildTarget,
  type RuntimeMode,
  type Session,
  type ComposerTurnOptions,
} from "../lib/session";
import { FilePane } from "./FilePane";
import { SessionPane } from "./SessionPane";
import { SessionSurface } from "./SessionSurface";
import type { SessionFolderTarget } from "../lib/sessionFolders";

type Shared = {
  sessionPortal?: { sessionId: string; host: HTMLElement };
  visible: boolean;
  sessions: Session[];
  editorPanes: EditorPane[];
  dirtyFileIds: Set<string>;
  fileErrorCounts: Map<string, number>;
  focusedId: string;
  addToChatSessionId?: string;
  composerFocused: boolean;
  recents: RecentProject[];
  hideProjectPicker?: boolean;
  onFocus: (paneId: string) => void;
  onClose: (sessionId: string) => void;
  onSelectFile: (paneId: string, fileId: string) => void;
  onCloseFile: (paneId: string, fileId: string) => void;
  onCloseOtherFiles: (paneId: string, fileId: string) => void;
  onReorderFiles: (paneId: string, ids: string[]) => void;
  onFileDirtyChange: (fileId: string, dirty: boolean) => void;
  onFileErrorCountChange: (fileId: string, count: number) => void;
  onRatio: (splitId: string, index: number, ratio: number) => void;
  onCwdChange: (sessionId: string, cwd: string, fresh?: boolean) => void;
  onBranchChange: (sessionId: string) => void;
  onModelChange: (sessionId: string, harness: HarnessId, model: string) => void;
  onModelSettingsChange: (
    sessionId: string,
    settings: Record<string, string>,
  ) => void;
  onRuntimeModeChange: (sessionId: string, mode: RuntimeMode) => void;
  onSubmit: (
    sessionId: string,
    text: string,
    attachments: Attachment[],
    options?: ComposerTurnOptions,
  ) => boolean | Promise<boolean>;
  onStop: (sessionId: string) => void;
  onCompactContext: (sessionId: string) => boolean;
  onPlaceSessionInFolder: (
    sessionId: string,
    target: SessionFolderTarget,
  ) => void;
  onDeleteQueuedMessage: (sessionId: string, messageId: string) => void;
  onEditQueuedMessage: (
    sessionId: string,
    messageId: string,
    text: string,
  ) => void;
  onQueuedMessageEditingChange: (sessionId: string, messageId?: string) => void;
  onSteerQueuedMessage: (sessionId: string, messageId: string) => void;
  onResumeQueue: (sessionId: string) => void;
  onAddIssues?: (sessionId: string) => void;
  onOpenTaskChild?: (taskId: string, childId: string) => void;
  onRetryTaskChild?: (taskId: string, childId: string) => void;
  onSetupTaskChild?: (taskId: string, childId: string) => void;
  needsInputSessionIds?: ReadonlySet<string>;
  onInboxCardDismiss?: (sessionId: string, fileId?: string) => void;
  onLinkedWorkItemUpdateCardDismiss?: (sessionId: string) => void;
  onNoteCardDismiss?: (sessionId: string) => void;
  onHandoffCardDismiss?: (sessionId: string) => void;
  onOpenLinkedWorkItem?: (item: LinkedWorkItem, sessionId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => Promise<boolean>;
  onDeleteSession?: (sessionId: string) => Promise<boolean>;
  onApproval: (
    sessionId: string,
    requestId: number,
    decision: ApprovalDecision,
  ) => void;
  onQuestionReply: (
    sessionId: string,
    requestId: number,
    reply: UserQuestionReply,
  ) => void;
  onQuestionInteraction?: (sessionId: string, requestId: number) => void;
  onOpenFile: (path: string) => void;
  editorNavigation?: EditorNavigationTarget | null;
  onOpenDiff: (
    path?: string,
    session?: { sessionId: string; cwd: string },
  ) => void;
  onOpenPlan: (sessionId: string, blockId: string) => void;
  onUpdatePlan: (sessionId: string, blockId: string, text: string) => void;
  onBuildPlan: (
    sessionId: string,
    blockId: string,
    target?: PlanBuildTarget,
  ) => void;
  onSecondOpinion?: (
    sessionId: string,
    target: ModelTarget,
    turn: Block[],
  ) => void;
  onHandoff?: (sessionId: string, target: ModelTarget, turn: Block[]) => void;
  onMovePane: (fromId: string, toId: string, edge: PaneEdge) => void;
  onDetachPane: (
    paneId: string,
    targetTabId: string,
    position: TitleTabDropPosition,
  ) => void;
  onNewTerminal: (sessionId: string) => void;
  onTerminalMetaChange?: (fileId: string, patch: TerminalMetaPatch) => void;
  onBrowserMetaChange?: (fileId: string, patch: BrowserMetaPatch) => void;
  onRunAgentAction?: (args: {
    sourceSessionId: string;
    cwd: string;
    harness: HarnessId;
    model: string;
    text: string;
    action: import("../lib/agentActions").ActionRunRef;
  }) => void;
};

type Props = Shared & { layout: LayoutNode };

type PaneDrag = {
  fromId: string;
  overId: string | null;
  edge: PaneEdge;
};

const DRAG_THRESHOLD = 5;
/** Compact dock size while a browser is expanded: ~24rem, capped at a
 * fraction of the pane area so the dock never dominates a small window. */
const DOCK_PX = 24 * 16;
const DOCK_FRAC = 0.4;

/** A leaf docked while a browser is expanded keeps the edge it already
 * hugs, shrunk to a compact band; the expanded pane fills the rest. */
type DockBand = {
  side: "left" | "right" | "top" | "bottom";
  agent: LayoutRect;
  rest: LayoutRect;
};

function dockBand(
  rect: LayoutRect,
  tree: { w: number; h: number },
): DockBand {
  const E = 1e-3;
  let side: DockBand["side"];
  if (rect.h > 1 - E && rect.y < E) {
    side = rect.x + rect.w / 2 < 0.5 ? "left" : "right";
  } else if (rect.w > 1 - E && rect.x < E) {
    side = rect.y + rect.h / 2 < 0.5 ? "top" : "bottom";
  } else {
    const d = {
      left: rect.x,
      right: 1 - rect.x - rect.w,
      top: rect.y,
      bottom: 1 - rect.y - rect.h,
    };
    side = (Object.keys(d) as DockBand["side"][]).reduce((a, b) =>
      d[a] <= d[b] ? a : b,
    );
  }
  const span = tree.w > 0 ? Math.min(DOCK_PX / tree.w, DOCK_FRAC) : DOCK_FRAC;
  const spanY =
    tree.h > 0 ? Math.min(DOCK_PX / tree.h, DOCK_FRAC) : DOCK_FRAC;
  const w = Math.min(rect.w, span);
  const h = Math.min(rect.h, spanY);
  switch (side) {
    case "left":
      return {
        side,
        agent: { x: 0, y: 0, w, h: 1 },
        rest: { x: w, y: 0, w: 1 - w, h: 1 },
      };
    case "right":
      return {
        side,
        agent: { x: 1 - w, y: 0, w, h: 1 },
        rest: { x: 0, y: 0, w: 1 - w, h: 1 },
      };
    case "top":
      return {
        side,
        agent: { x: 0, y: 0, w: 1, h },
        rest: { x: 0, y: h, w: 1, h: 1 - h },
      };
    default:
      return {
        side,
        agent: { x: 0, y: 1 - h, w: 1, h },
        rest: { x: 0, y: 0, w: 1, h: 1 - h },
      };
  }
}

function PaneTreeComponent({
  sessionPortal,
  visible,
  layout,
  sessions,
  editorPanes,
  dirtyFileIds,
  fileErrorCounts,
  focusedId,
  addToChatSessionId,
  composerFocused,
  recents,
  hideProjectPicker,
  onFocus,
  onClose,
  onSelectFile,
  onCloseFile,
  onCloseOtherFiles,
  onReorderFiles,
  onFileDirtyChange,
  onFileErrorCountChange,
  onRatio,
  onCwdChange,
  onBranchChange,
  onModelChange,
  onModelSettingsChange,
  onRuntimeModeChange,
  onSubmit,
  onStop,
  onCompactContext,
  onPlaceSessionInFolder,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  onQueuedMessageEditingChange,
  onSteerQueuedMessage,
  onResumeQueue,
  onAddIssues,
  onOpenTaskChild,
  onRetryTaskChild,
  onSetupTaskChild,
  needsInputSessionIds,
  onInboxCardDismiss,
  onLinkedWorkItemUpdateCardDismiss,
  onNoteCardDismiss,
  onHandoffCardDismiss,
  onOpenLinkedWorkItem,
  onArchiveSession,
  onDeleteSession,
  onApproval,
  onQuestionReply,
  onQuestionInteraction,
  onOpenFile,
  editorNavigation,
  onOpenDiff,
  onOpenPlan,
  onUpdatePlan,
  onBuildPlan,
  onSecondOpinion,
  onHandoff,
  onMovePane,
  onDetachPane,
  onNewTerminal,
  onTerminalMetaChange,
  onBrowserMetaChange,
  onRunAgentAction,
}: Props) {
  const treeRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [draft, setDraft] = useState<LayoutNode | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDrag | null>(null);
  const externalDrop = useExternalPaneDrop(visible);
  const drop = paneDrag ?? externalDrop;
  const onMovePaneRef = useRef(onMovePane);
  onMovePaneRef.current = onMovePane;
  const onDetachPaneRef = useRef(onDetachPane);
  onDetachPaneRef.current = onDetachPane;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  useEffect(() => {
    setDraft(null);
  }, [layout]);

  // The expanded-browser dock needs pixel bounds; rects stay fractional.
  const [treeSize, setTreeSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const update = () =>
      setTreeSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A sash drag re-renders this tree every frame. `SessionPane` compares props
  // shallowly, so handing it a fresh drag handler each frame would re-render
  // the whole session subtree (transcript, composer, picker) per frame.
  const dragHandlers = useRef(
    new Map<string, (event: ReactPointerEvent<HTMLElement>) => void>(),
  );
  const paneDragStartFor = (paneId: string) => {
    const cached = dragHandlers.current.get(paneId);
    if (cached) return cached;
    const handler = (event: ReactPointerEvent<HTMLElement>) =>
      startPaneDrag(paneId, event);
    dragHandlers.current.set(paneId, handler);
    return handler;
  };

  const tree = draft ?? layout;
  const leaves = layoutLeaves(tree);
  const sashes = layoutSashes(tree);
  const inSplit = leaves.length > 1;
  // A browser tab flagged `expanded` zooms its leaf over the tree —
  // tmux-style pane zoom — while the focused session keeps its own edge,
  // shrunk to a compact dock band; everything else stays covered.
  // Other leaves stay mounted underneath (sessions keep running,
  // composers keep drafts); only their native webviews must be told to
  // hide via `occluded`.
  const expandedLeafId = leaves.find((leaf) => {
    const pane = editorPanes.find((entry) => entry.id === leaf.id);
    const file = pane?.files.find((entry) => entry.id === pane.activeFileId);
    return !!file?.browser?.expanded;
  })?.id;
  const isSessionLeaf = (id: string) => sessions.some((s) => s.id === id);
  const chatLeafId = expandedLeafId
    ? (focusedId !== expandedLeafId && isSessionLeaf(focusedId)
        ? focusedId
        : leaves.find(
            (leaf) => leaf.id !== expandedLeafId && isSessionLeaf(leaf.id),
          )?.id)
    : undefined;
  const chatRect = leaves.find((leaf) => leaf.id === chatLeafId)?.rect;
  const band =
    expandedLeafId && chatRect ? dockBand(chatRect, treeSize) : null;
  // A session spanning nearly the whole area leaves a useless sliver —
  // expand fully and let it stay covered instead.
  const dock = band && band.rest.w > 0.05 && band.rest.h > 0.05 ? band : null;
  const dockBorder = dock
    ? {
        left: "border-r",
        right: "border-l",
        top: "border-b",
        bottom: "border-t",
      }[dock.side]
    : "";

  const startPaneDrag = useCallback(
    (fromId: string, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let active = false;

      let lastX = startX;
      let lastY = startY;
      handle.setPointerCapture(pointerId);
      const restoreSelection = suppressTextSelection();

      const onMove = (ev: PointerEvent) => {
        lastX = ev.clientX;
        lastY = ev.clientY;
        if (!active) {
          if (
            Math.hypot(ev.clientX - startX, ev.clientY - startY) <
            DRAG_THRESHOLD
          ) {
            return;
          }
          active = true;
          setGrabbing(true);
          onFocusRef.current(fromId);
          setPaneDrag({ fromId, overId: null, edge: "left" });
        }
        const titleTab = titleTabDropFromPoint(ev.clientX, ev.clientY);
        setExternalTitleTabDrop(titleTab ? { fromId, ...titleTab } : null);
        if (titleTab) {
          setPaneDrag({ fromId, overId: null, edge: "left" });
          return;
        }
        const over = paneDropFromPoint(ev.clientX, ev.clientY);
        if (!over || over.id === fromId) {
          setPaneDrag({
            fromId,
            overId: over?.id === fromId ? fromId : null,
            edge: over?.edge ?? "left",
          });
          return;
        }
        setPaneDrag({ fromId, overId: over.id, edge: over.edge });
      };

      const onUp = () => finish(true);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        finish(false);
      };

      function finish(commit: boolean) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("keydown", onKey);
        restoreSelection();
        setGrabbing(false);
        setPaneDrag(null);
        setExternalTitleTabDrop(null);
        try {
          handle.releasePointerCapture(pointerId);
        } catch {
          /* already released */
        }
        if (!active || !commit) return;
        const titleTab = titleTabDropFromPoint(lastX, lastY);
        if (titleTab) {
          onDetachPaneRef.current(
            fromId,
            titleTab.targetTabId,
            titleTab.position,
          );
          return;
        }
        const over = paneDropFromPoint(lastX, lastY);
        if (over && over.id !== fromId) {
          onMovePaneRef.current(fromId, over.id, over.edge);
        }
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      window.addEventListener("keydown", onKey);
    },
    [],
  );

  return (
    <div ref={treeRef} className="relative h-full min-h-0 min-w-0">
      {leaves.map((leaf) => {
        const editorPane = editorPanes.find((pane) => pane.id === leaf.id);
        const session = sessions.find((entry) => entry.id === leaf.id);
        const dragging = drop?.fromId === leaf.id;
        const onPaneDragStart = inSplit ? paneDragStartFor(leaf.id) : undefined;
        const expanded = leaf.id === expandedLeafId;
        const docked = leaf.id === chatLeafId;
        const rendered: LayoutRect = expanded
          ? (dock?.rest ?? { x: 0, y: 0, w: 1, h: 1 })
          : docked && dock
            ? dock.agent
            : leaf.rect;
        const backgroundStyle = {
          "--chat-background-left": `${(-rendered.x / rendered.w) * 100}%`,
          "--chat-background-top": `${(-rendered.y / rendered.h) * 100}%`,
          "--chat-background-width": `${100 / rendered.w}%`,
          "--chat-background-height": `${100 / rendered.h}%`,
        } as CSSProperties;
        return (
          <div
            key={leaf.id}
            data-pane-id={leaf.id}
            className={`absolute flex min-h-0 min-w-0 flex-col overflow-hidden ${dragging ? "opacity-40" : ""} ${expanded || docked ? "bg-background-base" : ""} ${docked ? `${dockBorder} border-content/10` : ""}`}
            style={{
              left: `${rendered.x * 100}%`,
              top: `${rendered.y * 100}%`,
              width: `${rendered.w * 100}%`,
              height: `${rendered.h * 100}%`,
              ...(expanded ? { zIndex: 30 } : docked ? { zIndex: 40 } : {}),
              ...backgroundStyle,
            }}
          >
            {drop && drop.overId === leaf.id && drop.fromId !== leaf.id ? (
              <PaneDropHint edge={drop.edge} />
            ) : null}
            {editorPane ? (
              <FilePane
                pane={editorPane}
                visible={visible}
                occluded={!!expandedLeafId && !expanded}
                focused={focusedId === editorPane.id}
                dirtyFileIds={dirtyFileIds}
                fileErrorCounts={fileErrorCounts}
                sessions={sessions}
                onFocus={onFocus}
                onSelectFile={onSelectFile}
                onCloseFile={onCloseFile}
                onCloseOtherFiles={onCloseOtherFiles}
                onReorderFiles={onReorderFiles}
                onDirtyChange={onFileDirtyChange}
                onErrorCountChange={onFileErrorCountChange}
                onOpenFile={onOpenFile}
                onUpdatePlan={onUpdatePlan}
                onBuildPlan={onBuildPlan}
                editorNavigation={editorNavigation}
                onPaneDragStart={onPaneDragStart}
                onTerminalMetaChange={onTerminalMetaChange}
                onBrowserMetaChange={onBrowserMetaChange}
              />
            ) : session ? (
              <SessionSurface host={sessionPortal?.sessionId === session.id ? sessionPortal.host : undefined}>
              <SessionPane
                session={session}
                reviewUndoLocked={sessions.some(
                  (other) =>
                    other.id !== session.id &&
                    other.busy &&
                    sameProjectPath(
                      sessionWorkCwd(other),
                      sessionWorkCwd(session),
                    ),
                )}
                visible={visible || sessionPortal?.sessionId === session.id}
                focused={focusedId === session.id || sessionPortal?.sessionId === session.id}
                addToChatTarget={addToChatSessionId === session.id}
                inSplit={inSplit}
                composerFocused={composerFocused}
                recents={recents}
                hideProjectPicker={hideProjectPicker}
                onFocus={onFocus}
                onClose={onClose}
                onCwdChange={onCwdChange}
                onBranchChange={onBranchChange}
                onModelChange={onModelChange}
                onModelSettingsChange={onModelSettingsChange}
                onRuntimeModeChange={onRuntimeModeChange}
                onSubmit={onSubmit}
                onStop={onStop}
                onCompactContext={onCompactContext}
                onPlaceSessionInFolder={onPlaceSessionInFolder}
                onDeleteQueuedMessage={onDeleteQueuedMessage}
                onEditQueuedMessage={onEditQueuedMessage}
                onQueuedMessageEditingChange={onQueuedMessageEditingChange}
                onSteerQueuedMessage={onSteerQueuedMessage}
                onResumeQueue={onResumeQueue}
                onAddIssues={onAddIssues}
                onOpenTaskChild={onOpenTaskChild}
                onRetryTaskChild={onRetryTaskChild}
                onSetupTaskChild={onSetupTaskChild}
                needsInputSessionIds={needsInputSessionIds}
                onInboxCardDismiss={onInboxCardDismiss}
                onLinkedWorkItemUpdateCardDismiss={
                  onLinkedWorkItemUpdateCardDismiss
                }
                onNoteCardDismiss={onNoteCardDismiss}
                onHandoffCardDismiss={onHandoffCardDismiss}
                onOpenLinkedWorkItem={onOpenLinkedWorkItem}
                onArchiveSession={onArchiveSession}
                onDeleteSession={onDeleteSession}
                onApproval={onApproval}
                onQuestionReply={onQuestionReply}
                onQuestionInteraction={onQuestionInteraction}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
                onOpenPlan={onOpenPlan}
                onBuildPlan={onBuildPlan}
                onSecondOpinion={onSecondOpinion}
                onHandoff={onHandoff}
                onNewTerminal={onNewTerminal}
                onPaneDragStart={onPaneDragStart}
                onRunAgentAction={onRunAgentAction}
              />
              </SessionSurface>
            ) : null}
          </div>
        );
      })}
      {(expandedLeafId ? [] : sashes).map((sash) => (
        <Sash
          key={`${sash.splitId}:${sash.index}`}
          sash={sash}
          containerRef={treeRef}
          onPreview={(ratio) =>
            setDraft(
              setSplitRatio(layoutRef.current, sash.splitId, sash.index, ratio),
            )
          }
          onCommit={(ratio) => {
            setDraft(null);
            onRatio(sash.splitId, sash.index, ratio);
          }}
          onCancel={() => setDraft(null)}
        />
      ))}
    </div>
  );
}

export const PaneTree = memo(
  PaneTreeComponent,
  (previous, next) => !previous.visible && !next.visible && !previous.sessionPortal && !next.sessionPortal,
);

function PaneDropHint({ edge }: { edge: PaneEdge }) {
  const wash =
    edge === "left"
      ? "absolute inset-y-0 left-0 w-1/2 bg-accent/15"
      : edge === "right"
        ? "absolute inset-y-0 right-0 w-1/2 bg-accent/15"
        : edge === "top"
          ? "absolute inset-x-0 top-0 h-1/2 bg-accent/15"
          : "absolute inset-x-0 bottom-0 h-1/2 bg-accent/15";
  const line =
    edge === "left"
      ? "absolute inset-y-0 left-0 w-0.5 bg-accent"
      : edge === "right"
        ? "absolute inset-y-0 right-0 w-0.5 bg-accent"
        : edge === "top"
          ? "absolute inset-x-0 top-0 h-0.5 bg-accent"
          : "absolute inset-x-0 bottom-0 h-0.5 bg-accent";
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className={wash} />
      <div className={line} />
    </div>
  );
}

function Sash({
  sash,
  containerRef,
  onPreview,
  onCommit,
  onCancel,
}: {
  sash: LayoutSash;
  containerRef: { current: HTMLDivElement | null };
  onPreview: (ratio: number) => void;
  onCommit: (ratio: number) => void;
  onCancel: () => void;
}) {
  const row = sash.dir === "right";
  const boundary = sash.sizes
    .slice(0, sash.index + 1)
    .reduce((sum, size) => sum + size, 0);
  const group = sash.group;

  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(boundary * 100)}
      className={
        row
          ? "absolute z-10 w-px bg-stroke"
          : "absolute z-10 h-px bg-stroke"
      }
      style={
        row
          ? {
              left: `${(group.x + boundary * group.w) * 100}%`,
              top: `${group.y * 100}%`,
              height: `${group.h * 100}%`,
            }
          : {
              left: `${group.x * 100}%`,
              top: `${(group.y + boundary * group.h) * 100}%`,
              width: `${group.w * 100}%`,
            }
      }
    >
      <div
        className={
          row
            ? "absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize touch-none"
            : "absolute inset-x-0 -top-1.5 -bottom-1.5 cursor-row-resize touch-none"
        }
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const handle = e.currentTarget;
          const parent = containerRef.current;
          if (!parent) return;
          handle.setPointerCapture(e.pointerId);
          const rect = parent.getBoundingClientRect();
          const restoreSelection = suppressTextSelection();
          const previousCursor = document.body.style.cursor;
          document.body.style.cursor = row ? "col-resize" : "row-resize";
          const origin = row
            ? rect.left + group.x * rect.width
            : rect.top + group.y * rect.height;
          const span = row ? group.w * rect.width : group.h * rect.height;
          let nextBoundary = boundary;
          let moved = false;
          let frame: number | null = null;

          const move = (ev: PointerEvent) => {
            const pos = row ? ev.clientX : ev.clientY;
            if (span <= 0) return;
            moved = true;
            nextBoundary = (pos - origin) / span;
            if (frame != null) return;
            frame = requestAnimationFrame(() => {
              frame = null;
              onPreview(nextBoundary);
            });
          };
          const finish = (commit: boolean) => {
            if (frame != null) {
              cancelAnimationFrame(frame);
              frame = null;
            }
            if (handle.hasPointerCapture(e.pointerId)) {
              handle.releasePointerCapture(e.pointerId);
            }
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", cancel);
            window.removeEventListener("keydown", keydown);
            restoreSelection();
            document.body.style.cursor = previousCursor;
            if (!moved) return;
            if (commit) onCommit(nextBoundary);
            else onCancel();
          };
          const up = () => finish(true);
          const cancel = () => finish(false);
          const keydown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            finish(false);
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", up);
          handle.addEventListener("pointercancel", cancel);
          window.addEventListener("keydown", keydown);
        }}
      />
    </div>
  );
}
