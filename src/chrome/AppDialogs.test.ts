// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppDialogs } from "./AppDialogs";
import { appDialogSnapshot, ask, message } from "../lib/dialogs";

let host: HTMLDivElement | undefined;
let root: Root | undefined;

function renderHost() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(AppDialogs)));
}

function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function button(text: string): HTMLButtonElement {
  return Array.from(
    document.body.querySelectorAll<HTMLButtonElement>(
      '[role="dialog"] button',
    ),
  ).find((entry) => entry.textContent === text)!;
}

afterEach(async () => {
  // Never leak a pending request into the next test.
  for (const request of [...appDialogSnapshot()]) {
    await act(async () => request.settle(false));
  }
  await act(async () => root?.unmount());
  host?.remove();
  host = undefined;
  root = undefined;
  vi.unstubAllGlobals();
});

it("renders an in-app confirm and resolves true on OK", async () => {
  renderHost();
  let answer: boolean | null | undefined;
  await act(async () => {
    void ask("Sync this working copy?", {
      title: "Sync with remote default",
      okLabel: "Sync",
    }).then((ok) => (answer = ok));
  });
  expect(dialog()?.textContent).toContain("Sync this working copy?");
  expect(dialog()?.textContent).toContain("Sync with remote default");
  await act(async () => button("Sync").click());
  expect(answer).toBe(true);
  expect(dialog()).toBeNull();
});

it("resolves null on a bare dismiss — Escape, backdrop and the header X", async () => {
  renderHost();
  let answer: boolean | null | undefined;
  await act(async () => {
    void ask("Delete this?").then((ok) => (answer = ok));
  });
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(answer).toBeNull();

  answer = undefined;
  await act(async () => {
    void ask("Delete this?").then((ok) => (answer = ok));
  });
  await act(async () =>
    document
      .body.querySelector(".modal-backdrop")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })),
  );
  expect(answer).toBeNull();

  answer = undefined;
  await act(async () => {
    void ask("Delete this?").then((ok) => (answer = ok));
  });
  await act(async () =>
    dialog()
      ?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      ?.click(),
  );
  expect(answer).toBeNull();
});

it("renders a notice with a single OK button and a severity icon", async () => {
  renderHost();
  let resolved = false;
  await act(async () => {
    void message("Update ready", { kind: "warning" }).then(
      () => (resolved = true),
    );
  });
  expect(dialog()?.textContent).toContain("Update ready");
  expect(dialog()?.textContent).toContain("OK");
  expect(dialog()?.textContent).not.toContain("Cancel");
  expect(dialog()?.querySelector("svg")).not.toBeNull();
  await act(async () => button("OK").click());
  expect(resolved).toBe(true);
  expect(dialog()).toBeNull();
});

it("shows one dialog at a time — the queued request follows", async () => {
  renderHost();
  let first: boolean | null | undefined;
  await act(async () => {
    void ask("First?").then((ok) => (first = ok));
    void message("Second");
  });
  expect(dialog()?.textContent).toContain("First?");
  expect(dialog()?.textContent).not.toContain("Second");
  await act(async () => button("Cancel").click());
  expect(first).toBe(false);
  expect(dialog()?.textContent).toContain("Second");
  await act(async () => button("OK").click());
  expect(dialog()).toBeNull();
});
