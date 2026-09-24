// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as taskOps from "./taskOps";
import * as azureDevOps from "../inbox/model/azureDevOps";
import { deliveryKey } from "./delivery";
import { BoardView } from "./BoardView";
import { addTask, loadBoard, updateTask } from "./boardStore";
import { listInboxItems, peekInboxList, type InboxItem } from "../inbox/model/githubTasks";

let submitTask: ComponentProps<typeof import("./NewTaskDialog").NewTaskDialog>["onSubmit"];
vi.mock("./NewTaskDialog", async (original) => {
  const actual = await original<typeof import("./NewTaskDialog")>();
  return { ...actual, NewTaskDialog: (props: ComponentProps<typeof actual.NewTaskDialog>) => {
    submitTask = props.onSubmit;
    return createElement(actual.NewTaskDialog, props);
  } };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: (path: string) => path,
}));
vi.mock("../../app/shell/WindowControls", () => ({
  WindowControls: () => null,
}));
vi.mock("./useInboxConnections", () => ({
  useInboxConnections: () => ({
    jira: true,
    linear: true,
    github: false,
    gitlab: false,
    azuredevops: false,
  }),
}));
vi.mock("../inbox/model/githubTasks", async (original) => ({
  ...(await original<typeof import("../inbox/model/githubTasks")>()),
  listInboxItems: vi.fn(async () => ({ items, errors: {} })),
  peekInboxList: vi.fn(() => ({ items, errors: {} })),
}));

const items: InboxItem[] = ["jira", "linear"].map((provider, index) => ({
  provider: provider as "jira" | "linear",
  kind: provider as "jira" | "linear",
  number: index + 1,
  id: String(index + 1),
  title: `${provider} review ticket`,
  identifier: `TEST-${index + 1}`,
  url: `https://${provider}.test/${index + 1}`,
  state: "In Review",
  stateType: "started",
  projectPath: "/repo",
  repo: "team/repo",
  updatedAt: "2026-09-23T00:00:00Z",
  labels: [],
  assignees: [],
  draft: false,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function renderBoard(overrides: Partial<ComponentProps<typeof BoardView>> = {}) {
  await act(async () =>
    root.render(
      createElement(BoardView, {
        recents: [],
        cwd: "/repo",
        sessions: [],
        linkedSessions: [],
        onClose: vi.fn(),
        onToggleSidebar: vi.fn(),
        onOpenSession: vi.fn(),
        onStartItem: vi.fn(),
        onSendToSession: vi.fn(),
        onSpawnSession: vi.fn(),
        onPrepareWorktree: vi.fn(async (spec) => `${spec.projectPath}-task`),
        onBindSession: vi.fn(),
        onRemoveWorktree: vi.fn(),
        ...overrides,
      }),
    ),
  );
}

it("creates a task-linked agent from the Board and opens it after the live session arrives", async () => {
  const onOpenSession = vi.fn();
  const onSpawnSession = vi.fn(async () => ({ sessionId: "new-agent", worktreePath: "/repo-task" }));
  await renderBoard({ onOpenSession, onSpawnSession });
  await act(async () => button("New task").click());
  const input = document.querySelector<HTMLInputElement>('input[placeholder="e.g. Auth token refresh across services"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Checkout task");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(onSpawnSession).toHaveBeenCalledWith(expect.objectContaining({ projectPath: "/repo", title: "Checkout task" }));
  expect(loadBoard().tasks[0].primarySessionId).toBe("new-agent");
  expect(loadBoard().tasks[0].workstreams[0].sessionIds).toBeUndefined();
  expect(onOpenSession).not.toHaveBeenCalled();
  await renderBoard({ onOpenSession, onSpawnSession, sessions: [{ id: "new-agent", title: "Checkout task", cwd: "/repo", worktreeCwd: "/repo-task", harness: "codex", model: "", modelSettings: {}, runtimeMode: "supervised", blocks: [] }] });
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("new-agent");
});
function button(label: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) =>
      el.getAttribute("aria-label") === label ||
      el.textContent?.trim() === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}
async function click(label: string, scope: ParentNode = document) {
  await act(async () => button(label, scope).click());
}

it("filters provider cards and restores saved statuses after reopening Board", async () => {
  await renderBoard();
  expect(container.textContent).toContain("jira review ticket");
  expect(container.textContent).toContain("linear review ticket");
  await click("Board filters");
  const sections = [
    ...document.querySelectorAll<HTMLDetailsElement>("details"),
  ];
  expect(
    sections.map(
      (section) => section.querySelector("summary span")?.textContent,
    ),
  ).toEqual(["Relationship", "Provider status", "Project", "Groups", "Display"]);
  expect(sections.every((section) => !section.open)).toBe(true);
  await act(async () => sections[1]!.querySelector("summary")!.click());
  expect(sections[1]!.open).toBe(true);
  const jiraGroup = document.querySelector('[aria-label="Jira statuses"]')!;
  await click("In Review", jiraGroup);
  expect(container.textContent).toContain("jira review ticket");
  expect(container.textContent).not.toContain("linear review ticket");
  const selected = button("In Review", jiraGroup);
  selected.focus();
  expect(document.activeElement).toBe(selected);
  expect(selected.getAttribute("aria-checked")).toBe("true");

  await click("Save view…");
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Save current filters as"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "Jira review");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Save");
  expect(loadBoard().filters[0]?.spec.statuses).toEqual([
    { provider: "jira", state: "In Review" },
  ]);
  await act(async () => root.render(null));
  await renderBoard();
  await click("Board filters");
  await act(async () =>
    document
      .querySelector("details summary")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  // The active selection is restored automatically; no preset click is needed.
  expect(container.textContent).not.toContain("linear review ticket");
  const statusSection = [
    ...document.querySelectorAll<HTMLDetailsElement>("details"),
  ].find(
    (section) =>
      section.querySelector("summary span")?.textContent === "Provider status",
  )!;
  expect(statusSection.querySelector("summary")?.textContent).toContain(
    "Jira: In Review",
  );
  await act(async () => statusSection.querySelector("summary")!.click());
  await click(
    "In Review",
    document.querySelector('[aria-label="Linear statuses"]')!,
  );
  expect(container.textContent).toContain("linear review ticket");
  await click("Update");
  expect(loadBoard().filters[0]?.spec.statuses).toHaveLength(2);
  await click("Clear");
  expect(container.textContent).toContain("jira review ticket");
  expect(container.textContent).toContain("linear review ticket");
});

it("keeps Board filters open when choosing an Updated dropdown option", async () => {
  await renderBoard();
  await click("Board filters");
  const display = [...document.querySelectorAll("details")].find(
    (section) =>
      section.querySelector("summary span")?.textContent === "Display",
  )!;
  await act(async () => display.querySelector("summary")!.click());
  await click("Updated: All time");
  const option = button(
    "Last 7 days",
    document.querySelector('[aria-label="Updated options"]')!,
  );
  await act(async () => {
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    option.click();
  });
  expect(button("Updated: Last 7 days")).toBeDefined();
  expect(display.querySelector("summary")?.textContent).toContain(
    "Last 7 days",
  );
  expect(document.querySelector('[aria-label="Updated options"]')).toBeNull();
});

it("prepares multiple repositories but creates exactly one primary conversation", async () => {
  const onPrepareWorktree = vi.fn(async (spec) => `${spec.projectPath}-task`);
  const onSpawnSession = vi.fn(async (spec) => ({ sessionId: "lead", worktreePath: spec.worktreePath }));
  await renderBoard({ onPrepareWorktree, onSpawnSession });
  await act(async () => button("New task").click());
  await act(async () => submitTask({ title: "Shared task", links: [], workstreams: [
    { projectPath: "/web", branch: "feature", base: "main" },
    { projectPath: "/api", branch: "feature", base: "main" },
  ] }));
  expect(onPrepareWorktree).toHaveBeenCalledTimes(2);
  expect(onSpawnSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectPath: "/web", worktreePath: "/web-task" }));
  expect(loadBoard().tasks[0]).toMatchObject({ primarySessionId: "lead", workstreams: [
    { projectPath: "/web", worktreePath: "/web-task" },
    { projectPath: "/api", worktreePath: "/api-task" },
  ] });
  expect(loadBoard().tasks[0].workstreams.every(ws => !ws.sessionIds)).toBe(true);
});

it("retains prepared worktrees when primary session creation fails so it can be retried", async () => {
  const onSpawnSession = vi.fn(async () => { throw new Error("Agent unavailable"); });
  await renderBoard({ onSpawnSession });
  await act(async () => button("New task").click());
  await act(async () => submitTask({ title: "Retry task", links: [], workstreams: [
    { projectPath: "/repo", branch: "feature", base: "main" },
  ] }));
  expect(loadBoard().tasks[0]).toMatchObject({ title: "Retry task", workstreams: [{ worktreePath: "/repo-task" }] });
  expect(loadBoard().tasks[0].primarySessionId).toBeUndefined();
  expect(container.textContent).toContain("Agent unavailable");
  expect(button("Create task session")).toBeDefined();
});

it("can adopt an existing repository conversation as primary without starting another agent", async () => {
  const id = addTask({ title: "Existing task", links: [], workstreams: [{ id: "repo", projectPath: "/repo", worktreePath: "/repo-task", branch: "feature", base: "main", sessionIds: ["existing"] }] })!;
  const onSpawnSession = vi.fn();
  const onOpenSession = vi.fn();
  await renderBoard({ taskRequest: { id }, onSpawnSession, onOpenSession, sessions: [{ id: "existing", title: "Existing conversation", cwd: "/repo", worktreeCwd: "/repo-task", harness: "codex", model: "", modelSettings: {}, runtimeMode: "supervised", blocks: [] }] });
  const select = container.querySelector<HTMLSelectElement>('[aria-label="Use existing task session"]')!;
  await act(async () => { select.value = "existing"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(loadBoard().tasks[0].primarySessionId).toBe("existing");
  expect(loadBoard().tasks[0].workstreams[0].sessionIds).toEqual(["existing"]);
  expect(onSpawnSession).not.toHaveBeenCalled();
  await act(async () => button("Open task session").click());
  expect(onOpenSession).toHaveBeenCalledWith("existing");
});

it("opens an Inbox task draft with its ticket linked and no side effects until submission", async () => {
  const onPrepareWorktree = vi.fn();
  const onSpawnSession = vi.fn();
  await renderBoard({ newTaskRequest: { item: items[0] }, onPrepareWorktree, onSpawnSession });
  expect(document.querySelector<HTMLInputElement>('input[placeholder="e.g. Auth token refresh across services"]')?.value).toBe(items[0].title);
  expect(loadBoard().tasks).toEqual([]);
  expect(onPrepareWorktree).not.toHaveBeenCalled(); expect(onSpawnSession).not.toHaveBeenCalled();
  const form = document.querySelector<HTMLInputElement>('input[placeholder="e.g. Auth token refresh across services"]')!.closest("form")!;
  await act(async () => form.querySelector<HTMLButtonElement>('[aria-label="Remove repo"]')!.click());
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(loadBoard().tasks[0].links[0]).toMatchObject({ provider: items[0].provider, url: items[0].url });
  expect(onPrepareWorktree).not.toHaveBeenCalled(); expect(onSpawnSession).not.toHaveBeenCalled();
});

it("rejects an Inbox task's already-owned branch before preparing worktrees or creating a session", async () => {
  addTask({ title: "Existing owner", links: [], workstreams: [{ id: "owned", projectPath: "/repo", branch: "feature", base: "main", worktreePath: "/repo-task" }] });
  const onPrepareWorktree = vi.fn(); const onSpawnSession = vi.fn();
  await renderBoard({ newTaskRequest: { item: items[0] }, onPrepareWorktree, onSpawnSession });
  await act(async () => submitTask({ title: "Another task", links: [], workstreams: [{ projectPath: "/repo", branch: "feature", base: "main" }] }));
  expect(onPrepareWorktree).not.toHaveBeenCalled(); expect(onSpawnSession).not.toHaveBeenCalled();
  expect(loadBoard().tasks).toHaveLength(1);
  expect(document.body.textContent).toContain("already tracks feature");
});

it("retains task status across Board remounts while refreshing and rejects changed checkout snapshots", async () => {
  const ws = { id: "cached-ws", projectPath: "/repo", worktreePath: "/repo-task", branch: "feature", base: "main" };
  const id = addTask({ title: "Cached task", links: [], workstreams: [ws] })!;
  const probe = vi.spyOn(taskOps, "probeWorkstream").mockResolvedValue({ pr: null, checks: [], requestKey: deliveryKey(ws), fetchedAt: Date.now() });
  await renderBoard({ taskRequest: { id } });
  expect(container.textContent).toContain("No pull request");
  await act(async () => root.unmount());
  root = createRoot(container);
  probe.mockImplementation(() => new Promise(() => {}));
  await renderBoard({ taskRequest: { id } });
  expect(probe).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("No pull request");
  expect(container.textContent).not.toContain("Looking for PR…");
  await act(async () => updateTask(id, { workstreams: [{ ...ws, branch: "other" }] }));
  expect(container.textContent).toContain("Looking for PR…");
});

it("refreshes Board immediately when Jira connection or project filters change", async () => {
  const { listInboxItems } = await import("../inbox/model/githubTasks");
  await renderBoard();
  vi.mocked(listInboxItems).mockClear();
  await act(async () => window.dispatchEvent(new CustomEvent("monocode:jira-change", { detail: "connection" })));
  expect(listInboxItems).toHaveBeenCalledWith(expect.anything(), expect.anything(), { force: true });
  vi.mocked(listInboxItems).mockClear();
  await act(async () => window.dispatchEvent(new Event("monocode:jira-change")));
  expect(listInboxItems).toHaveBeenCalledWith(expect.anything(), expect.anything(), { force: true });
});


it("shows one initial loading state and retains cards during background refresh", async () => {
  vi.mocked(peekInboxList).mockReturnValue(undefined);
  let resolve!: (value: { items: InboxItem[]; errors: {} }) => void;
  vi.mocked(listInboxItems).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await renderBoard();
  expect(container.textContent).toContain("Loading board…");
  expect(container.textContent).not.toContain("Nothing here");
  expect(container.textContent).not.toContain("jira review ticket");
  await act(async () => resolve({ items, errors: {} }));
  expect(container.textContent).not.toContain("Loading board…");
  expect(container.textContent).toContain("jira review ticket");
  vi.mocked(listInboxItems).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => button("Refresh").click());
  expect(container.textContent).toContain("jira review ticket");
  expect(container.textContent).not.toContain("Loading board…");
  await act(async () => resolve({ items, errors: {} }));
});


it("waits for initial PR and CI probes before revealing cards", async () => {
  const ws = { id: "delayed-ws", projectPath: "/delayed", worktreePath: "/delayed-wt", branch: "feature", base: "main" };
  addTask({ title: "Waiting for checks", links: [], workstreams: [ws] });
  let finish!: () => void;
  vi.spyOn(taskOps, "probeWorkstream").mockImplementation(() => new Promise(resolve => {
    finish = () => resolve({ pr: null, checks: [], requestKey: deliveryKey(ws), fetchedAt: Date.now() });
  }));
  await renderBoard();
  expect(container.textContent).toContain("Loading board…");
  expect(container.textContent).not.toContain("Waiting for checks");
  await act(async () => finish());
  expect(container.textContent).not.toContain("Loading board…");
  expect(container.textContent).toContain("Waiting for checks");
});

it("keeps Needs action as a persistent top-bar toggle", async () => {
  await renderBoard();
  expect(button("Needs action").getAttribute("aria-pressed")).toBe("false");
  await click("Needs action");
  expect(button("Needs action").getAttribute("aria-pressed")).toBe("true");
  expect(button("Board filters").getAttribute("aria-pressed")).toBe("false");
  await act(async () => root.render(null));
  await renderBoard();
  expect(button("Needs action").getAttribute("aria-pressed")).toBe("true");
  await click("Board filters");
  expect(document.querySelector('[role="menuitemcheckbox"][aria-label="Needs action only"]')).toBeNull();
});


it("waits for standalone Azure PR checks discovered after tickets finish", async () => {
  const pr: InboxItem = { ...items[0], provider: "azuredevops", kind: "pr", number: 84,
    title: "Delayed Azure pull request", url: "https://dev.azure.com/org/project/_git/repo/pullrequest/84",
    repo: "org/project/repo", sourceRefName: "refs/heads/feature", state: "open" };
  vi.mocked(peekInboxList).mockReturnValue(undefined);
  vi.mocked(listInboxItems).mockResolvedValueOnce({ items: [pr], errors: {} });
  let finish!: () => void;
  vi.spyOn(azureDevOps, "azureDevOpsBranchChecks").mockImplementation(() => new Promise(resolve => { finish = () => resolve([]); }));
  await renderBoard();
  expect(azureDevOps.azureDevOpsBranchChecks).toHaveBeenCalled();
  expect(container.textContent).toContain("Loading board…");
  expect(container.textContent).not.toContain(pr.title);
  await act(async () => finish());
  expect(container.textContent).not.toContain("Loading board…");
  expect(container.textContent).toContain(pr.title);
});
