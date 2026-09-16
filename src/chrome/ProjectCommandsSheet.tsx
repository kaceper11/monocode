import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  MAX_COMMAND_STEPS,
  QUALITY_COMMAND_ID,
  deleteProjectCommand,
  deleteProjectCommandGroup,
  loadProjects,
  moveProjectCommand,
  moveProjectCommandGroup,
  projectsSnapshot,
  repositoryDisplayName,
  saveProjectCommand,
  saveProjectCommandGroup,
  setProjectVerify,
  subscribeProjects,
  type CommandStep,
  type ProjectCommand,
} from "../lib/projects";
import {
  deleteReusableCommand,
  loadReusableCommands,
  moveReusableCommand,
  reusableCommandsSnapshot,
  saveReusableCommand,
  subscribeReusableCommands,
  type ReusableCommand,
} from "../lib/projectCommands";
import { ContextCheckbox } from "./InboxContextPicker";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { gitDiffIndex } from "../lib/fs";
import { probeQuality, qualitySteps, type QualityStep } from "../lib/quality";
import { MAX_FIX_SENDS, resolveVerifyForProject } from "../lib/verify";
import { Check, ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "./icons";

const inputClass =
  "w-full rounded-lg border border-content/10 bg-content/5 px-2.5 py-1.5 text-[13px] text-content outline-none ring-accent/40 focus:ring-1";
const labelClass =
  "mb-1 block text-[11px] font-medium uppercase tracking-wide text-content/45";

type CommandDraft = {
  name: string;
  command: string;
  repositoryId?: string;
  relativeCwd?: string;
  steps?: CommandStep[];
};

type EditState =
  | { scope: "project"; id?: string; draft: CommandDraft }
  | { scope: "reusable"; id?: string; draft: CommandDraft }
  | {
      scope: "group";
      id?: string;
      draft: { name: string; commandIds: string[] };
    };

/**
 * Manage sheet for saved commands. Project commands bind to a member
 * repository (their task worktree inside a task); reusable commands run in
 * whatever task or project folder they are launched from.
 */
export function ProjectCommandsSheet({
  projectId,
  focus,
  onClose,
}: {
  projectId: string;
  /** Open scrolled to a section — the Automations check rows land on their
   * controls instead of the top of the command list. */
  focus?: "checks";
  onClose: () => void;
}) {
  const raw = useSyncExternalStore(
    subscribeReusableCommands,
    reusableCommandsSnapshot,
  );
  const reusable = useMemo(() => loadReusableCommands(), [raw]);
  // Re-derive the record on every store write so saves/deletes/moves are
  // visible immediately — a snapshot prop would stay stale.
  const projectsRaw = useSyncExternalStore(subscribeProjects, projectsSnapshot);
  const project = useMemo(
    () => loadProjects().find((entry) => entry.id === projectId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectsRaw, projectId],
  );
  const [editing, setEditing] = useState<EditState | null>(null);
  const [error, setError] = useState("");
  const checksRef = useRef<HTMLDivElement>(null);
  const isQuality = project?.verify?.commandId === QUALITY_COMMAND_ID;
  const [detectedSteps, setDetectedSteps] = useState<QualityStep[] | null>(
    null,
  );

  // "Auto-detected" should show what it detected — probe the project folder
  // once when the quality check is selected (the probe itself is cached).
  useEffect(() => {
    if (!isQuality || !project?.anchor) {
      setDetectedSteps(null);
      return;
    }
    let live = true;
    const cwd = project.anchor;
    setDetectedSteps(null);
    Promise.all([
      probeQuality(cwd),
      gitDiffIndex(cwd)
        .then((index) => index.isRepo !== false)
        .catch(() => false),
    ])
      .then(([probe, isGit]) => {
        if (live) setDetectedSteps(qualitySteps(probe, isGit));
      })
      .catch(() => {
        if (live) setDetectedSteps([]);
      });
    return () => {
      live = false;
    };
  }, [isQuality, project?.anchor]);

  useEffect(() => {
    if (!project) onClose();
  }, [project, onClose]);

  useEffect(() => {
    if (focus === "checks")
      checksRef.current?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  const commands = project?.commands ?? [];
  const groups = project?.commandGroups ?? [];

  if (!project) return null;

  const save = () => {
    if (!editing) return;
    let result: { error?: string };
    if (editing.scope === "group") {
      result = saveProjectCommandGroup(project.id, editing.draft, editing.id);
    } else {
      // Steps mode keeps `command` as faithful display text for menus, rows
      // and the terminal tab title.
      const draft = {
        ...editing.draft,
        command: editing.draft.steps?.length
          ? editing.draft.steps
              .map((step) => step.command)
              .filter(Boolean)
              .join("\n")
          : editing.draft.command,
      };
      result =
        editing.scope === "project"
          ? saveProjectCommand(project.id, draft, editing.id)
          : saveReusableCommand(draft, editing.id);
    }
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(null);
    setError("");
  };

  const rowButtons = (
    index: number,
    count: number,
    onMove: (delta: -1 | 1) => void,
    onEdit: () => void,
    onDelete: () => void,
    name: string,
  ) => (
    <>
      <button
        type="button"
        aria-label={`Move ${name} up`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
        className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-30"
      >
        <ChevronUp className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Move ${name} down`}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
        className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-30"
      >
        <ChevronDown className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Edit ${name}`}
        onClick={onEdit}
        className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={`Delete ${name}`}
        onClick={onDelete}
        className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-red-400"
      >
        <Trash2 className="size-3.5" />
      </button>
    </>
  );

  const commandRow = (
    command: ProjectCommand | ReusableCommand,
    index: number,
    count: number,
    scope: "project" | "reusable",
  ) => {
    const repo =
      "repositoryId" in command && command.repositoryId
        ? project.repositories.find(
            (entry) => entry.id === command.repositoryId,
          )
        : undefined;
    return (
      <div
        key={command.id}
        className="flex items-center gap-1 border-b border-content/8 py-1.5 last:border-b-0"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-content">
            {command.name}
          </div>
          <div className="truncate text-[11px] text-content/40">
            {command.command}
            {repo ? ` — ${repositoryDisplayName(repo)}` : ""}
            {command.relativeCwd ? ` · ${command.relativeCwd}` : ""}
          </div>
        </div>
        {rowButtons(
          index,
          count,
          (delta) =>
            scope === "project"
              ? moveProjectCommand(project.id, command.id, delta)
              : moveReusableCommand(command.id, delta),
          () =>
            setEditing({
              scope,
              id: command.id,
              draft: {
                name: command.name,
                command: command.command,
                ...("repositoryId" in command && command.repositoryId
                  ? { repositoryId: command.repositoryId }
                  : {}),
                ...(command.relativeCwd
                  ? { relativeCwd: command.relativeCwd }
                  : {}),
                ...(command.steps?.length
                  ? { steps: command.steps.map((step) => ({ ...step })) }
                  : {}),
              },
            }),
          () => {
            if (!window.confirm(`Delete command “${command.name}”?`)) return;
            if (scope === "project")
              deleteProjectCommand(project.id, command.id);
            else deleteReusableCommand(command.id);
          },
          command.name,
        )}
      </div>
    );
  };

  const editingCommand = editing && editing.scope !== "group" ? editing : null;
  const editingGroup = editing && editing.scope === "group" ? editing : null;

  return (
    <Modal
      title="Saved commands"
      description="Commands run in project terminals"
      size="md"
      onClose={onClose}
    >
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        {editing ? (
          <div className="flex flex-col gap-3 rounded-lg border border-content/10 bg-content/3 p-3">
            <div>
              <label className={labelClass} htmlFor="command-name">
                Name
              </label>
              <input
                id="command-name"
                autoFocus
                value={editing.draft.name}
                onChange={(event) =>
                  setEditing(
                    editing.scope === "group"
                      ? {
                          scope: "group",
                          id: editing.id,
                          draft: {
                            ...editing.draft,
                            name: event.target.value,
                          },
                        }
                      : {
                          ...editing,
                          draft: {
                            ...editing.draft,
                            name: event.target.value,
                          },
                        },
                  )
                }
                className={inputClass}
                placeholder="e.g. Dev server"
              />
            </div>
            {editingCommand ? (
              <>
                <div>
                  <label className="flex items-center gap-2 text-[13px] text-content">
                    <ContextCheckbox
                      label="Run as sequential steps"
                      className="mt-0"
                      checked={!!editingCommand.draft.steps}
                      onChange={() => {
                        const steps = editingCommand.draft.steps;
                        // Turning steps off keeps the edits as a line-per-step
                        // command instead of discarding them — but an all-empty
                        // step list must not wipe an existing command.
                        const joined = steps
                          ?.map((step) => step.command.trim())
                          .filter(Boolean)
                          .join("\n");
                        setEditing({
                          ...editingCommand,
                          draft: {
                            ...editingCommand.draft,
                            ...(steps?.length && joined
                              ? { command: joined }
                              : {}),
                            steps: steps
                              ? undefined
                              : [
                                  {
                                    command: editingCommand.draft.command,
                                  },
                                ],
                          },
                        });
                      }}
                    />
                    Run as sequential steps
                  </label>
                  <p className="mt-1 text-[11px] text-content/40">
                    Each step runs to completion before the next starts; a
                    failing step stops the run.
                  </p>
                </div>
                {editingCommand.draft.steps ? (
                  <div className="flex flex-col gap-1.5">
                    {editingCommand.draft.steps.map((step, index) => (
                      <div key={index} className="flex items-center gap-1.5">
                        <input
                          aria-label={`Step ${index + 1}`}
                          value={step.command}
                          onChange={(event) =>
                            setEditing({
                              ...editingCommand,
                              draft: {
                                ...editingCommand.draft,
                                steps: editingCommand.draft.steps?.map(
                                  (item, at) =>
                                    at === index
                                      ? { ...item, command: event.target.value }
                                      : item,
                                ),
                              },
                            })
                          }
                          className={`${inputClass} min-w-0 flex-1 font-mono`}
                          placeholder={
                            index === 0 ? "e.g. docker system prune -f" : ""
                          }
                        />
                        <div className="w-28 shrink-0">
                          <Select
                            label={`Step ${index + 1} host`}
                            value={step.host ?? ""}
                            options={[
                              { value: "", label: "Target" },
                              { value: "native", label: "OS host" },
                            ]}
                            onChange={(value) =>
                              setEditing({
                                ...editingCommand,
                                draft: {
                                  ...editingCommand.draft,
                                  steps: editingCommand.draft.steps?.map(
                                    (item, at) =>
                                      at === index
                                        ? {
                                            ...item,
                                            host:
                                              value === "native"
                                                ? "native"
                                                : undefined,
                                          }
                                        : item,
                                  ),
                                },
                              })
                            }
                          />
                        </div>
                        <button
                          type="button"
                          aria-label={`Remove step ${index + 1}`}
                          onClick={() =>
                            setEditing({
                              ...editingCommand,
                              draft: {
                                ...editingCommand.draft,
                                steps: editingCommand.draft.steps?.filter(
                                  (_, at) => at !== index,
                                ),
                              },
                            })
                          }
                          className="grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-red-400"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={
                        (editingCommand.draft.steps?.length ?? 0) >=
                        MAX_COMMAND_STEPS
                      }
                      onClick={() =>
                        setEditing({
                          ...editingCommand,
                          draft: {
                            ...editingCommand.draft,
                            steps: [
                              ...(editingCommand.draft.steps ?? []),
                              { command: "" },
                            ],
                          },
                        })
                      }
                      className="flex h-7 items-center gap-1.5 self-start rounded-md px-2 text-[13px] text-content/70 hover:bg-content/10 hover:text-content disabled:opacity-40"
                    >
                      <Plus className="size-3.5" strokeWidth={1.75} />
                      Add step
                    </button>
                    <p className="text-[11px] text-content/40">
                      OS host runs on the machine itself — use it for steps like{" "}
                      <span className="font-mono">wsl --shutdown</span> that
                      must outlive the WSL terminal.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className={labelClass} htmlFor="command-text">
                      Command
                    </label>
                    <input
                      id="command-text"
                      value={editingCommand.draft.command}
                      onChange={(event) =>
                        setEditing({
                          ...editingCommand,
                          draft: {
                            ...editingCommand.draft,
                            command: event.target.value,
                          },
                        })
                      }
                      className={`${inputClass} font-mono`}
                      placeholder="e.g. npm run dev"
                    />
                  </div>
                )}
                {editingCommand.scope === "project" &&
                project.repositories.length ? (
                  <div>
                    <span className={labelClass}>Repository</span>
                    <Select
                      label="Command repository"
                      value={editingCommand.draft.repositoryId ?? ""}
                      options={[
                        {
                          value: "",
                          label: "Task’s primary copy / project folder",
                        },
                        ...project.repositories.map((repo) => ({
                          value: repo.id,
                          label: repositoryDisplayName(repo),
                        })),
                      ]}
                      onChange={(value) =>
                        setEditing({
                          ...editingCommand,
                          draft: {
                            ...editingCommand.draft,
                            repositoryId: value || undefined,
                          },
                        })
                      }
                    />
                    <p className="mt-1 text-[11px] text-content/40">
                      Inside a task this runs in the repository’s task worktree.
                    </p>
                  </div>
                ) : null}
                <div>
                  <label className={labelClass} htmlFor="command-subdir">
                    Subdirectory (optional)
                  </label>
                  <input
                    id="command-subdir"
                    value={editingCommand.draft.relativeCwd ?? ""}
                    onChange={(event) =>
                      setEditing({
                        ...editingCommand,
                        draft: {
                          ...editingCommand.draft,
                          relativeCwd: event.target.value || undefined,
                        },
                      })
                    }
                    className={`${inputClass} font-mono`}
                    placeholder="e.g. packages/app"
                  />
                </div>
              </>
            ) : (
              <div>
                <span className={labelClass}>Commands</span>
                <div className="flex flex-col gap-1.5">
                  {commands.map((command) => (
                    <label
                      key={command.id}
                      className="flex items-center gap-2 text-[13px] text-content"
                    >
                      <ContextCheckbox
                        label={command.name}
                        className="mt-0"
                        checked={
                          editingGroup?.draft.commandIds.includes(command.id) ??
                          false
                        }
                        onChange={() => {
                          if (!editingGroup) return;
                          setEditing({
                            scope: "group",
                            id: editingGroup.id,
                            draft: {
                              ...editingGroup.draft,
                              commandIds:
                                editingGroup.draft.commandIds.includes(
                                  command.id,
                                )
                                  ? editingGroup.draft.commandIds.filter(
                                      (id) => id !== command.id,
                                    )
                                  : [
                                      ...editingGroup.draft.commandIds,
                                      command.id,
                                    ],
                            },
                          });
                        }}
                      />
                      {command.name}
                    </label>
                  ))}
                  {commands.length === 0 ? (
                    <p className="text-[12px] text-content/45">
                      Save a project command first.
                    </p>
                  ) : null}
                </div>
              </div>
            )}
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
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <span className={labelClass}>This project</span>
              <div className="flex flex-col">
                {commands.map((command, index) =>
                  commandRow(command, index, commands.length, "project"),
                )}
                {commands.length === 0 ? (
                  <p className="py-1.5 text-[12px] text-content/45">
                    No project commands yet.
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() =>
                  setEditing({
                    scope: "project",
                    draft: { name: "", command: "" },
                  })
                }
                className="mt-1 flex h-7 items-center gap-1.5 self-start rounded-md px-2 text-[13px] text-content/70 hover:bg-content/10 hover:text-content"
              >
                <Plus className="size-3.5" strokeWidth={1.75} />
                New project command
              </button>
            </div>
            <div ref={checksRef}>
              <span className={labelClass}>Checks on finish</span>
              <div className="py-1">
                <Select
                  label="Finish check command"
                  value={project.verify?.commandId ?? ""}
                  options={[
                    { value: "", label: "Off" },
                    {
                      value: QUALITY_COMMAND_ID,
                      label: "Quality checks",
                      detail: "Auto-detected in the checkout",
                    },
                    ...commands.map((command) => ({
                      value: command.id,
                      label: command.name,
                      detail: command.steps?.length
                        ? `${command.steps.length} steps`
                        : command.command,
                    })),
                    // A deleted command stays listed so the stale
                    // binding is visible instead of silently clearing.
                    ...(project.verify &&
                    project.verify.commandId !== QUALITY_COMMAND_ID &&
                    !commands.some(
                      (item) => item.id === project.verify?.commandId,
                    )
                      ? [
                          {
                            value: project.verify.commandId,
                            label: "Deleted command",
                          },
                        ]
                      : []),
                  ]}
                  onChange={(value) => {
                    if (!value) {
                      // "Off" clears the config; its live rows go too.
                      resolveVerifyForProject(project.id);
                      setProjectVerify(project.id, null);
                      return;
                    }
                    setProjectVerify(project.id, {
                      commandId: value,
                      mode: project.verify?.mode ?? "notify",
                    });
                  }}
                />
              </div>
              {project.verify ? (
                <div className="flex items-center gap-2 pb-1">
                  <span className="shrink-0 text-[11px] text-content/45">
                    On failure
                  </span>
                  <div
                    role="radiogroup"
                    aria-label="On failure"
                    className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-md border border-content/10 p-0.5 text-[11px]"
                  >
                    {(
                      [
                        ["notify", "Notify me"],
                        ["fix", `Send to agent (≤${MAX_FIX_SENDS})`],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={project.verify?.mode === mode}
                        onClick={() =>
                          setProjectVerify(project.id, {
                            commandId: project.verify?.commandId ?? "",
                            mode,
                          })
                        }
                        className={`rounded-[5px] px-1 py-1 ${
                          project.verify?.mode === mode
                            ? "bg-content/10 text-content"
                            : "text-content/50 hover:text-content"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {isQuality ? (
                <>
                  {project.anchor ? (
                    detectedSteps == null ? (
                      <p className="text-[11px] text-content/40">
                        Detecting tools in the project folder…
                      </p>
                    ) : detectedSteps.length ? (
                      <div className="rounded-lg border border-content/8 bg-content/3 px-2.5 py-1.5">
                        {detectedSteps.map((step) => (
                          <p
                            key={step.exec}
                            className="truncate font-mono text-[11px] leading-5 text-content/55"
                          >
                            {step.exec}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-content/40">
                        No supported tools detected — install jscpd or add
                        .pre-commit-config.yaml.
                      </p>
                    )
                  ) : null}
                  <p className="mt-1 text-[11px] text-content/40">
                    Runs when an agent turn ends — only while MonoCode is open.
                    A failure offers to hand the findings back to the same
                    agent.
                  </p>
                </>
              ) : project.verify ? (
                <p className="text-[11px] text-content/40">
                  {commands.some(
                    (item) => item.id === project.verify?.commandId,
                  )
                    ? "Runs when an agent turn ends in this project — only while MonoCode is open. A failure offers to hand the output tail back to the same agent."
                    : "The selected command was deleted — pick a saved command."}
                </p>
              ) : null}
            </div>
            <div>
              <span className={labelClass}>Reusable — every project</span>
              <div className="flex flex-col">
                {reusable.map((command, index) =>
                  commandRow(command, index, reusable.length, "reusable"),
                )}
                {reusable.length === 0 ? (
                  <p className="py-1.5 text-[12px] text-content/45">
                    No reusable commands yet.
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() =>
                  setEditing({
                    scope: "reusable",
                    draft: { name: "", command: "" },
                  })
                }
                className="mt-1 flex h-7 items-center gap-1.5 self-start rounded-md px-2 text-[13px] text-content/70 hover:bg-content/10 hover:text-content"
              >
                <Plus className="size-3.5" strokeWidth={1.75} />
                New reusable command
              </button>
            </div>
            <div>
              <span className={labelClass}>Groups</span>
              <div className="flex flex-col">
                {groups.map((group, index) => {
                  const members = group.commandIds
                    .map((id) => commands.find((item) => item.id === id))
                    .filter((item): item is ProjectCommand => !!item);
                  return (
                    <div
                      key={group.id}
                      className="flex items-center gap-1 border-b border-content/8 py-1.5 last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-content">
                          {group.name}
                        </div>
                        <div className="truncate text-[11px] text-content/40">
                          {members.map((item) => item.name).join(" · ")}
                        </div>
                      </div>
                      {rowButtons(
                        index,
                        groups.length,
                        (delta) =>
                          moveProjectCommandGroup(project.id, group.id, delta),
                        () =>
                          setEditing({
                            scope: "group",
                            id: group.id,
                            draft: {
                              name: group.name,
                              commandIds: group.commandIds,
                            },
                          }),
                        () => {
                          if (window.confirm(`Delete group “${group.name}”?`))
                            deleteProjectCommandGroup(project.id, group.id);
                        },
                        group.name,
                      )}
                    </div>
                  );
                })}
                {groups.length === 0 ? (
                  <p className="py-1.5 text-[12px] text-content/45">
                    No groups yet.
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() =>
                  setEditing({
                    scope: "group",
                    draft: { name: "", commandIds: [] },
                  })
                }
                className="mt-1 flex h-7 items-center gap-1.5 self-start rounded-md px-2 text-[13px] text-content/70 hover:bg-content/10 hover:text-content"
              >
                <Plus className="size-3.5" strokeWidth={1.75} />
                New group
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
