// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  NEW_TASK_EVENT,
  SidebarTasksSection,
  tasksForProject,
} from "./SidebarTasksSection";
import { OPEN_TASK_EVENT } from "./taskSession";
import { addTask } from "./boardStore";
import {
  saveSavedProject,
  selectSavedProject,
} from "../projects/model/savedProjects";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const lane = (projectPath = "/repo") => ({
  id: `lane-${projectPath}`,
  projectPath,
  worktreePath: projectPath,
  branch: "feature",
  base: "main",
});
const render = async (onSelectSession = vi.fn()) => {
  await act(async () =>
    root.render(
      createElement(SidebarTasksSection, {
        cwd: "/repo",
        onSelectSession,
      }),
    ),
  );
  return onSelectSession;
};
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) =>
      entry.getAttribute("aria-label") === label ||
      entry.textContent?.trim() === label,
  )!;
const click = async (label: string) =>
  act(async () => {
    button(label).click();
  });

it("filters tasks to the project repositories, not the whole board", () => {
  const own = { id: "t1", title: "Mine", workstreams: [lane("/repo")] };
  const other = { id: "t2", title: "Elsewhere", workstreams: [lane("/other")] };
  const tasks = [own, other, { ...own, id: "t3", archived: true }];
  expect(
    tasksForProject(tasks as never, "/repo").map((task) => task.id),
  ).toEqual(["t1"]);
  // Saved-project membership replaces path matching with projectId.
  expect(
    tasksForProject(
      [
        { ...own, projectId: "p" },
        { ...other, projectId: "p" },
        { ...other, id: "t4", projectId: "q" },
      ] as never,
      "/repo",
      { id: "p", members: ["/repo", "/other"] },
    ).map((task) => task.id),
  ).toEqual(["t1", "t2"]);
});

it("opens the primary session on row click and the task panel on details", async () => {
  const onSelect = vi.fn();
  const opened = vi.fn();
  window.addEventListener(OPEN_TASK_EVENT, opened);
  const bound = addTask({
    title: "With session",
    links: [],
    primarySessionId: "s1",
    workstreams: [lane()],
  })!;
  const plain = addTask({
    title: "No session",
    links: [],
    workstreams: [lane()],
  })!;
  await render(onSelect);
  await click("With session");
  expect(onSelect).toHaveBeenCalledWith("s1");
  expect(opened).not.toHaveBeenCalled();
  await click("No session");
  expect(opened).toHaveBeenCalledTimes(1);
  expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe(plain);
  await click("With session details");
  expect(opened).toHaveBeenCalledTimes(2);
  expect((opened.mock.calls[1][0] as CustomEvent).detail).toBe(bound);
  window.removeEventListener(OPEN_TASK_EVENT, opened);
});

it("dispatches the new-task event and toggles between project and all tasks", async () => {
  const created = vi.fn();
  window.addEventListener(NEW_TASK_EVENT, created);
  addTask({ title: "Local", links: [], workstreams: [lane()] });
  addTask({ title: "Foreign", links: [], workstreams: [lane("/other")] });
  await render();
  expect(host.textContent).toContain("Local");
  expect(host.textContent).not.toContain("Foreign");
  await click("New task");
  expect(created).toHaveBeenCalledTimes(1);
  await click("Show all tasks");
  expect(host.textContent).toContain("Foreign");
  await click("Show repository tasks");
  expect(host.textContent).not.toContain("Foreign");
  window.removeEventListener(NEW_TASK_EVENT, created);
});

it("scopes the list to the saved project and names it", async () => {
  saveSavedProject({
    id: "p",
    name: "Suite",
    members: ["/repo", "/other"],
    presets: [],
  });
  selectSavedProject("p");
  // Tagged tasks join by projectId — even a lane outside the members.
  addTask({
    projectId: "p",
    title: "Project task",
    links: [],
    workstreams: [lane("/elsewhere")],
  });
  // Untagged tasks join only when a lane sits in a member repository.
  addTask({ title: "Member lane", links: [], workstreams: [lane("/other")] });
  addTask({ title: "Unrelated", links: [], workstreams: [lane("/foreign")] });
  await render();
  expect(host.textContent).toContain("Project task");
  expect(host.textContent).toContain("Member lane");
  expect(host.textContent).toContain("Suite");
  expect(host.textContent).not.toContain("Unrelated");
});
