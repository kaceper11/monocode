import { pathKey } from "./paths";
import type { RecentProject, ProjectRailSections } from "./recents";

export type WorkingCopy = {
  path: string;
  head: string;
  branch: string | null;
  main: boolean;
  missing: boolean;
  locked: string | null;
  prunable: string | null;
  users?: string[];
  lastUsed?: number | null;
};
export type RepositoryFamily = {
  commonDir: string;
  checkout: string;
  worktrees: WorkingCopy[];
  /** Root commit — stable across clones of the same lineage. */
  identity?: string | null;
};

let verifiedFamilies: ReadonlyMap<string, RepositoryFamily> = new Map();
const listeners = new Set<() => void>();
export const getVerifiedFamilies = () => verifiedFamilies;
export function subscribeRepositoryFamilies(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function publishRepositoryFamilies(
  next: ReadonlyMap<string, RepositoryFamily>,
) {
  verifiedFamilies = next;
  for (const listener of listeners) listener();
}

export function workingCopyName(
  child: WorkingCopy,
  family: RepositoryFamily,
): string {
  if (child.branch) return child.branch.replace("refs/heads/", "");
  if (child.main) return "main";
  const name = child.path.split("/").pop() ?? child.path;
  const main = family.worktrees
    .find((entry) => entry.main)
    ?.path.split("/")
    .pop();
  return main && name.startsWith(`${main}-`)
    ? name.slice(main.length + 1)
    : name;
}

/** Only fresh Git evidence collapses rows. Original recents and metadata remain
 * intact, so missing checkouts and conflicting customizations are recoverable. */
export function groupRepositoryFamilies(
  sections: ProjectRailSections,
  verified: ReadonlyMap<string, RepositoryFamily>,
): ProjectRailSections {
  const seen = new Set<string>();
  const group = (items: RecentProject[]) =>
    items.filter((item) => {
      const family = verified.get(pathKey(item.path));
      if (!family) return true;
      const key = pathKey(family.commonDir);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // Preserve a pinned representative first, then the user's existing order.
  return { pinned: group(sections.pinned), projects: group(sections.projects) };
}

const HIDDEN_KEY = "monocode.hiddenWorkingCopies";
const preferenceListeners = new Set<() => void>();
export function hiddenWorkingCopiesSnapshot(): string {
  try {
    return localStorage.getItem(HIDDEN_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}
export function hiddenWorkingCopies(
  raw = hiddenWorkingCopiesSnapshot(),
): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value
          .filter((path): path is string => typeof path === "string")
          .slice(0, 2000)
      : [];
  } catch {
    return [];
  }
}
export function subscribeWorkingCopyPreferences(listener: () => void) {
  preferenceListeners.add(listener);
  return () => {
    preferenceListeners.delete(listener);
  };
}
export function setWorkingCopyHidden(path: string, hidden: boolean) {
  const next = hiddenWorkingCopies().filter(
    (entry) => pathKey(entry) !== pathKey(path),
  );
  if (hidden) next.unshift(path);
  // Presentation only: Git inventory, session paths and original recents stay intact.
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(next.slice(0, 2000)));
  for (const listener of preferenceListeners) listener();
}
export function lastWorkingCopyUse(
  child: WorkingCopy,
  recents: RecentProject[],
): number | null {
  const values = [
    child.lastUsed,
    ...recents
      .filter((item) => pathKey(item.path) === pathKey(child.path))
      .map((item) => item.openedAt),
  ];
  const valid = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return valid.length ? Math.max(...valid) : null;
}
export function workingCopyAge(
  lastUsed: number | null,
  now = Date.now(),
): string {
  if (lastUsed === null) return "Activity unknown";
  const days = Math.floor(Math.max(0, now - lastUsed) / 86_400_000);
  return days === 0
    ? "Used today"
    : days === 1
      ? "Used yesterday"
      : `Used ${days}d ago`;
}
export function oldestWorkingCopies<T extends WorkingCopy>(
  entries: T[],
  recents: RecentProject[],
): T[] {
  return [...entries].sort(
    (a, b) =>
      (lastWorkingCopyUse(a, recents) ?? Infinity) -
        (lastWorkingCopyUse(b, recents) ?? Infinity) ||
      a.path.localeCompare(b.path),
  );
}
