// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke, listen, callbacks } = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), callbacks: new Map<string, () => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
beforeEach(() => {
  vi.resetModules(); invoke.mockReset(); listen.mockReset(); callbacks.clear();
  listen.mockImplementation(async (event, callback) => { callbacks.set(event, callback); return () => callbacks.delete(event); });
});
afterEach(() => vi.restoreAllMocks());
it("invalidates jira reads on remote connection events without duplicating the caller event", async () => {
  const jira = await import("./jira");
  const api = {
    connected: jira.jiraConnected, save: () => jira.saveJiraConfig("", "", ""),
    details: jira.jiraDetails, peek: jira.peekJiraDetails,
    item: jira.jiraIssue("https://team.atlassian.net", { id: "1", key: "ENG-1", fields: { summary: "Plan" } }),
  };
  const event = "monocode:jira-change";
  invoke.mockResolvedValue({ connected: false });
  await api.connected();
  expect(listen).toHaveBeenCalledOnce();
  const observed = vi.fn();
  window.addEventListener(event, observed);
  try {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(async command => {
      if (command.endsWith("_content")) return new Promise(resolve => { finish = resolve; });
      if (command.endsWith("_set_config")) callbacks.get(event)!();
      return { connected: false };
    });
    const pending = api.details(api.item);
    callbacks.get(event)!(); // Native notification from another window.
    finish({ fields: { description: "Old page" } });
    await expect(pending).rejects.toThrow("connection changed");
    expect(api.peek(api.item)).toBeNull();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0][0].detail).toBe("connection");
    observed.mockClear();
    await api.save();
    expect(observed).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
  } finally { window.removeEventListener(event, observed); }
});
it("registers the jira listener before reading status so no connection change is missed", async () => {
  let registered!: (unlisten: () => void) => void;
  listen.mockImplementation(() => new Promise(resolve => { registered = resolve; }));
  invoke.mockResolvedValue({ connected: false });
  const jira = await import("./jira");
  const pending = jira.jiraConnected();
  expect(invoke).not.toHaveBeenCalled();
  registered(() => {});
  await pending;
  expect(invoke).toHaveBeenCalledExactlyOnceWith("jira_status");
});
