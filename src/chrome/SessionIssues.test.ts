// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { OPEN_INBOX_WORK_ITEM } from "../lib/sessionWorkItem";
import { SessionIssues } from "./SessionIssues";
import { newSession } from "../lib/session";

it("keeps reopened mixed-provider references at the top and offers adding issues", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const session = newSession("codex", "/project");
  session.linkedWorkItem = { kind: "issue", repo: "a/b", number: 8, url: "https://github.com/a/b/issues/8", title: "Original issue", context: "Original snapshot", additionalItems: [{ provider: "jira", kind: "issue", repo: "ENG", number: 13, identifier: "ENG-13", url: "https://example.atlassian.net/browse/ENG-13" }] };
  const onAdd = vi.fn();
  try {
    await act(async () => root.render(createElement(SessionIssues, { session, onAdd })));
    expect(host.textContent).toContain("Issues · #8, ENG-13");
    // Linked issues start expanded — no toggle click needed.
    expect(host.querySelector('[aria-label="Open Issue #8 in Inbox"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Open Issue ENG-13 in Inbox"]')).not.toBeNull();
    const opened = vi.fn();
    window.addEventListener(OPEN_INBOX_WORK_ITEM, opened, { once: true });
    await act(async () => (host.querySelector('[aria-label="Open Issue #8 in Inbox"]') as HTMLButtonElement).click());
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ repo: "a/b", number: 8, url: session.linkedWorkItem!.url });

    const preview = host.querySelector("details")!;
    await act(async () => { preview.open = true; preview.dispatchEvent(new Event("toggle")); });
    expect(host.textContent).toContain("Original snapshot");
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Add issues")!.click());
    expect(onAdd).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
