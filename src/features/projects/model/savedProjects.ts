import { useMemo, useSyncExternalStore } from "react";
import { pathKey } from "../../../shared/lib/paths";
import { normalizeProjectPath } from "./recents";

const KEY = "monocode.savedProjects";
const ACTIVE = "monocode.selectedSavedProject";
const EVENT = "monocode:saved-projects-changed";
export type RepositoryPreset = { id: string; name: string; members: string[] };
export type SavedProject = {
  id: string;
  name: string;
  members: string[];
  presets: RepositoryPreset[];
};
const paths = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Map(
          value
            .filter((p): p is string => typeof p === "string" && !!p.trim())
            .map((p) => [pathKey(p), normalizeProjectPath(p)]),
        ).values(),
      ].slice(0, 16)
    : [];
export function readSavedProjects(
  raw = localStorage.getItem(KEY),
): SavedProject[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    return parsed
      .flatMap((value) => {
        if (
          !value ||
          typeof value.id !== "string" ||
          !value.id.trim() ||
          value.id.length > 120 ||
          typeof value.name !== "string" ||
          !value.name.trim() ||
          ids.has(value.id)
        )
          return [];
        const members = paths(value.members);
        if (!members.length) return [];
        ids.add(value.id);
        const presetIds = new Set<string>();
        const presets = (Array.isArray(value.presets) ? value.presets : [])
          .flatMap((preset: RepositoryPreset) => {
            if (
              !preset ||
              typeof preset.id !== "string" ||
              typeof preset.name !== "string" ||
              !preset.name.trim() ||
              presetIds.has(preset.id)
            )
              return [];
            presetIds.add(preset.id);
            return [
              {
                id: preset.id,
                name: preset.name.trim().slice(0, 120),
                members: paths(preset.members).filter((p) =>
                  members.some((m) => pathKey(m) === pathKey(p)),
                ),
              },
            ];
          })
          .slice(0, 32);
        return [
          {
            id: value.id,
            name: value.name.trim().slice(0, 120),
            members,
            presets,
          },
        ];
      })
      .slice(0, 100);
  } catch {
    return [];
  }
}
export function saveSavedProject(project: SavedProject) {
  const current = readSavedProjects();
  if (!current.some((p) => p.id === project.id) && current.length >= 100)
    throw new Error("Saved projects are limited to 100.");
  const next = current.some((p) => p.id === project.id)
    ? current.map((p) => (p.id === project.id ? project : p))
    : [...current, project];
  const normalized = readSavedProjects(JSON.stringify(next));
  if (!normalized.some((p) => p.id === project.id))
    throw new Error("Choose a project name and at least one repository.");
  localStorage.setItem(KEY, JSON.stringify(normalized));
  window.dispatchEvent(new Event(EVENT));
}
export function deleteSavedProject(id: string) {
  localStorage.setItem(
    KEY,
    JSON.stringify(readSavedProjects().filter((p) => p.id !== id)),
  );
  if (localStorage.getItem(ACTIVE) === id) localStorage.removeItem(ACTIVE);
  window.dispatchEvent(new Event(EVENT));
}
export function selectSavedProject(id?: string) {
  if (id) localStorage.setItem(ACTIVE, id);
  else localStorage.removeItem(ACTIVE);
  window.dispatchEvent(new Event(EVENT));
}
const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(EVENT, notify);
    window.removeEventListener("storage", notify);
  };
};
const snapshot = () =>
  JSON.stringify([localStorage.getItem(KEY), localStorage.getItem(ACTIVE)]);
// With no cwd context (bare New Task) the last-used project is the intended
// task-creation default; a real cwd must be a member so the rail never claims
// a project the user isn't inside.
export function savedProjectForCwd(
  projects: readonly SavedProject[],
  activeId: string | null,
  cwd?: string,
): SavedProject | undefined {
  return projects.find(
    (p) =>
      p.id === activeId &&
      (!cwd || p.members.some((m) => pathKey(m) === pathKey(cwd))),
  );
}
export function useSavedProjects(cwd?: string) {
  const raw = useSyncExternalStore(subscribe, snapshot);
  return useMemo(() => {
    const [data, id] = JSON.parse(raw);
    const projects = readSavedProjects(data);
    return { projects, selected: savedProjectForCwd(projects, id, cwd) };
  }, [raw, cwd]);
}
