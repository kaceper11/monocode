import { useEffect, useRef, useState } from "react";
import { pickFolder } from "../../../platform/tauri/fs";
import { IS_WIN } from "../../../platform/tauri/platform";
import {
  wslDistributions,
  wslDistributionsPeek,
} from "../../sessions/model/wsl";
import { WslProjectDialog } from "../../sessions/ui/WslProjectDialog";
import { Modal } from "../../../shared/ui/Modal";
import { Folder, FolderOpen, Plus, X } from "../../../shared/ui/icons";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { LAYER } from "../../../shared/lib/layers";
import { pathKey, prettyCwd, projectName } from "../../../shared/lib/paths";
import { saveSavedProject, type SavedProject } from "../model/savedProjects";
import type { RecentProject } from "../model/recents";
const button =
  "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 focus-visible:outline-accent disabled:opacity-40";
export function SavedProjectDialog({
  project,
  recents,
  onClose,
}: {
  project?: SavedProject;
  recents: RecentProject[];
  onClose: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [members, setMembers] = useState(project?.members ?? []);
  const [presets, setPresets] = useState(project?.presets ?? []);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const mounted = useRef(true);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The modal focuses its close button on mount — land name focus a frame
  // later so typing starts on the field.
  useEffect(() => {
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const save = () => {
    try {
      saveSavedProject({
        id: project?.id ?? crypto.randomUUID(),
        name,
        members,
        presets,
      });
      onClose();
    } catch (reason) {
      setError(String(reason));
    }
  };
  const add = (path: string) =>
    setMembers((current) =>
      current.some((m) => pathKey(m) === pathKey(path))
        ? current
        : [...current, path].slice(0, 16),
    );
  const browse = async () => {
    setPicking(true);
    setError("");
    try {
      if (IS_WIN) {
        const distributions = await wslDistributions().catch(
          () => wslDistributionsPeek() ?? [],
        );
        if (!mounted.current) return;
        if (distributions.length) {
          setPickerOpen(true);
          return;
        }
      }
      const paths = await pickFolder();
      if (mounted.current) for (const path of paths ?? []) add(path);
    } catch (reason) {
      if (mounted.current) setError(String(reason));
    } finally {
      if (mounted.current) setPicking(false);
    }
  };
  return (
    <>
      <Modal
        title={project ? "Edit project" : "New project"}
        description="Group repositories for your tasks and save sets you use together."
        fitViewport
        onClose={onClose}
        footer={
          <div className="flex justify-end gap-2 p-3">
            <button className={button} onClick={onClose}>
              Cancel
            </button>
            <button
              className={`${button} bg-accent/10 text-accent`}
              disabled={
                !name.trim() ||
                picking ||
                pickerOpen ||
                !members.length ||
                presets.some((preset) => !preset.name.trim())
              }
              onClick={save}
            >
              {project ? "Save changes" : "Create project"}
            </button>
          </div>
        }
      >
        <div className="min-w-0 space-y-5 p-4 text-[12px]">
          <label className="flex flex-col gap-1.5 text-content/70">
            Name
            <input
              ref={nameRef}
              aria-label="Project name"
              placeholder="e.g. Customer platform"
              className="h-9 rounded-md border border-content/10 bg-background-base px-2.5 text-[13px] text-content outline-none placeholder:text-content/60 focus:border-content/25"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-content/80">Repositories</h3>
              <span className="text-[11px] text-content/60">
                {members.length}/16
              </span>
            </div>
            {!!members.length && (
              <div className="divide-y divide-content/8 overflow-hidden rounded-lg border border-content/10">
                {members.map((path) => (
                  <div
                    key={pathKey(path)}
                    className="flex items-center gap-2.5 px-3 py-2.5"
                  >
                    <Folder className="size-4 shrink-0 text-content/60" />
                    <div className="min-w-0 flex-1" title={path}>
                      <p className="truncate font-medium text-content/85">
                        {projectName(path)}
                      </p>
                      <p className="truncate text-[10px] text-content/60">
                        {prettyCwd(path)}
                      </p>
                    </div>
                    <button
                      aria-label={`Remove ${projectName(path)}`}
                      title="Remove repository"
                      className="grid size-7 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content focus-visible:outline-accent"
                      onClick={() => {
                        setMembers((current) =>
                          current.filter((m) => pathKey(m) !== pathKey(path)),
                        );
                        setPresets((current) =>
                          current.map((preset) => ({
                            ...preset,
                            members: preset.members.filter(
                              (m) => pathKey(m) !== pathKey(path),
                            ),
                          })),
                        );
                      }}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!members.length && (
              <p className="rounded-lg border border-dashed border-content/15 px-3 py-4 text-[12px] text-content/60">
                Choose repositories below to build your project.
              </p>
            )}
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <SearchableSelect
                  label="Add project repository"
                  value=""
                  options={recents
                    .filter(
                      (p) =>
                        !members.some((m) => pathKey(m) === pathKey(p.path)),
                    )
                    .map((p) => ({
                      value: p.path,
                      label: projectName(p.path),
                    }))}
                  onChange={add}
                  placeholder="Add repository…"
                  layer={LAYER.dialogPopover}
                  disabled={members.length >= 16}
                />
              </div>
              <button
                className={`${button} shrink-0 border border-content/10`}
                disabled={members.length >= 16 || picking}
                onClick={() => void browse()}
              >
                <FolderOpen className="size-3.5" />
                {picking ? "Loading…" : "Browse…"}
              </button>
            </div>
          </section>
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-medium text-content/80">
                Repository presets
              </h3>
              <button
                className={button}
                disabled={!members.length || presets.length >= 32}
                onClick={() =>
                  setPresets((current) => [
                    ...current,
                    {
                      id: crypto.randomUUID(),
                      name: "New preset",
                      members: [...members],
                    },
                  ])
                }
              >
                <Plus className="size-3.5" />
                New preset
              </button>
            </div>
            {!presets.length && (
              <p className="text-[11px] leading-relaxed text-content/60">
                Save a subset of repositories to quickly choose it when creating
                a task.
              </p>
            )}
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="space-y-3 rounded-lg border border-content/10 p-3"
              >
                <div className="flex gap-2">
                  <input
                    aria-label="Preset name"
                    value={preset.name}
                    placeholder="Preset name"
                    maxLength={120}
                    className="h-8 min-w-0 flex-1 rounded-md border border-content/10 bg-background-base px-2 text-content outline-none focus:border-content/25"
                    onChange={(e) =>
                      setPresets((current) =>
                        current.map((p) =>
                          p.id === preset.id
                            ? { ...p, name: e.target.value }
                            : p,
                        ),
                      )
                    }
                  />
                  <button
                    aria-label={`Delete preset ${preset.name}`}
                    title="Delete preset"
                    className="grid size-8 shrink-0 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content focus-visible:outline-accent"
                    onClick={() =>
                      setPresets((current) =>
                        current.filter((p) => p.id !== preset.id),
                      )
                    }
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {members.map((path) => (
                    <div key={path}>
                      <Checkbox
                        visibleLabel
                        label={projectName(path)}
                        checked={preset.members.some(
                          (m) => pathKey(m) === pathKey(path),
                        )}
                        onChange={() =>
                          setPresets((current) =>
                            current.map((p) =>
                              p.id !== preset.id
                                ? p
                                : {
                                    ...p,
                                    members: p.members.some(
                                      (m) => pathKey(m) === pathKey(path),
                                    )
                                      ? p.members.filter(
                                          (m) => pathKey(m) !== pathKey(path),
                                        )
                                      : [...p.members, path],
                                  },
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
          {error && (
            <p role="alert" className="text-red-400">
              {error}
            </p>
          )}
        </div>
      </Modal>
      {pickerOpen && (
        <WslProjectDialog
          cwd={members[0] ?? recents[0]?.path ?? "~"}
          title="Add repositories"
          confirmLabel="Add"
          onOpen={(paths) => {
            for (const path of paths) add(path);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}
