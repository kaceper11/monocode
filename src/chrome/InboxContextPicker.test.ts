// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { InboxContextPicker, useInboxContext } from "./InboxContextPicker";
import type { InboxItem } from "../lib/githubTasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../surfaces/AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => createElement("p", null, text),
}));
const ticket = {
  provider: "jira",
  kind: "issue",
  id: "1",
  number: 1,
  identifier: "ENG-1",
  title: "Review context",
  url: "https://team.atlassian.net/browse/ENG-1",
  repo: "",
  projectName: "Engineering",
  projectPath: "/local/project",
  labels: [],
  assignees: [],
} as unknown as InboxItem;

it("reviews before handoff, restores selection for Ask, and cancels without delivery", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  const data = {
    owner: "jira:account:1",
    description: "Requirements",
    comments: [
      {
        id: "c1",
        author: "Sam",
        body: "Discuss this",
        createdAt: "2026-09-10",
        updatedAt: "",
      },
    ],
    files: [],
    more: false,
  };
  vi.mocked(invoke).mockResolvedValue(data);
  const delivered = vi.fn().mockResolvedValue(undefined);
  function Fixture() {
    const context = useInboxContext(ticket);
    return createElement(
      "div",
      null,
      createElement("button", { onClick: () => context.open() }, "Send"),
      createElement("button", { onClick: () => context.open() }, "Ask"),
      createElement(InboxContextPicker, { context, onConfirm: delivered }),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) =>
    [...document.querySelectorAll("button")].find(
      (el) => el.textContent === text,
    )!;
  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.click();
    });
  };
  try {
    await act(async () => root.render(createElement(Fixture)));
    await click(button("Send"));
    expect(delivered).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await click(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Include description"]',
      )!,
    );
    await click(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Include comment by Sam"]',
      )!,
    );
    await click(button("Open discussion"));
    expect(delivered).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Discuss this"),
      }),
    );
    expect(delivered.mock.calls[0][0].prompt).not.toContain("Requirements");
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Fixture)));
    await click(button("Ask"));
    expect(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Include description"]',
      )?.checked,
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Include comment by Sam"]',
      )?.checked,
    ).toBe(true);
    await click(button("Cancel"));
    expect(delivered).toHaveBeenCalledTimes(1);
    await click(button("Ask"));
    await click(button("Open discussion"));
    expect(delivered).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Discuss this"),
      }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
