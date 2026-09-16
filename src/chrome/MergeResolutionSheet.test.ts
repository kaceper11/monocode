// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MergeResolutionSheet } from "./MergeResolutionSheet";
import type { MergeResolutionRequest } from "../lib/syncDefault";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(request: Partial<MergeResolutionRequest> = {}) {
  const choose = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const req: MergeResolutionRequest = {
    key: "/repo",
    cwd: "/repo",
    sessionId: "session-1",
    title: "Merge conflicts",
    op: "merge",
    syncedWith: "origin/main",
    conflicts: ["src/app.ts", "src/lib.ts"],
    choose,
    ...request,
  };
  await act(async () =>
    root!.render(createElement(MergeResolutionSheet, { request: req })),
  );
  return choose;
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((value) =>
    value.textContent?.includes(text),
  );
  expect(found, `button containing "${text}"`).toBeTruthy();
  return found as HTMLButtonElement;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("MergeResolutionSheet", () => {
  it("names the operation, working copy and conflicts, and offers three exits", async () => {
    await render();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Merge conflicts");
    expect(dialog?.textContent).toContain("Merging origin/main");
    expect(dialog?.textContent).toContain("src/app.ts");
    expect(dialog?.textContent).toContain("src/lib.ts");
    button("Send to owning agent");
    button("Abort merge and restore");
    button("Resolve manually");
  });

  it("resolves agent, abort and keep to the matching choice", async () => {
    const choose = await render();
    await act(async () => button("Send to owning agent").click());
    expect(choose).toHaveBeenCalledWith("agent");
    choose.mockClear();
    await act(async () => button("Abort merge and restore").click());
    expect(choose).toHaveBeenCalledWith("abort");
    choose.mockClear();
    await act(async () => button("Resolve manually").click());
    expect(choose).toHaveBeenCalledWith("keep");
  });

  it("treats Escape and Close as keep — the conflicts stay in the tree", async () => {
    const choose = await render();
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(choose).toHaveBeenCalledWith("keep");
    choose.mockClear();
    await act(async () =>
      (document.querySelector('[aria-label="Close"]') as HTMLElement).click(),
    );
    expect(choose).toHaveBeenCalledWith("keep");
  });

  it("names a rebase and a sessionless copy correctly", async () => {
    await render({ op: "rebase", sessionId: undefined });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Rebasing onto origin/main");
    expect(dialog?.textContent).toContain("Abort rebase and restore");
    button("Send to an agent");
  });
});
