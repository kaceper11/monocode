// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const dialog = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: dialog.ask }));
vi.mock("../../../shared/ui/Modal.tsx", () => ({
  Modal: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("./Select", () => ({
  Select: ({
    value,
    label,
    options,
    onChange,
    disabled,
  }: {
    value: string;
    label: string;
    disabled: boolean;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
  }) =>
    createElement(
      "select",
      {
        value,
        disabled,
        "aria-label": label,
        onChange: (event: { target: HTMLSelectElement }) =>
          onChange(event.target.value),
      },
      options.map((option) =>
        createElement(
          "option",
          { key: option.value, value: option.value },
          option.label,
        ),
      ),
    ),
}));
import { SavedCommandsManager } from "./SavedCommandsControl";
import { readSavedCommands } from "../model/savedCommands";
let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
const onLaunch = vi.fn();
const onClose = vi.fn();
const destination = {
  projectCwd: "/project",
  worktreeCwd: "//wsl.localhost/Ubuntu/home/dev/repo",
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  onLaunch.mockReset();
  onClose.mockReset();
  dialog.ask.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      createElement(SavedCommandsManager, {
        destination,
        onLaunch,
        onClose,
        onShowTerminal: vi.fn(),
      }),
    ),
  );
}
function button(name: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) =>
      button.textContent?.trim() === name ||
      button.getAttribute("aria-label") === name,
  )!;
}
function field(label: string, value: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;
  const prototype =
    element.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function select(label: string, value: string) {
  const element = host.querySelector<HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function seed() {
  localStorage.setItem(
    "monocode.savedCommands.v1",
    JSON.stringify({
      version: 1,
      commands: [
        { id: "one", name: "One", command: "echo one" },
        { id: "two", name: "Two", command: "echo two" },
      ],
      groups: [],
    }),
  );
}
it("creates a scoped command and launches it only on an explicit Run click", async () => {
  await render();
  act(() => button("New command").click());
  field("Command name", "Test");
  field("Command text", "npm test");
  await act(async () => button("Save").click());
  expect(readSavedCommands().commands[0]).toMatchObject({
    name: "Test",
    command: "npm test",
    projectCwd: "/project",
  });
  expect(onLaunch).not.toHaveBeenCalled();
  act(() => button("Run Test").click());
  expect(onLaunch).toHaveBeenCalledWith(
    expect.objectContaining({
      ids: [readSavedCommands().commands[0].id],
      destination,
    }),
  );
});
it("keeps step text and native-host selection when saving", async () => {
  await render();
  act(() => button("New command").click());
  field("Command name", "Steps");
  field("Command text", "npm test");
  act(() =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  act(() => button("Add step").click());
  field("Step 2 command", "wsl --shutdown");
  select("Step 2 host", "native");
  await act(async () => button("Save").click());
  expect(readSavedCommands().commands[0].steps).toEqual([
    { command: "npm test" },
    { command: "wsl --shutdown", host: "native" },
  ]);
});
it("blocks legacy commands until explicit rebinding and leaves original bytes intact", async () => {
  const legacy = JSON.stringify([
    {
      id: "p",
      anchor: "/legacy",
      commands: [{ id: "c", name: "Old", command: "echo old" }],
      commandGroups: [],
    },
  ]);
  localStorage.setItem("monocode.projects.v1", legacy);
  await render();
  expect(button("Run Old").disabled).toBe(true);
  act(() => button("Edit Old").click());
  select("Command scope", "current");
  await act(async () => button("Save").click());
  expect(button("Run Old").disabled).toBe(false);
  expect(localStorage.getItem("monocode.projects.v1")).toBe(legacy);
});
it("preserves group selection order and validates every member before dispatch", async () => {
  seed();
  await render();
  act(() => button("Groups").click());
  act(() => button("New group").click());
  field("Command name", "Both");
  const checks = host.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  act(() => checks[1].click());
  act(() => checks[0].click());
  await act(async () => button("Save").click());
  expect(readSavedCommands().groups[0].commandIds).toEqual(["two", "one"]);
  act(() => button("Run Both").click());
  expect(onLaunch).toHaveBeenCalledWith(
    expect.objectContaining({ ids: ["two", "one"] }),
  );
});
it("rejects a last-instant storage change before Run", async () => {
  seed();
  await render();
  localStorage.setItem(
    "monocode.savedCommands.v1",
    JSON.stringify({ version: 1, commands: [], groups: [] }),
  );
  act(() => button("Run One").click());
  expect(onLaunch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Saved commands changed");
});
it("cancels a delayed delete confirmation when the editor unmounts", async () => {
  let resolve!: (confirmed: boolean) => void;
  dialog.ask.mockImplementation(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  seed();
  await render();
  act(() => button("Edit One").click());
  act(() => button("Delete saved command").click());
  act(() => root.unmount());
  mounted = false;
  await act(async () => resolve(true));
  expect(readSavedCommands().commands).toHaveLength(2);
});
it("bounds the group member list and exposes later pages", async () => {
  localStorage.setItem(
    "monocode.savedCommands.v1",
    JSON.stringify({
      version: 1,
      commands: Array.from({ length: 120 }, (_, id) => ({
        id: String(id),
        name: `Command ${id}`,
        command: "echo test",
      })),
      groups: [],
    }),
  );
  await render();
  act(() => button("Groups").click());
  act(() => button("New group").click());
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(50);
  act(() => button("Next members").click());
  expect(host.textContent).toContain("Command 50");
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(50);
});
