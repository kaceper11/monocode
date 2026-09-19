// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkedWorkItem } from "../lib/session";
const api = vi.hoisted(() => ({ status: vi.fn(), refresh: vi.fn() }));
vi.mock("../lib/azure", () => ({ azureConnected: api.status, AZURE_CHANGE_EVENT: "azure-changed" }));
vi.mock("../lib/jira", () => ({ jiraConnected: api.status, JIRA_CHANGE_EVENT: "jira-changed" }));
vi.mock("../lib/linkedWorkItemRefresh", () => ({ refreshLinkedWorkItem: api.refresh }));
import { LinkedWorkItemAccount } from "./LinkedWorkItemAccount";
let host: HTMLDivElement;
let root: Root;
let unmounted = false;
const target: LinkedWorkItem = { provider: "jira", kind: "issue", number: 7, repo: "", url: "https://team.example/browse/ABC-7" };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.status.mockReset().mockResolvedValue({ connected: true, site: "https://team.example", accountId: "account-a", account: "Work account" });
  api.refresh.mockReset().mockResolvedValue({ account: "account-a" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); unmounted = false;
});
afterEach(async () => { if (!unmounted) await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const choose = () => (Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Use Work account") as HTMLButtonElement).click();

it.each(["jira", "azure"] as const)("binds a legacy %s link only after the displayed account is chosen and checked", async provider => {
  const onBind = vi.fn(() => true);
  await act(async () => root.render(createElement(LinkedWorkItemAccount, { target: { ...target, provider }, cwd: "/repo", onBind })));
  expect(host.textContent).toContain("https://team.example");
  expect(api.refresh).not.toHaveBeenCalled();
  expect(onBind).not.toHaveBeenCalled();
  await act(async () => choose());
  expect(api.refresh).toHaveBeenCalledWith("/repo", { ...target, provider, account: "account-a", site: "https://team.example" });
  expect(onBind).toHaveBeenCalledWith("account-a", "https://team.example");
});

it("does not offer an account for a different saved site", async () => {
  api.status.mockResolvedValue({ connected: true, site: "https://other.example", accountId: "account-a", account: "Work account" });
  await act(async () => root.render(createElement(LinkedWorkItemAccount, { target, cwd: "/repo", onBind: vi.fn() })));
  expect(host.textContent).toContain("different site");
  expect(host.textContent).not.toContain("Use Work account");
  expect(api.refresh).not.toHaveBeenCalled();
});

it.each(["unmount", "connection"])("discards a late item check after %s", async change => {
  let resolve!: (value: unknown) => void;
  api.refresh.mockReturnValue(new Promise(done => { resolve = done; }));
  const onBind = vi.fn(() => true);
  await act(async () => root.render(createElement(LinkedWorkItemAccount, { target, cwd: "/repo", onBind })));
  await act(async () => choose());
  await act(async () => {
    if (change === "unmount") { root.unmount(); unmounted = true; }
    else window.dispatchEvent(new Event("jira-changed"));
  });
  await act(async () => resolve({ account: "account-a" }));
  expect(onBind).not.toHaveBeenCalled();
});
