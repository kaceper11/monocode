import { invoke } from "@tauri-apps/api/core";
import type {
  InboxItem,
  InboxProvider,
  InboxProviderErrors,
} from "./githubTasks";
import type { InboxRelationship } from "./inboxFilters";

export type PlanningScope = {
  provider: InboxProvider;
  id: string;
  name: string;
  connection: string;
  cwd: string;
};
export type PlanningPeriod = {
  id: string;
  label: string;
  scope: PlanningScope;
  fieldId: string;
  start: string;
  end: string;
};
export type PlanningPage<T> = { entries: T[]; next: string | null };
export const periodKey = (p: PlanningPeriod) =>
  JSON.stringify([
    p.scope.provider,
    p.scope.connection,
    p.scope.id,
    p.fieldId,
    p.id,
  ]);
export function cleanPlanningPeriods(value: unknown): PlanningPeriod[] {
  if (!Array.isArray(value)) return [];
  const valid = value.filter(
    (p): p is PlanningPeriod =>
      p &&
      typeof p === "object" &&
      [
        p.id,
        p.label,
        p.fieldId,
        p.start,
        p.end,
        p.scope?.id,
        p.scope?.name,
        p.scope?.connection,
        p.scope?.cwd,
      ].every((s) => typeof s === "string" && s.length <= 4096) &&
      p.id &&
      p.scope.id &&
      p.scope.connection &&
      ["jira", "azuredevops", "github", "linear", "gitlab"].includes(
        p.scope.provider,
      ),
  );
  return [...new Map(valid.map((p) => [periodKey(p), p])).values()].slice(
    0,
    20,
  );
}
export const planningScopes = (
  provider: InboxProvider,
  cwd: string,
  cursor = "",
) =>
  invoke<PlanningPage<PlanningScope>>("planning_scopes", {
    provider,
    cwd,
    cursor,
  });
export async function planningPeriods(
  scope: PlanningScope,
  cursor = "",
): Promise<PlanningPage<PlanningPeriod>> {
  const page = await invoke<
    PlanningPage<PlanningPeriod & { duration?: number }>
  >("planning_periods", { scope, cursor });
  return {
    ...page,
    entries: page.entries.map((period) => ({
      ...period,
      end:
        period.end ||
        (period.duration && Number.isFinite(Date.parse(period.start))
          ? new Date(
              Date.parse(period.start) + period.duration * 86400000,
            ).toISOString()
          : ""),
    })),
  };
}

/** Fetch server-filtered pages, preserving successful pages when another scope fails. */
export async function planningItems(
  periods: PlanningPeriod[],
  relationships: InboxRelationship[],
) {
  const items: InboxItem[] = [];
  const errors: InboxProviderErrors = {};
  for (const period of periods) {
    try {
      let cursor = "";
      const seen = new Set<string>();
      for (let page = 0; ; page++) {
        if (page === 50 || seen.has(cursor))
          throw new Error(
            "Planning results are incomplete; narrow the selected periods and refresh.",
          );
        seen.add(cursor);
        const result = await invoke<PlanningPage<InboxItem>>("planning_items", {
          period,
          relationships,
          cursor,
        });
        const remaining = 5000 - items.length;
        items.push(
          ...result.entries
            .slice(0, remaining)
            .map((item) => ({ ...item, planningPeriods: [period] })),
        );
        if (
          result.entries.length > remaining ||
          (items.length >= 5000 && result.next)
        )
          throw new Error(
            "Planning results exceed 5,000 items; narrow the selected periods.",
          );
        if (!result.next) break;
        cursor = result.next;
      }
    } catch (error) {
      errors[period.scope.provider] =
        `${period.scope.name} / ${period.label}: ${String(error)}`;
    }
  }
  return { items, errors };
}
