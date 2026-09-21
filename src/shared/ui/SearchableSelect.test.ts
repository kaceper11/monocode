// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LAYER } from "../lib/layers";
import { SearchableSelect } from "./SearchableSelect";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body
    .querySelectorAll("[data-dialog-popover]")
    .forEach((element) => element.parentElement?.remove());
  vi.unstubAllGlobals();
});

it("raises menus above a containing modal by default", async () => {
  await act(async () => {
    root.render(
      createElement(
        "div",
        { role: "dialog" },
        createElement(SearchableSelect, {
          label: "Agent",
          value: "codex",
          options: [
            { value: "codex", label: "Codex" },
            { value: "claude", label: "Claude" },
          ],
          onChange: vi.fn(),
        }),
      ),
    );
  });

  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => trigger.click());

  const menu = document.body.querySelector<HTMLElement>(
    '[aria-label="Agent options"]',
  );
  expect(menu).not.toBeNull();
  expect(menu!.parentElement!.style.zIndex).toBe(String(LAYER.dialogPopover));
});

it("does not scroll the page when a compact menu opens", async () => {
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  await act(async () => {
    root.render(
      createElement(SearchableSelect, {
        label: "Timeout",
        value: "60",
        variant: "pill",
        searchable: false,
        options: [
          { value: "30", label: "30 sec" },
          { value: "60", label: "1 min" },
          { value: "120", label: "2 min" },
          { value: "300", label: "5 min" },
        ],
        onChange: vi.fn(),
      }),
    );
  });

  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => trigger.click());
  await act(async () => {
    await Promise.resolve();
  });

  expect(scrollIntoView).not.toHaveBeenCalled();
  const option = document.body.querySelector('[role="option"]');
  expect(option?.className).toContain("h-7");
});

const typeSearch = async (text: string) => {
  const search = document.body.querySelector<HTMLInputElement>(
    '[role="combobox"]',
  )!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(search, text);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const optionTexts = () =>
  [...document.body.querySelectorAll('[role="option"]')].map(
    (element) => element.textContent,
  );

it("creatable: typed text becomes a pickable option and verbatim value", async () => {
  const onChange = vi.fn();
  await act(async () => {
    root.render(
      createElement(SearchableSelect, {
        label: "Branch",
        value: "",
        creatable: "New branch",
        options: [{ value: "main", label: "main" }],
        onChange,
      }),
    );
  });
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => trigger.click());
  await typeSearch("mc/new-thing");

  expect(optionTexts()).toEqual(['New branch "mc/new-thing"']);
  const option = document.body.querySelector<HTMLElement>('[role="option"]')!;
  await act(async () => option.click());
  expect(onChange).toHaveBeenCalledWith("mc/new-thing");
});

it("creatable: no create row on exact match; trigger shows a raw value", async () => {
  await act(async () => {
    root.render(
      createElement(SearchableSelect, {
        label: "Branch",
        value: "typed-name",
        creatable: "New branch",
        options: [{ value: "main", label: "main" }],
        onChange: vi.fn(),
      }),
    );
  });
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  expect(trigger.textContent).toContain("typed-name");

  await act(async () => trigger.click());
  await typeSearch("main");
  expect(optionTexts()).toEqual(["main"]);
});
