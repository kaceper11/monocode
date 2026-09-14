// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AutomationsPage } from "./AutomationsPage";
import {
  OPEN_COMMANDS_SHEET,
  type CommandsSheetRequest,
} from "../lib/projectCommands";
import {
  ensureProjectForPath,
  loadProjects,
  saveProjectCommand,
  setProjectVerify,
} from "../lib/projects";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

const CWD = "/repo";
const family = {
  commonDir: `${CWD}/.git`,
  checkout: CWD,
  worktrees: [
    { path: CWD, head: "abc", branch: "main", main: true, missing: false },
  ],
};

let projectId = "";
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === label,
  );

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const project = ensureProjectForPath(CWD, family);
  projectId = project.id;
  const saved = saveProjectCommand(projectId, {
    name: "Tests",
    command: "npm test",
  });
  if (saved.error) throw new Error(saved.error);
  const commandId = loadProjects().find((p) => p.id === projectId)!
    .commands[0].id;
  const verify = setProjectVerify(projectId, { commandId, mode: "notify" });
  if (verify.error) throw new Error(verify.error);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(AutomationsPage)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("lists the configured check with its command and mode", () => {
  const page = host.textContent ?? "";
  expect(page).toContain("Checks on finish");
  expect(page).toContain("Tests");
  expect(page).toContain("Notify");
});

it("opens the project's commands sheet on the checks section", async () => {
  const seen: CommandsSheetRequest[] = [];
  const listener = (event: Event) =>
    seen.push((event as CustomEvent<CommandsSheetRequest>).detail);
  window.addEventListener(OPEN_COMMANDS_SHEET, listener);
  try {
    await act(async () => button("Configure")?.click());
  } finally {
    window.removeEventListener(OPEN_COMMANDS_SHEET, listener);
  }
  expect(seen).toEqual([{ projectId, focus: "checks" }]);
});

it("pauses and resumes a project's check from its row", async () => {
  await act(async () => button("Pause")?.click());
  expect(
    loadProjects().find((p) => p.id === projectId)?.verify?.enabled,
  ).toBe(false);
  expect(host.textContent).toContain("Paused");
  await act(async () => button("Resume")?.click());
  expect(
    loadProjects().find((p) => p.id === projectId)?.verify?.enabled,
  ).not.toBe(false);
});
