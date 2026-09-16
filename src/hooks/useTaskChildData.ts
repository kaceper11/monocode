import { useMemo } from "react";
import {
  childDelivery,
  EMPTY_DELIVERY,
  type DeliveryStores,
  type TaskChildDelivery,
} from "../lib/taskDelivery";
import {
  taskChildRepoName,
  type TaskChild,
  type TaskWorkspace,
} from "../lib/taskWorkspaces";
import { useCachedBranchPr } from "./useBranchPr";
import { useProjectDiffStats } from "./useProjectDiffStats";
import type { GitDiffStats } from "../lib/fs";

/** Per-child panel data — observed branch, delivery rollup and display name.
 * Delivery and PR data come from subscribed caches, but `useProjectDiffStats`
 * fetches a working copy's diff stats on first subscribe — keep `enabled`
 * tied to actual visibility so a closed popover never runs Git. */
export function useTaskChildData(
  task: TaskWorkspace,
  entry: TaskChild | null,
  enabled: boolean,
  stores: DeliveryStores,
): {
  stats: GitDiffStats | null;
  branch: string | undefined;
  delivery: TaskChildDelivery;
  repoName: string;
} {
  const stats =
    useProjectDiffStats(
      entry?.workingCopy ?? "",
      enabled && !!entry?.workingCopy,
    ) ?? null;
  const branch = stats?.branch ?? entry?.branch;
  const githubPr = useCachedBranchPr(entry?.workingCopy ?? "", branch);
  const delivery = useMemo(
    () =>
      entry
        ? childDelivery(task, entry, [branch, entry.branch], githubPr, stores)
        : EMPTY_DELIVERY,
    [task, entry, branch, githubPr, stores],
  );
  const repoName = entry ? taskChildRepoName(task, entry) : "Repository";
  return { stats, branch, delivery, repoName };
}
