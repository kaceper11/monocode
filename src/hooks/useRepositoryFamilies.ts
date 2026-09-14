import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { collectRailProjects, type RecentProject } from "../lib/recents";
import { loadProjects } from "../lib/projects";
import { pathKey } from "../lib/paths";
import { subscribeGitChanged } from "../lib/fs";
import {
  publishRepositoryFamilies,
  subscribeRepositoryFamilies,
  getVerifiedFamilies,
  type RepositoryFamily,
} from "../lib/repositoryFamilies";

/** Probe ordering: every probe gets a sequence; a response may only publish
 * for a commonDir when nothing newer has already landed. Two overlapping
 * probes of the same family resolve in arbitrary order — this keeps the
 * freshest result, not the last-arriving one. */
let probeSeq = 0;
const familySeq = new Map<string, number>();

function publishFamilyEntries(
  verified: Map<string, RepositoryFamily>,
  path: string,
  family: RepositoryFamily,
  seq: number,
): boolean {
  // Nothing cached means there is no fresher data to be stale against —
  // drop remembered seqs too so a reset cache can't suppress this publish.
  if (!verified.size) familySeq.clear();
  const key = pathKey(family.commonDir);
  if ((familySeq.get(key) ?? 0) > seq) return false;
  familySeq.set(key, seq);
  for (const [entry, value] of verified)
    if (pathKey(value.commonDir) === key) verified.delete(entry);
  verified.set(pathKey(path), family);
  for (const child of family.worktrees)
    if (!child.missing && !child.prunable)
      verified.set(pathKey(child.path), family);
  return true;
}

/** Reuse unchanged families and publish each newly verified repository promptly.
 * Retain only families reachable from the bounded recent-project list. */
export async function discoverRepositoryFamilies(
  paths: string[],
  probe: (path: string) => Promise<RepositoryFamily>,
  cancelled: () => boolean,
  refreshPath?: string,
) {
  const previous = getVerifiedFamilies();
  const retained = new Set(
    paths.flatMap((path) => {
      const family = previous.get(pathKey(path));
      return family ? [pathKey(family.commonDir)] : [];
    }),
  );
  // Stored project members stay cached even when no member path is a recent —
  // expansion and the repositories sheet probe them on demand.
  for (const project of loadProjects())
    for (const repo of project.repositories)
      retained.add(pathKey(repo.commonDir));
  publishRepositoryFamilies(
    new Map(
      [...previous].filter(([, family]) =>
        retained.has(pathKey(family.commonDir)),
      ),
    ),
  );
  for (const path of paths) {
    if (cancelled()) return;
    if (
      getVerifiedFamilies().has(pathKey(path)) &&
      pathKey(path) !== pathKey(refreshPath ?? "")
    )
      continue;
    const seq = ++probeSeq;
    try {
      const family = await probe(path);
      if (cancelled()) return;
      // Recent subfolders are aliases, not worktree roots. Revalidate them
      // before publishing so a refresh cannot briefly split the rail group.
      const aliases = paths.filter(
        (candidate) =>
          pathKey(candidate) !== pathKey(path) &&
          getVerifiedFamilies().get(pathKey(candidate))?.commonDir ===
            family.commonDir &&
          !family.worktrees.some(
            (child) => pathKey(child.path) === pathKey(candidate),
          ),
      );
      const refreshedAliases = await Promise.all(
        aliases.map(async (alias) => {
          try {
            return [pathKey(alias), await probe(alias)] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled()) return;
      // Merge with the latest state: Git refresh may have updated another family.
      const verified = new Map(getVerifiedFamilies());
      const old = verified.get(pathKey(path));
      if (old && pathKey(old.commonDir) !== pathKey(family.commonDir)) {
        for (const [key, value] of verified)
          if (pathKey(value.commonDir) === pathKey(old.commonDir))
            verified.delete(key);
      }
      // Drop the write entirely when a newer probe for this family already
      // published — the last response to arrive is not the freshest.
      if (!publishFamilyEntries(verified, path, family, seq)) continue;
      for (const alias of refreshedAliases) {
        if (alias) verified.set(...alias);
      }
      publishRepositoryFamilies(verified);
    } catch {
      // A failed active refresh must not leave stale ownership evidence —
      // nor wipe a family a newer probe already republished.
      if (cancelled()) return;
      const verified = new Map(getVerifiedFamilies());
      const old = verified.get(pathKey(path));
      if (old && (familySeq.get(pathKey(old.commonDir)) ?? 0) <= seq) {
        for (const [key, value] of verified)
          if (pathKey(value.commonDir) === pathKey(old.commonDir))
            verified.delete(key);
        publishRepositoryFamilies(verified);
      }
    }
  }
}

/** Probes one path and merges the verified family into the shared cache
 * without pruning — for on-demand member loading (project popover, expanded
 * project rows). Returns null when the path is not a Git repository. */
export async function probeRepositoryFamily(
  path: string,
): Promise<RepositoryFamily | null> {
  const seq = ++probeSeq;
  try {
    const family = await invoke<RepositoryFamily>("git_repository_family", {
      cwd: path,
    });
    const verified = new Map(getVerifiedFamilies());
    if (!publishFamilyEntries(verified, path, family, seq))
      return getVerifiedFamilies().get(pathKey(path)) ?? family;
    publishRepositoryFamilies(verified);
    return family;
  } catch {
    return null;
  }
}

/** Probing one directory child per request; scan in small batches so a big
 * parent folder does not burst the backend. */
export const REPOSITORY_SCAN_BATCH = 8;

export type PickedRepositoryScan = {
  /** Picked paths that are themselves repositories, in pick order. */
  own: RepositoryFamily[];
  /** Repositories found one level inside picked non-repository folders. */
  children: RepositoryFamily[];
};

/** One picker pass over several folders: each picked repository is returned
 * directly; every other pick is scanned one level down for child
 * repositories. Probe/list are injected so the picker host supplies the
 * right backend. Duplicate picks probe once. */
export async function scanPickedRepositories(
  picked: string[],
  probe: (path: string) => Promise<RepositoryFamily | null>,
  listChildren: (path: string) => Promise<string[]>,
): Promise<PickedRepositoryScan> {
  const targets = [
    ...new Map(picked.map((path) => [pathKey(path), path])).values(),
  ];
  const own: RepositoryFamily[] = [];
  const parents: string[] = [];
  for (let i = 0; i < targets.length; i += REPOSITORY_SCAN_BATCH) {
    const probed = await Promise.all(
      targets.slice(i, i + REPOSITORY_SCAN_BATCH).map(probe),
    );
    probed.forEach((family, index) => {
      if (family) own.push(family);
      else parents.push(targets[i + index]);
    });
  }
  const children: RepositoryFamily[] = [];
  for (const parent of parents) {
    const dirs = await listChildren(parent);
    for (let i = 0; i < dirs.length; i += REPOSITORY_SCAN_BATCH) {
      const probed = await Promise.all(
        dirs.slice(i, i + REPOSITORY_SCAN_BATCH).map(probe),
      );
      children.push(
        ...probed.filter((family): family is RepositoryFamily => !!family),
      );
    }
  }
  return { own, children };
}

export function useRepositoryFamilies(recents: RecentProject[], cwd: string) {
  const [families, setFamilies] = useState<Map<string, RepositoryFamily>>(
    () => new Map(getVerifiedFamilies()),
  );
  // Discovery publishes once per probed path; coalesce the burst into one
  // rail regroup instead of rows merging a step at a time.
  useEffect(() => {
    let timer = 0;
    const unsubscribe = subscribeRepositoryFamilies(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => setFamilies(new Map(getVerifiedFamilies())),
        40,
      );
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);
  const familyPaths = JSON.stringify(
    [...collectRailProjects(recents, cwd).values()]
      .map((item) => item.path)
      .sort(),
  );
  useEffect(() => {
    let cancelled = false;
    const paths: string[] = JSON.parse(familyPaths);
    // The active checkout is useful first; cached siblings require no probe.
    paths.sort(
      (a, b) =>
        Number(pathKey(b) === pathKey(cwd)) -
        Number(pathKey(a) === pathKey(cwd)),
    );
    void discoverRepositoryFamilies(
      paths,
      (path) =>
        invoke<RepositoryFamily>("git_repository_family", { cwd: path }),
      () => cancelled,
      cwd,
    );
    return () => {
      cancelled = true;
    };
  }, [familyPaths, cwd]);
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const pending = new Set<string>();
    const unsubscribe = subscribeGitChanged((changed) => {
      const paths: string[] = JSON.parse(familyPaths);
      const changedKey = changed ? pathKey(changed) : undefined;
      const changedFamily = changedKey
        ? getVerifiedFamilies().get(changedKey)
        : undefined;
      for (const path of paths) {
        const key = pathKey(path);
        if (
          !changedKey ||
          key === changedKey ||
          changedKey.startsWith(`${key}/`) ||
          (changedFamily &&
            getVerifiedFamilies().get(key)?.commonDir ===
              changedFamily.commonDir)
        )
          pending.add(path);
      }
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (!cancelled && pending.size > 0) {
            const path = pending.values().next().value!;
            pending.delete(path);
            await discoverRepositoryFamilies(
              JSON.parse(familyPaths),
              (path) =>
                invoke<RepositoryFamily>("git_repository_family", {
                  cwd: path,
                }),
              () => cancelled,
              path,
            );
          }
        } finally {
          running = false;
        }
      })();
    });
    return () => {
      cancelled = true;
      pending.clear();
      unsubscribe();
    };
  }, [cwd, familyPaths]);
  return families;
}
