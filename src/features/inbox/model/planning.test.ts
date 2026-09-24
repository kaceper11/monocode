// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listInboxItems, type InboxItem } from "./githubTasks";
import {
  cleanPlanningPeriods,
  periodKey,
  planningItems,
  type PlanningPeriod,
} from "./planning";
import {
  DEFAULT_BOARD_FILTER,
  loadBoardView,
  saveBoardView,
} from "../../board/boardStore";
import {
  taskBranchChoice,
  taskBranchOptions,
} from "../../source-control/hooks/useProjectBranches";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const period: PlanningPeriod = {
  id: "12",
  label: "Sprint 12",
  fieldId: "",
  start: "",
  end: "",
  scope: {
    provider: "azuredevops",
    id: "project",
    name: "Project",
    connection: "org|ada",
    cwd: "",
  },
};
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  localStorage.clear();
});
it("round-trips every active filter and keeps unavailable scopes", () => {
  const spec = {
    ...DEFAULT_BOARD_FILTER,
    search: "payments",
    hiddenProviders: ["gitlab" as const],
    relationships: ["assigned" as const, "created" as const],
    periods: [period],
    groups: ["missing"],
    project: "/offline-repo",
  };
  saveBoardView(spec);
  expect(loadBoardView()).toEqual(spec);
  expect(cleanPlanningPeriods([period, period, { id: "broken" }])).toEqual([
    period,
  ]);
  expect(
    periodKey({ ...period, scope: { ...period.scope, connection: "org|bob" } }),
  ).not.toBe(periodKey(period));
});
it("migrates old view preferences and survives corrupt storage", () => {
  localStorage.setItem(
    "monocode.board.view.v1",
    JSON.stringify({ mineOnly: false, time: "7d" }),
  );
  expect(loadBoardView()).toMatchObject({
    relationships: [],
    time: "7d",
    periods: [],
  });
  localStorage.setItem("monocode.board.view.v1", "broken");
  expect(loadBoardView()).toEqual(DEFAULT_BOARD_FILTER);
});
it("loads beyond the first period page and retains successful results on partial failure", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({
      entries: [{ title: "First", provider: "azuredevops" }],
      next: "100",
    })
    .mockResolvedValueOnce({
      entries: [{ title: "Second", provider: "azuredevops" }],
      next: null,
    })
    .mockRejectedValueOnce(new Error("Access denied"));
  const result = await planningItems(
    [period, { ...period, id: "13" }],
    ["assigned", "created"],
  );
  expect(result.items.map((i) => i.title)).toEqual(["First", "Second"]);
  expect(result.items[0].planningPeriods).toEqual([period]);
  expect(invoke).toHaveBeenNthCalledWith(2, "planning_items", {
    period,
    relationships: ["assigned", "created"],
    cursor: "100",
  });
  expect(result.errors.azuredevops).toContain("Access denied");
});
it("fails visibly on a repeated pagination cursor", async () => {
  vi.mocked(invoke).mockResolvedValue({ entries: [], next: "again" });
  const result = await planningItems([period], []);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(result.errors.azuredevops).toContain("incomplete");
});
it("keeps full sprint membership for linked tasks without exposing unrelated standalone items", async () => {
  const item = (number: number): InboxItem => ({
    number, title: `Issue ${number}`, kind: "issue", provider: "azuredevops",
    repo: "org/project", projectPath: "", url: `https://dev.azure.com/org/project/_workitems/edit/${number}`,
    state: "Active", updatedAt: "", labels: [], assignees: [], draft: false,
  });
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const roles = (args as { relationships: string[] }).relationships;
    return { entries: roles.length ? [item(1)] : [item(1), item(2)], next: null };
  });
  const result = await listInboxItems([], {
    assignedToMe: true, state: "all", search: "", periods: [period], relationships: ["assigned", "created"],
  }, { force: true });
  expect(result.items).toHaveLength(2);
  expect(result.items.find(i => i.number === 1)?.planningContextOnly).toBeUndefined();
  expect(result.items.find(i => i.number === 2)?.planningContextOnly).toBe(true);
  expect(result.items.every(i => i.planningPeriods?.[0].id === period.id)).toBe(true);
});
it("keeps remote choices distinct and claimed branches visible but disabled", () => {
  const options = taskBranchOptions(
    {
      current: "main",
      detached: false,
      branches: [
        { name: "main", current: true, remote: null },
        { name: "topic", current: false, remote: "origin" },
        { name: "topic", current: false, remote: "upstream" },
      ],
    },
    new Set(["main"]),
  );
  expect(options[0].disabled).toBe(true);
  expect(options.map((o) => o.value)).toEqual([
    "main",
    "refs/remotes/origin/topic",
    "refs/remotes/upstream/topic",
  ]);
  expect(taskBranchChoice("refs/remotes/upstream/feature/topic")).toEqual({
    branch: "feature/topic",
    base: "refs/remotes/upstream/feature/topic",
  });
});
