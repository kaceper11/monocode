// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const { options } = vi.hoisted(() => ({ options: vi.fn() }));
vi.mock("../lib/azure", () => ({ azureOptions: options, saveAzureFilter: vi.fn() }));
vi.mock("./Popover", () => ({ Popover: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
import { InboxFiltersMenu } from "./InboxFiltersMenu";
import { DEFAULT_INBOX_FILTERS } from "../lib/inboxFilters";

it("discards Azure options when the displayed account changes, including late requests", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const pending: ((value: unknown) => void)[] = [];
  options.mockImplementation(async (_site, _project, queries, account) => {
    if (account === "b") return new Promise(resolve => pending.push(resolve));
    return [{ id: `${account}-${queries}`, name: `${account} ${queries ? "query" : "project"}` }];
  });
  const render = async (accountId: string) => act(async () => root.render(createElement(InboxFiltersMenu, {
    x: 0, y: 0, projects: [], linearProjects: [], linearTeams: [], hiddenLinearTeamIds: [],
    source: "azure", filters: DEFAULT_INBOX_FILTERS, onChange: vi.fn(), onLinearTeamsChange: vi.fn(), onClose: vi.fn(),
    azure: { site: "https://dev.azure.com/team", accountId, filter: { project: "Product", query: "", assigned: true } },
  })));
  try {
    await render("a");
    expect(container.textContent).toContain("a project");
    await render("b");
    expect(container.textContent).not.toContain("a project");
    expect(container.textContent).not.toContain("a query");
    await render("c");
    expect(container.textContent).toContain("c project");
    await act(async () => { pending.forEach(resolve => resolve([{ id: "old", name: "b late result" }])); });
    expect(container.textContent).not.toContain("b late result");
    expect(container.textContent).toContain("c query");
    expect(options).toHaveBeenCalledWith("https://dev.azure.com/team", "Product", true, "c");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
