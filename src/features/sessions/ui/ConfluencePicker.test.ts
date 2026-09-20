// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../../shared/ui/Modal.tsx", () => ({ Modal: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
vi.mock("./Select", () => ({ Select: () => null }));
vi.mock("./AgentMarkdown.tsx", () => ({ AgentMarkdown: () => null }));
import { ConfluencePicker } from "./ConfluencePicker";

let container: HTMLDivElement;
let root: Root;
let mounted: boolean;
const connection = { site: "https://team.atlassian.net", accountId: "email:ada@example.test" };
const page = { id: "42", title: "Plan", status: "current", version: { number: 3 }, body: { storage: { value: "<p>Plan body</p>" } } };
const onAdd = vi.fn();
const onClose = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invoke.mockReset(); onAdd.mockReset(); onClose.mockReset();
  invoke.mockImplementation(async command => {
    if (command === "jira_status") return { ...connection, connected: true, capabilities: ["Confluence"] };
    if (command === "confluence_spaces") return { spaces: [] };
    if (command === "confluence_search") return { results: [page] };
    if (command === "confluence_page") return page;
    throw new Error(command);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container); mounted = true;
});
afterEach(() => {
  if (mounted) act(() => root.unmount());
  container.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});
async function selectPage() {
  await act(async () => root.render(createElement(ConfluencePicker, { onAdd, onClose })));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  act(() => container.querySelector<HTMLInputElement>('[aria-label="Select Plan"]')!.click());
}
async function send() {
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Add to chat")!.click());
}
it("binds every read and the attached provenance to the displayed account", async () => {
  await selectPage(); await send();
  for (const [command, args] of invoke.mock.calls) {
    if (command.startsWith("confluence_")) expect(args).toMatchObject(connection);
  }
  expect(onAdd).toHaveBeenCalledOnce();
  expect(onAdd.mock.calls[0][0].entries[0].origin).toContain(connection.accountId);
  expect(onClose).toHaveBeenCalledOnce();
});
it("rejects a cached selection after the Atlassian account changes", async () => {
  await selectPage();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!.click());
  invoke.mockImplementation(async command => {
    if (command === "jira_status") return { ...connection, accountId: "email:other@example.test", connected: true };
    throw new Error(command);
  });
  await send();
  expect(onAdd).not.toHaveBeenCalled();
  expect(container.textContent).toContain("account changed");
});
it("does not attach an in-flight page after the picker is unmounted", async () => {
  await selectPage();
  let finish!: (value: typeof page) => void;
  invoke.mockImplementation(async command => {
    if (command === "confluence_page") return new Promise(resolve => { finish = resolve; });
    return { ...connection, connected: true };
  });
  await send();
  act(() => root.unmount()); mounted = false;
  await act(async () => finish(page));
  expect(onAdd).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
it("preserves selection on same-account focus but cancels old reads when focus reveals a new account", async () => {
  await selectPage();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.querySelector<HTMLInputElement>('[aria-label="Select Plan"]')!.checked).toBe(true);
  let finish!: (value: typeof page) => void;
  let accountId = connection.accountId;
  invoke.mockImplementation(async command => {
    if (command === "jira_status") return { ...connection, accountId, connected: true, capabilities: ["Confluence"] };
    if (command === "confluence_page") return new Promise(resolve => { finish = resolve; });
    if (command === "confluence_spaces") return { spaces: [] };
    if (command === "confluence_search") return { results: [page] };
    throw new Error(command);
  });
  await send();
  accountId = "email:new@example.test";
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () => finish(page));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(onAdd).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(container.textContent).toContain(accountId);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Select Plan"]')!.checked).toBe(false);
});
