// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./Modal", () => ({ Modal: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
import { BrowserContextPicker } from "./BrowserContextPicker";
import { useBrowserContextTarget } from "../lib/browserContext";
import { contextFromText } from "../lib/agentContext";
import type { HarnessId } from "../lib/session";

let host: HTMLDivElement;
let root: Root;
const accept = vi.fn();
const close = vi.fn();
const context = contextFromText("Captured page", "Untrusted page text", "Native browser · https://example.test");
function Target({ harness }: { harness: HarnessId }) {
  useBrowserContextTarget("session", "/repo", harness, true, accept);
  return null;
}
async function render(harness: HarnessId = "claude", present = true) {
  await act(async () => root.render(createElement(Fragment, null,
    present ? createElement(Target, { harness }) : null,
    createElement(BrowserContextPicker, { context, sessions: [], onClose: close }),
  )));
}
function select() {
  const element = host.querySelector("select")!;
  act(() => { element.value = "session"; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
function button(text: string) { return [...host.querySelectorAll("button")].find(element => element.textContent === text)!; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  accept.mockReset(); close.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("requires an explicit destination and invalidates selection when its provider changes or it closes", async () => {
  await render();
  expect(button("Add to draft").disabled).toBe(true);
  select();
  expect(button("Add to draft").disabled).toBe(false);
  await render("codex");
  expect(button("Add to draft").disabled).toBe(true);
  expect(host.textContent).toContain("destination changed or closed");
  expect(accept).not.toHaveBeenCalled();
  select();
  act(() => button("Add to draft").click());
  expect(accept).toHaveBeenCalledWith(context);
  expect(close).toHaveBeenCalledOnce();
  await render("codex", false);
  expect(button("Add to draft").disabled).toBe(true);
});
it("keeps failed additions reviewable and cancelling does not deliver context", async () => {
  await render(); select();
  accept.mockImplementation(() => { throw new Error("Draft capacity exceeded"); });
  act(() => button("Add to draft").click());
  expect(host.textContent).toContain("Draft capacity exceeded");
  expect(close).not.toHaveBeenCalled();
  accept.mockClear();
  act(() => button("Cancel").click());
  expect(accept).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
