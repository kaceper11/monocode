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
import { SavedPromptsPicker } from "./SavedPromptsPicker";
import { readSavedPrompts } from "../model/savedPrompts";
let root: Root;
let host: HTMLDivElement;
let mounted: boolean;
const onAdd = vi.fn();
const onClose = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  onAdd.mockReset();
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
  vi.restoreAllMocks();
});
async function render() {
  await act(async () =>
    root.render(
      createElement(SavedPromptsPicker, { cwd: "/repo", onAdd, onClose }),
    ),
  );
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.trim() === text || b.getAttribute("aria-label") === text,
  )!;
}
it("adds explicitly reviewed prompt text without writing storage", async () => {
  await render();
  act(() => button("ImplementAll working copies").click());
  const text = host.querySelector<HTMLTextAreaElement>("textarea")!.value;
  act(() => button("Add to draft").click());
  expect(onAdd).toHaveBeenCalledWith(text);
  expect(onClose).toHaveBeenCalledOnce();
  expect(localStorage.length).toBe(0);
});
it("checks storage at insertion time even before another window's event arrives", async () => {
  await render();
  act(() => button("ReviewAll working copies").click());
  localStorage.setItem(
    "monocode.savedPrompts.v1",
    JSON.stringify({ version: 1, prompts: [] }),
  );
  act(() => button("Add to draft").click());
  expect(onAdd).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Saved prompts changed");
});
it("requires an explicit scope choice for legacy project prompts", async () => {
  localStorage.setItem(
    "monocode.agentActions.v1",
    JSON.stringify({
      seeded: true,
      actions: [
        {
          id: "legacy",
          name: "Legacy",
          instructions: "Legacy text",
          projectId: "old",
        },
      ],
    }),
  );
  await render();
  act(() => button("LegacyLegacy project — choose scope").click());
  expect(button("Add to draft").disabled).toBe(true);
  const select = host.querySelector("select")!;
  act(() => {
    select.value = "current";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(button("Add to draft").disabled).toBe(false);
  await act(async () => button("Save prompt").click());
  expect(readSavedPrompts()[0].cwd).toBe("/repo");
  expect(readSavedPrompts()[0].legacyProjectId).toBeUndefined();
});
it("cancels a pending deletion confirmation when its editor closes", async () => {
  let resolve!: (confirmed: boolean) => void;
  dialog.ask.mockImplementation(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  await render();
  act(() => button("ImplementAll working copies").click());
  act(() => button("Delete prompt").click());
  act(() => root.unmount());
  mounted = false;
  await act(async () => resolve(true));
  expect(localStorage.length).toBe(0);
  expect(readSavedPrompts()).toHaveLength(3);
});
it("cancels a queued Web Lock write when its editor closes", async () => {
  let write!: () => unknown;
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, callback: () => unknown) =>
        new Promise((resolve, reject) => {
          write = () => {
            try {
              resolve(callback());
            } catch (reason) {
              reject(reason);
            }
          };
        }),
    },
  });
  await render();
  act(() => button("ImplementAll working copies").click());
  act(() => button("Save prompt").click());
  act(() => root.unmount());
  mounted = false;
  await act(async () => {
    write();
  });
  expect(localStorage.length).toBe(0);
});
