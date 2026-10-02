import {
  loadSessionFolders,
  saveSessionFolders,
  type SessionFolder,
} from "./sessionFolders";
import { pathKey } from "../../../shared/lib/paths";
import type { SessionSummary } from "../data/sessionStore";

export function folderLocation(
  id: string,
  fallback: string,
): { cwd: string; id: string } {
  try {
    const value: unknown = JSON.parse(id);
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((item) => typeof item === "string")
    )
      return { cwd: value[0], id: value[1] };
  } catch {
    /* Existing folder identifiers are opaque strings. */
  }
  return { cwd: fallback, id };
}
export function loadProjectSessionFolders(
  paths: readonly string[],
): SessionFolder[] {
  return paths.flatMap((cwd) =>
    loadSessionFolders(cwd).map((folder) =>
      paths.length > 1
        ? { ...folder, id: JSON.stringify([cwd, folder.id]) }
        : folder,
    ),
  );
}
export function saveProjectSessionFolders(
  paths: readonly string[],
  folders: readonly SessionFolder[],
  sessions: readonly Pick<SessionSummary, "id" | "cwd">[],
  fallback: string,
): void {
  const byId = new Map(sessions.map((session) => [session.id, session.cwd]));
  const byPath = new Map(
    paths.map((path) => [pathKey(path), [] as SessionFolder[]]),
  );
  for (const folder of folders) {
    const location = folderLocation(
      folder.id,
      byId.get(folder.sessionIds[0]) ?? fallback,
    );
    const target = byPath.get(pathKey(location.cwd));
    if (!target)
      throw new Error(
        "This folder’s repository is no longer in the selected project.",
      );
    if (
      folder.sessionIds.some(
        (id) =>
          byId.has(id) && pathKey(byId.get(id)!) !== pathKey(location.cwd),
      )
    )
      throw new Error(
        "Folders belong to one repository. Choose sessions from the same repository.",
      );
    target.push({ ...folder, id: location.id });
  }
  // Validate the complete change before writing any repository’s folders.
  for (const cwd of paths) {
    const next = byPath.get(pathKey(cwd))!;
    if (JSON.stringify(loadSessionFolders(cwd)) !== JSON.stringify(next))
      saveSessionFolders(cwd, next);
  }
}
