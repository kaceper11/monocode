// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BoardView } from "./BoardView";
import { loadBoard } from "./boardStore";
import type { InboxItem } from "../inbox/model/githubTasks";

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
  peekInboxList: () => ({ items, errors: {} }),
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
  vi.unstubAllGlobals();
});
async function renderBoard() {
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
        onBindSession: vi.fn(),
        onRemoveWorktree: vi.fn(),
      }),
    ),
  );
}
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
  ).toEqual(["Provider status", "Project", "Groups", "Display"]);
  expect(sections.every((section) => !section.open)).toBe(true);
  await act(async () => sections[0]!.querySelector("summary")!.click());
  expect(sections[0]!.open).toBe(true);
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
  await click("Jira review");
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
