// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Popover } from "./Popover";

let root: Root;
let container: HTMLDivElement;
let anchor: HTMLButtonElement;

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
  anchor = document.createElement("button");
  container.append(anchor);
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const escape = async () =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });

it("dismisses only the topmost popover per Escape", async () => {
  const outer = vi.fn();
  const inner = vi.fn();
  // Like a menu opened from an already-visible popover — the later mount is
  // the one Escape dismisses, and it unmounts so the parent is next.
  function Fixture() {
    const [innerOpen, setInnerOpen] = useState(false);
    return createElement(
      Popover,
      { anchor, onDismiss: outer, role: "menu" },
      "outer",
      createElement("button", {
        onClick: () => setInnerOpen(true),
        "aria-label": "open inner",
      }),
      innerOpen
        ? createElement(
            Popover,
            {
              anchor,
              onDismiss: () => {
                setInnerOpen(false);
                inner();
              },
              role: "menu",
            },
            "inner",
          )
        : null,
    );
  }
  await act(async () => root.render(createElement(Fixture)));
  await act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((el) => el.getAttribute("aria-label") === "open inner")!
      .click();
  });
  await escape();
  expect(inner).toHaveBeenCalledOnce();
  expect(outer).not.toHaveBeenCalled();
  await escape();
  expect(outer).toHaveBeenCalledWith("escape");
});
