// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InboxFiltersMenu } from "./InboxFiltersMenu";
import { DEFAULT_INBOX_FILTERS, loadInboxFilters, saveInboxFilters } from "../model/inboxFilters";
import { DEFAULT_JIRA_FILTER, loadJiraFilter, saveJiraFilter } from "../../sessions/model/jira";

it("keeps personal choices independent, persisted, and clearable despite the shared assignment flag", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Harness({ source }: { source: "azuredevops" | "jira" }) {
    const [filters, setFilters] = useState({ ...DEFAULT_INBOX_FILTERS, assignedToMe: true });
    const [jira, setJira] = useState(DEFAULT_JIRA_FILTER);
    return createElement(InboxFiltersMenu, { jiraProjects: [], hiddenJiraProjectIds: [], onJiraProjectsChange: vi.fn(),
      x: 20, y: 20, source, projects: [], linearProjects: [], linearTeams: [],
      hiddenLinearTeamIds: [], onLinearTeamsChange: () => {}, filters, jiraFilter: jira, onClose: () => {},
      onChange: next => { setFilters(next); saveInboxFilters(next); },
      onJiraFilterChange: next => { setJira(next); saveJiraFilter("https://team.atlassian.net", next); },
    });
  }
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(element => element.textContent?.trim() === label)!;
  try {
    await act(async () => root.render(createElement(Harness, { source: "azuredevops" })));
    expect(button("Related to me").getAttribute("aria-checked")).toBe("true");
    await act(async () => button("Created by me").click());
    expect(loadInboxFilters().azureRelationship).toBe("created");
    await act(async () => root.render(createElement(Harness, { source: "jira" })));
    expect(button("Related to me").disabled).toBe(false);
    expect(button("Reviewing")).toBeUndefined();
    await act(async () => button("Assigned to me").click());
    expect(loadJiraFilter("https://team.atlassian.net").relationship).toBe("assigned");
    await act(async () => button("Clear filters").click());
    expect(button("All").getAttribute("aria-checked")).toBe("true");
    expect(loadInboxFilters().azureRelationship).toBe("created");
    await act(async () => root.render(createElement(Harness, { source: "azuredevops" })));
    expect(button("Created by me").getAttribute("aria-checked")).toBe("true");
    await act(async () => button("Clear filters").click());
    expect(loadInboxFilters().azureRelationship).toBe("all");
    expect(loadJiraFilter("https://team.atlassian.net").relationship).toBe("all");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});
