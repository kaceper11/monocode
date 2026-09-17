import {
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ACTION_CONTEXT_LABEL,
  ACTION_CONTEXTS,
  MAX_ACTION_INSTRUCTIONS,
  actionContextSources,
  agentActionsSnapshot,
  composeActionPrompt,
  deleteAgentAction,
  gatherActionContext,
  loadAgentActions,
  moveAgentAction,
  saveAgentAction,
  subscribeAgentActions,
  type AgentAction,
  type AgentActionContext,
  type ActionRunRef,
} from "../lib/agentActions";
import type { ProjectRecord } from "../lib/projects";
import { isLiveHarness } from "../lib/harness";
import { prettyCwd } from "../lib/paths";
import {
  HARNESS_TITLE,
  sessionDisplayTitle,
  type HarnessId,
  type Session,
} from "../lib/session";
import type { TaskWorkspace } from "../lib/taskWorkspaces";
import { Checkbox, Radio } from "./controls";
import { ask } from "../lib/dialogs";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { SecondOpinionButton } from "./SecondOpinionButton";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "./icons";

const inputClass =
  "w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none ring-accent/40 focus:ring-1";
const labelClass =
  "mb-1 block text-[11px] font-medium uppercase tracking-wide text-content/45";

export type ActionRun = {
  text: string;
  action: ActionRunRef;
};

/**
 * Review-and-run sheet for one action: editable instructions, the context
 * that will be captured at submit time, and a clear destination. Gathering
 * happens on Run — the sheet never snapshots context while it sits open.
 */
export function AgentActionSheet({
  action,
  session,
  workCwd,
  task,
  project,
  onRun,
  onRunNew,
  onClose,
}: {
  action: AgentAction;
  session: Session;
  workCwd: string;
  task?: TaskWorkspace | null;
  project?: ProjectRecord;
  onRun: (run: ActionRun) => void;
  onRunNew?: (
    run: ActionRun,
    destination: { cwd: string; harness: HarnessId; model: string },
  ) => void;
  onClose: () => void;
}) {
  const [instructions, setInstructions] = useState(action.instructions);
  const sources = useMemo(
    () =>
      actionContextSources({
        task,
        ticket: task?.ticket ?? session.linkedWorkItem,
        cwd: workCwd,
      }),
    [task, session, workCwd],
  );
  const [selected, setSelected] = useState<Set<AgentActionContext>>(
    () =>
      new Set(
        action.context.filter((kind) =>
          sources.find((source) => source.kind === kind)?.available,
        ),
      ),
  );
  const [destination, setDestination] = useState<"session" | "new">("session");
  const [target, setTarget] = useState<{
    harness: HarnessId;
    model: string;
  }>({ harness: session.harness, model: session.model });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const destinationName = useId();
  /** Set when the sheet closes mid-gather so a late resolve can't submit. */
  const closedRef = useRef(false);
  const close = () => {
    closedRef.current = true;
    onClose();
  };

  // Only "This conversation" can double-queue; a new session starts empty.
  const queued =
    destination === "session" &&
    session.queuedMessages?.some(
      (message) => message.action?.actionId === action.id,
    );
  const live = isLiveHarness(session.harness);
  const busy = session.busy;
  const valid = instructions.trim().length > 0;

  const toggle = (kind: AgentActionContext) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const run = async () => {
    if (running || !valid || queued) return;
    setRunning(true);
    setError("");
    try {
      const sections = await gatherActionContext({
        kinds: [...selected],
        task,
        project,
        ticket: task?.ticket ?? session.linkedWorkItem,
        cwd: workCwd,
      });
      // The sheet may have been closed while context was still gathering.
      if (closedRef.current) return;
      const composed = composeActionPrompt({
        name: action.name,
        instructions,
        sections,
      });
      const runRef: ActionRunRef = {
        actionId: action.id,
        name: action.name,
        revision: composed.revision,
      };
      const runData = { text: composed.text, action: runRef };
      if (destination === "new" && onRunNew) {
        onRunNew(runData, { cwd: workCwd, ...target });
      } else {
        onRun(runData);
      }
      close();
    } catch (cause) {
      if (!closedRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setRunning(false);
      }
    }
  };

  const primary = queued
    ? "Queued"
    : destination === "new"
      ? "Start session and run"
      : busy
        ? "Queue"
        : "Run";

  return (
    <Modal
      title={action.name}
      description={
        destination === "new"
          ? `Starts a new conversation in ${prettyCwd(workCwd)}`
          : `Runs in ${sessionDisplayTitle(session.title, session.harness)}`
      }
      size="md"
      onClose={close}
    >
      <div className="flex flex-col gap-4 px-4 pb-4 pt-1">
        <div>
          <label className={labelClass} htmlFor="action-instructions">
            Instructions
          </label>
          <textarea
            id="action-instructions"
            autoFocus
            rows={5}
            value={instructions}
            maxLength={MAX_ACTION_INSTRUCTIONS}
            onChange={(event) => setInstructions(event.target.value)}
            className={`${inputClass} resize-y`}
            placeholder="What should the agent do?"
          />
          <p className="mt-1 text-[11px] text-content/40">
            Prompt text only — never put tokens or secrets here.
          </p>
        </div>

        {sources.some((source) => source.available) ? (
          <div>
            <span className={labelClass}>Context</span>
            <div className="flex flex-col gap-2">
              {sources.map((source) => (
                <label
                  key={source.kind}
                  className="flex items-start gap-2 text-[13px] text-content"
                >
                  <Checkbox
                    label={ACTION_CONTEXT_LABEL[source.kind]}
                    checked={
                      source.available && selected.has(source.kind)
                    }
                    disabled={!source.available}
                    onChange={() => toggle(source.kind)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      {ACTION_CONTEXT_LABEL[source.kind]}
                    </span>
                    {source.reason ? (
                      <span className="block text-[11px] text-content/40">
                        {source.reason}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <span className={labelClass}>Destination</span>
          <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-content">
              <Radio
                label="Send to this conversation"
                name={destinationName}
                checked={destination === "session"}
                onChange={() => setDestination("session")}
                className=""
              />
              <span className="min-w-0 flex-1 truncate">
                This conversation
                <span className="text-content/45">
                  {` — ${HARNESS_TITLE[session.harness]}${session.model ? ` · ${session.model}` : ""}`}
                </span>
              </span>
            </label>
            {onRunNew ? (
              <div className="flex items-center gap-2 text-[13px] text-content">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <Radio
                    label="Send to a new conversation"
                    name={destinationName}
                    checked={destination === "new"}
                    onChange={() => setDestination("new")}
                    className=""
                  />
                  <span className="min-w-0 flex-1 truncate">
                    New conversation
                    <span className="text-content/45">
                      {` — ${prettyCwd(workCwd)}`}
                    </span>
                  </span>
                </label>
                {destination === "new" ? (
                  <SecondOpinionButton
                    cwd={workCwd}
                    from={session.harness}
                    fromModel={session.model}
                    includeCurrent
                    title={`${HARNESS_TITLE[target.harness]}${target.model ? ` · ${target.model}` : ""}`}
                    menuLabel="Run this action with"
                    onPick={(target) => setTarget(target)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          {!live && destination === "session" ? (
            <p className="mt-1 text-[11px] text-amber-500/90">
              {HARNESS_TITLE[session.harness]} is not connected — the run will
              be recorded but cannot execute until it signs in.
            </p>
          ) : null}
        </div>

        {error ? (
          <p className="text-[12px] text-red-400" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="h-7 rounded-md px-2.5 text-[13px] text-content/70 hover:bg-content/10 hover:text-content"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || running || queued}
            onClick={() => void run()}
            className="flex h-7 items-center gap-1.5 rounded-md bg-content px-3 text-[13px] font-medium text-background-base hover:bg-content/80 disabled:opacity-40"
          >
            {running ? (
              <Loader className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" strokeWidth={1.75} />
            )}
            {primary}
          </button>
        </div>
      </div>
    </Modal>
  );
}

type ActionDraft = {
  name: string;
  instructions: string;
  context: AgentActionContext[];
  projectId?: string;
};

/**
 * Manage sheet: every action, reordered and edited in place. Project scope is
 * only offered when the current context resolves to a stored project.
 */
export function AgentActionsSheet({
  project,
  onClose,
}: {
  project?: ProjectRecord;
  onClose: () => void;
}) {
  const raw = useSyncExternalStore(
    subscribeAgentActions,
    agentActionsSnapshot,
  );
  const actions = useMemo(() => loadAgentActions(), [raw]);
  const [editing, setEditing] = useState<
    { id?: string; draft: ActionDraft } | null
  >(null);
  const [error, setError] = useState("");

  const startNew = () =>
    setEditing({
      draft: {
        name: "",
        instructions: "",
        context: ["task"],
        ...(project ? { projectId: project.id } : {}),
      },
    });
  const startEdit = (action: AgentAction) =>
    setEditing({
      id: action.id,
      draft: {
        name: action.name,
        instructions: action.instructions,
        context: action.context,
        projectId: action.projectId,
      },
    });

  const save = () => {
    if (!editing) return;
    const result = saveAgentAction(
      {
        name: editing.draft.name,
        instructions: editing.draft.instructions,
        context: editing.draft.context,
        projectId: editing.draft.projectId,
      },
      editing.id,
    );
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(null);
    setError("");
  };

  return (
    <Modal
      title="Agent actions"
      description="Saved prompts run on a task or conversation"
      size="md"
      onClose={onClose}
    >
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        {editing ? (
          <div className="flex flex-col gap-3 rounded-lg border border-content/10 bg-content/3 p-3">
            <div>
              <label className={labelClass} htmlFor="action-name">
                Name
              </label>
              <input
                id="action-name"
                autoFocus
                value={editing.draft.name}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    draft: { ...editing.draft, name: event.target.value },
                  })
                }
                className={inputClass}
                placeholder="e.g. Update translations"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="action-edit-instructions">
                Instructions
              </label>
              <textarea
                id="action-edit-instructions"
                rows={4}
                value={editing.draft.instructions}
                onChange={(event) =>
                  setEditing({
                    ...editing,
                    draft: {
                      ...editing.draft,
                      instructions: event.target.value,
                    },
                  })
                }
                className={`${inputClass} resize-y`}
                placeholder="What should the agent do?"
              />
            </div>
            <div>
              <span className={labelClass}>Context</span>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {ACTION_CONTEXTS.map((kind) => (
                  <label
                    key={kind}
                    className="flex items-center gap-2 text-[13px] text-content"
                  >
                    <Checkbox
                      label={ACTION_CONTEXT_LABEL[kind]}
                      className="mt-0"
                      checked={editing.draft.context.includes(kind)}
                      onChange={() =>
                        setEditing({
                          ...editing,
                          draft: {
                            ...editing.draft,
                            context: editing.draft.context.includes(kind)
                              ? editing.draft.context.filter(
                                  (entry) => entry !== kind,
                                )
                              : [...editing.draft.context, kind],
                          },
                        })
                      }
                    />
                    {ACTION_CONTEXT_LABEL[kind]}
                  </label>
                ))}
              </div>
            </div>
            {project ? (
              <div>
                <span className={labelClass}>Scope</span>
                <Select
                  label="Action scope"
                  value={
                    editing.draft.projectId
                      ? editing.draft.projectId === project.id
                        ? "project"
                        : "other"
                      : "all"
                  }
                  options={[
                    { value: "project", label: `This project` },
                    { value: "all", label: "All projects" },
                    ...(editing.draft.projectId &&
                    editing.draft.projectId !== project.id
                      ? [{ value: "other", label: "Another project" }]
                      : []),
                  ]}
                  onChange={(value) =>
                    setEditing({
                      ...editing,
                      draft: {
                        ...editing.draft,
                        projectId:
                          value === "project"
                            ? project.id
                            : value === "other"
                              ? editing.draft.projectId
                              : undefined,
                      },
                    })
                  }
                />
              </div>
            ) : null}
            {error ? (
              <p className="text-[12px] text-red-400" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setError("");
                }}
                className="h-7 rounded-md px-2.5 text-[13px] text-content/70 hover:bg-content/10 hover:text-content"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                className="flex h-7 items-center gap-1.5 rounded-md bg-content px-3 text-[13px] font-medium text-background-base hover:bg-content/80"
              >
                <Check className="size-3.5" strokeWidth={1.75} />
                Save action
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col">
              {actions.map((action, index) => (
                <div
                  key={action.id}
                  className="flex items-center gap-1 border-b border-content/8 py-1.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-content">
                      {action.name}
                    </div>
                    <div className="truncate text-[11px] text-content/40">
                      {action.projectId
                        ? project && action.projectId === project.id
                          ? "This project"
                          : "Another project"
                        : "All projects"}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Move ${action.name} up`}
                    disabled={index === 0}
                    onClick={() => moveAgentAction(action.id, -1)}
                    className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-30"
                  >
                    <ChevronUp className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${action.name} down`}
                    disabled={index === actions.length - 1}
                    onClick={() => moveAgentAction(action.id, 1)}
                    className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-30"
                  >
                    <ChevronDown className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${action.name}`}
                    onClick={() => startEdit(action)}
                    className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${action.name}`}
                    onClick={() => {
                      void (async () => {
                        if (
                          await ask(`Delete action “${action.name}”?`, {
                            title: "MonoCode",
                            kind: "warning",
                            okLabel: "Delete",
                          })
                        )
                          deleteAgentAction(action.id);
                      })();
                    }}
                    className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-red-400"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
              {actions.length === 0 ? (
                <p className="py-3 text-center text-[12px] text-content/45">
                  No actions yet.
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={startNew}
              className="flex h-7 items-center gap-1.5 self-start rounded-md px-2 text-[13px] text-content/70 hover:bg-content/10 hover:text-content"
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
              New action
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
