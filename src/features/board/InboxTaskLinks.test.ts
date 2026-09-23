// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InboxTaskLinks, CREATE_TASK_EVENT } from "./InboxTaskLinks";
import { OPEN_TASK_EVENT } from "./taskSession";
import { addTask, loadBoard, updateTask } from "./boardStore";
import { boardLinkFromInboxItem } from "./boardData";
import type { InboxItem } from "../inbox/model/githubTasks";

let root: Root;
let host: HTMLDivElement;
const item: InboxItem = {
  provider: "github",
  kind: "issue",
  repo: "org/repo",
  number: 42,
  title: "Checkout",
  url: "https://github.com/org/repo/issues/42",
  account: "work",
  projectPath: "/repo",
  state: "open",
  updatedAt: "",
  labels: [],
  assignees: [],
  draft: false,
};
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

it("shows every exact linked task, updates live, and opens the selected task", async () => {
  const link = boardLinkFromInboxItem(item)!;
  const first = addTask({ title: "Frontend", links: [link], workstreams: [] })!;
  const second = addTask({ title: "Backend", links: [link], workstreams: [] })!;
  addTask({
    title: "Other account",
    links: [{ ...link, account: "personal" }],
    workstreams: [],
  });
  await act(async () => root.render(createElement(InboxTaskLinks, { item })));
  expect(host.textContent).toContain("Tasks · 2");
  expect(host.textContent).toContain("Frontend");
  expect(host.textContent).toContain("Backend");
  expect(host.textContent).not.toContain("Other account");
  const open = vi.fn();
  window.addEventListener(OPEN_TASK_EVENT, open);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Open task: Backend"]')!
      .click(),
  );
  expect((open.mock.calls[0][0] as CustomEvent).detail).toBe(second);
  window.removeEventListener(OPEN_TASK_EVENT, open);
  await act(async () => updateTask(first, { links: [] }));
  expect(host.textContent).not.toContain("Frontend");
  await act(async () => updateTask(second, { archived: true }));
  expect(host.textContent).toContain("BackendArchived");
});

it("opens a prefilled draft without creating tasks or starting agents", async () => {
  const create = vi.fn();
  window.addEventListener(CREATE_TASK_EVENT, create);
  await act(async () => root.render(createElement(InboxTaskLinks, { item })));
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect((create.mock.calls[0][0] as CustomEvent).detail).toEqual(item);
  expect(loadBoard().tasks).toEqual([]);
  window.removeEventListener(CREATE_TASK_EVENT, create);
});
