import { useState } from "react";
import { SavedProjectDialog } from "./SavedProjectDialog";
import {
  deleteSavedProject,
  selectSavedProject,
  useSavedProjects,
  type SavedProject,
} from "../model/savedProjects";
import type { RecentProject } from "../model/recents";
import { Popover } from "../../../shared/ui/Popover";
import {
  Folder,
  MoreHorizontal,
  Pencil,
  Trash2,
  Plus,
} from "../../../shared/ui/icons";
export function SavedProjectsSection({
  cwd,
  recents,
  onSelect,
}: {
  cwd: string;
  recents: RecentProject[];
  onSelect: (path: string) => void;
}) {
  const { projects, selected } = useSavedProjects(cwd);
  const [edit, setEdit] = useState<SavedProject | "new" | null>(null);
  const [menu, setMenu] = useState<{
    project: SavedProject;
    anchor: HTMLElement;
  } | null>(null);
  return (
    <section className="mb-2 shrink-0 px-2" aria-label="Saved projects">
      <div className="flex items-center justify-between px-2 py-2 text-[11px] font-medium text-content/65">
        <span className="flex items-center gap-2">
          Projects
          {!!projects.length && (
            <span className="text-[10px] font-normal text-content/50">
              {projects.length}
            </span>
          )}
        </span>
        <button
          aria-label="New project"
          title="New project"
          onClick={() => setEdit("new")}
          className="grid size-6 place-items-center rounded-md text-content/60 hover:bg-content/8 hover:text-content focus-visible:outline-accent"
        >
          <Plus className="size-3" />
        </button>
      </div>
      <div className="space-y-0.5">
        {projects.map((project) => (
          <div key={project.id}>
            <div
              className={`group flex items-center gap-1 rounded-lg ${selected?.id === project.id ? "bg-accent/8" : "hover:bg-content/5"}`}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                aria-current={selected?.id === project.id ? "true" : undefined}
                title={`${project.name} · ${project.members.join(" · ")}`}
                onClick={() => {
                  if (selected?.id === project.id) return;
                  selectSavedProject(project.id);
                  onSelect(project.members[0]);
                }}
              >
                <Folder
                  className={`size-4 shrink-0 ${selected?.id === project.id ? "text-accent" : "text-content/60"}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-content/85">
                    {project.name}
                  </span>
                  <span className="block truncate text-[10px] text-content/60">
                    {project.members.length}{" "}
                    {project.members.length === 1
                      ? "repository"
                      : "repositories"}
                    {project.presets.length
                      ? ` · ${project.presets.length} ${project.presets.length === 1 ? "preset" : "presets"}`
                      : ""}
                  </span>
                </span>
              </button>
              <button
                aria-label={`Actions for ${project.name}`}
                title="Project actions"
                aria-expanded={menu?.project.id === project.id}
                aria-haspopup="menu"
                className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-content/60 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-accent"
                onClick={(event) =>
                  setMenu(
                    menu?.project.id === project.id
                      ? null
                      : { project, anchor: event.currentTarget },
                  )
                }
              >
                <MoreHorizontal className="size-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      {!projects.length && (
        <button
          className="mx-2 mb-1 text-left text-[11px] text-content/60 hover:text-content focus-visible:outline-accent"
          onClick={() => setEdit("new")}
        >
          Create your first project
        </button>
      )}
      {menu && (
        <Popover
          anchor={menu.anchor}
          align="end"
          width={192}
          constrainHeight={false}
          onDismiss={() => setMenu(null)}
          role="menu"
          aria-label={`${menu.project.name} actions`}
          className="p-1"
        >
          <button
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-content/85 hover:bg-content/8 focus-visible:outline-accent"
            onClick={() => {
              setEdit(menu.project);
              setMenu(null);
            }}
          >
            <Pencil className="size-3.5" />
            Edit project
          </button>
          <button
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-red-600 dark:text-red-400 hover:bg-red-500/8 focus-visible:outline-accent"
            onClick={() => {
              deleteSavedProject(menu.project.id);
              setMenu(null);
            }}
          >
            <Trash2 className="size-3.5" />
            Remove project
          </button>
        </Popover>
      )}
      {edit && (
        <SavedProjectDialog
          project={edit === "new" ? undefined : edit}
          recents={recents}
          onClose={() => setEdit(null)}
        />
      )}
    </section>
  );
}
