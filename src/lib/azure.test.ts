// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  azureItem,
  azureOptions,
  azureMarkdown,
  azureDetails,
  peekAzureDetails,
  loadAzureFilter,
  saveAzureFilter,
  saveAzureConfig,
  listAzureItems,
} from "./azure";
import {
  clearInboxCache,
  dedupeInboxItems,
  inboxItemStatus,
  inboxComposerCard,
  listInboxItems,
} from "./githubTasks";
import { inboxAskKey } from "./inboxAsk";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const call = vi.mocked(invoke);
const site = "https://dev.azure.com/team";
const raw = {
  id: 142,
  stateCategory: "Completed",
  fields: {
    "System.Title": "Checkout",
    "System.TeamProject": "Product",
    "System.WorkItemType": "Custom bug",
    "System.State": "Released to users",
    "System.Description": "<p>Fix <b>checkout</b></p>",
  },
};
const item = azureItem(site, raw);
beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  call.mockReset();
  clearInboxCache();
});
it("keeps colliding IDs separate, custom states readable, and Git independent", () => {
  const otherOrg = azureItem("https://dev.azure.com/other", raw);
  const otherProject = azureItem(site, {
    ...raw,
    fields: { ...raw.fields, "System.TeamProject": "Operations" },
  });
  expect(dedupeInboxItems([item, otherOrg, otherProject])).toHaveLength(3);
  expect(inboxAskKey(item)).not.toBe(inboxAskKey(otherOrg));
  expect(item.identifier).toBe("Custom bug 142");
  expect(item.state).toBe("Released to users");
  expect(inboxItemStatus(item)).toBe("Closed");
  expect(inboxItemStatus({ ...item, stateType: "unknown" })).toBe("Unknown");
  expect(inboxItemStatus({ ...item, kind: "pr", state: "unknown" })).toBe("Unknown");
  expect(item.repo).toBe("");
  expect(item.projectPath).toBe("");
  expect(
    azureItem(site, {
      ...raw,
      fields: { ...raw.fields, "System.TeamProject": "Ada's (Product)" },
    }).url,
  ).toBe(`${site}/Ada%27s%20%28Product%29/_workitems/edit/142`);
  const prompt = inboxComposerCard(item, "context").prompt;
  for (const text of [
    site,
    "Product",
    "Custom bug 142",
    item.url,
    "context",
    "untrusted",
  ])
    expect(prompt).toContain(text);
});
it("remembers organization-specific project and query choices", async () => {
  expect(loadAzureFilter(site, "Product")).toEqual({
    project: "Product",
    query: "",
    assigned: true,
  });
  saveAzureFilter(site, {
    project: "Operations",
    query: "chosen-query",
    assigned: false,
  });
  saveAzureFilter("https://dev.azure.com/other", {
    project: "Other",
    query: "",
    assigned: true,
  });
  call.mockResolvedValue({ site, items: [] });
  await listAzureItems({
    connected: true,
    site,
    project: "Product",
    account: "Ada",
    accountId: "account-a",
    capabilities: ["Boards"],
  });
  expect(call).toHaveBeenCalledWith("azure_list_items", {
    site,
    accountId: "account-a",
    project: "Operations",
    query: "chosen-query",
    assigned: false,
  });
});
it("converts inert HTML and retains readable content without executable markup or remote image requests", () => {
  const text = azureMarkdown(
    '<h2>Summary</h2><p>Fix <strong>checkout</strong> &amp; tax</p><ul><li>First</li></ul><script>secret()</script><img src="https://external.test/image" onerror="alert(1)"><a href="javascript:alert(1)">bad link</a>',
  );
  expect(text).toContain("## Summary");
  expect(text).toContain("**checkout** & tax");
  expect(text).toContain("- First");
  for (const unsafe of ["secret()", "external.test", "javascript:", "onerror"])
    expect(text).not.toContain(unsafe);
  expect(azureMarkdown("a".repeat(140_000))).toContain("Truncated");
});
it("does no Boards IO when disconnected and isolates failures", async () => {
  call.mockImplementation(async (cmd) => {
    if (cmd === "jira_status") throw new Error("Jira unavailable");
    return { connected: false };
  });
  const result = await listInboxItems([], {
    assignedToMe: false,
    state: "all",
    search: "",
  });
  expect(result.errors.azure).toContain("Connect Azure");
  expect(result.errors.jira).toBe("Jira unavailable");
  expect(call.mock.calls.some(([cmd]) => cmd === "azure_list_items")).toBe(
    false,
  );
});
it("discards a pending detail read after disconnect", async () => {
  let finish!: (value: unknown) => void;
  call.mockImplementation(async (cmd) =>
    cmd === "azure_item_content"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { connected: false },
  );
  const pending = azureDetails(item);
  await saveAzureConfig(site, "Product", "");
  finish(raw);
  await expect(pending).rejects.toThrow("connection changed");
  expect(peekAzureDetails(item)).toBeNull();
});

it("starts Azure discovery while Jira discovery is still pending", async () => {
  let finish!: (value: unknown) => void;
  call.mockImplementation(async command => command === "jira_status"
    ? new Promise(resolve => { finish = resolve; })
    : { connected: false });
  const pending = listInboxItems([], { assignedToMe: false, state: "all", search: "" });
  try {
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(call.mock.calls.some(([command]) => command === "azure_status")).toBe(true);
  } finally {
    finish({ connected: false });
    await pending;
  }
});

it("separates detail caches and reads by the displayed account", async () => {
  call.mockResolvedValue(raw);
  const owned = { ...item, account: "account-a" };
  await azureDetails(owned);
  expect(call).toHaveBeenLastCalledWith("azure_item_content", { site: owned.site, id: owned.id, accountId: "account-a", discussion: false });
  expect(peekAzureDetails(owned)).not.toBeNull();
  expect(peekAzureDetails({ ...owned, account: "account-b" })).toBeNull();
});


it("binds project and saved-query options to the displayed account", async () => {
  call.mockResolvedValue([]);
  await azureOptions(site, "Product", true, "account-a");
  expect(call).toHaveBeenLastCalledWith("azure_options", { site, project: "Product", queries: true, accountId: "account-a" });
});
