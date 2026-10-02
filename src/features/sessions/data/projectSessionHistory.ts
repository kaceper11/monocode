import { listSessionsByProject, type SessionSummary } from "./sessionStore";

/** Independent summary loads preserve successful repositories and ignore obsolete views. */
export async function loadProjectSessionHistory(
  paths: readonly string[],
  onLoaded: (cwd: string, rows: SessionSummary[]) => void,
  isCurrent: () => boolean,
): Promise<string[]> {
  const results = await Promise.allSettled(
    paths.map(async (cwd) => {
      const rows = await listSessionsByProject(cwd);
      if (isCurrent()) onLoaded(cwd, rows);
    }),
  );
  return isCurrent()
    ? results.flatMap((result, index) =>
        result.status === "rejected" ? [paths[index]] : [],
      )
    : [];
}
