// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AzureCiReview } from "./AzureCiReview";
import { FilePane } from "../surfaces/FilePane";
import { AZURE_CHANGE_EVENT } from "../lib/azure";
import { PREPARE_AGENT_CONTEXT } from "../lib/agentContext";
import { saveCiSources, type CiSource } from "../lib/azurePipelines";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
const target = {
  site: "https://dev.azure.com/team",
  accountId: "account-a",
  project: "project-a",
  definition: 7,
  repositoryId: "team/repo",
  repositoryType: "GitHub",
  repositoryUrl: "https://github.com/team/repo",
};
const source: CiSource = {
  target,
  cwd: "wsl://Ubuntu/work/repo",
  branch: "feature",
  session: "owner",
  remote: target.repositoryUrl,
  definitionName: "Tests",
  projectName: "Project",
};
const run = {
  id: 12,
  number: "12",
  status: "completed",
  result: "failed",
  branch: "refs/heads/feature",
  commit: "head",
  revision: "run-attempt-1",
  match: "exact",
  queuedAt: "now",
};
let stale = false;
let accountId = target.accountId;
beforeEach(() => {
  stale = false;
  accountId = target.accountId;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      const input = (
        args as {
          input?: {
            target: typeof target;
            section: string;
            runId: number;
            skip?: number;
          };
        }
      )?.input;
      if (command === "azure_status")
        return {
          connected: true,
          site: target.site,
          accountId,
          account: "Ada",
          project: "Project",
          capabilities: ["Pipelines"],
        };
      if (command === "azure_ci_context")
        return {
          cwd: source.cwd,
          branch: "feature",
          commit: "head",
          remotes: [{ name: "origin", url: source.remote }],
        };
      if (command === "azure_ci_lookup") {
        if (input?.target.definition === 8)
          throw new Error("Pipeline access denied");
        return {
          target,
          projectName: "Project",
          definitionName: "Tests",
          checkedAt: 1,
          continuation: null,
          items: [
            run,
            {
              ...run,
              id: 11,
              result: "succeeded",
              commit: "old",
              match: "old-commit",
            },
          ],
        };
      }
      if (command === "azure_ci_read") {
        if (stale)
          throw new Error(
            "Run changed or was retried. Refresh CI evidence before continuing.",
          );
        if (input?.section === "summary")
          return input.runId === 11
            ? {
                ...run,
                id: 11,
                result: "succeeded",
                commit: "old",
                match: "old-commit",
              }
            : run;
        if (input?.section === "jobs")
          return {
            items: [
              {
                id: "job",
                name: "Unit tests",
                type: "Task",
                attempt: 2,
                state: "completed",
                result: "failed",
                logId: 9,
              },
            ],
            nextSkip: null,
            timelineId: "timeline",
          };
        if (input?.section === "log")
          return {
            text: "expected 1, got 2",
            startLine: 0,
            endLine: 1,
            lineCount: 2,
            recordId: "job",
            attempt: 2,
            logId: 9,
            bounded: true,
          };
      }
      throw new Error(`Unexpected ${command}`);
    });
});
const find = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === text,
  )!;
const click = async (text: string) => {
  await act(async () => find(text).click());
};
function ReviewNavigation(
  props: Omit<Parameters<typeof AzureCiReview>[0], "onClose">,
) {
  const [open, setOpen] = useState(false);
  return createElement(
    "div",
    null,
    createElement("button", { onClick: () => setOpen(true) }, "CI"),
    createElement(
      "button",
      { onClick: () => setOpen(false), "aria-label": "Files" },
      "Files",
    ),
    createElement(FilePane, {
      pane: {
        id: "review-pane",
        files: [
          {
            id: "ci",
            path: "ci",
            cwd: props.cwd,
            delivery: {
              kind: "ci",
              branch: props.branch,
              sourceSessionId: props.sourceSessionId,
            },
          },
        ],
        activeFileId: "ci",
      },
      focused: open,
      visible: open,
      dirtyFileIds: new Set<string>(),
      fileErrorCounts: new Map<string, number>(),
      sessions: [],
      onFocus: () => {},
      onSelectFile: () => setOpen(true),
      onCloseFile: () => setOpen(false),
      onDirtyChange: () => {},
      onErrorCountChange: () => {},
      onReorderFiles: () => {},
      onOpenFile: () => {},
      onUpdatePlan: () => {},
      onBuildPlan: () => {},
    }),
  );
}
async function setup(sources: CiSource[] = [source]) {
  saveCiSources(sources, source.cwd, source.branch, source.session);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ReviewNavigation, {
        cwd: source.cwd,
        branch: source.branch,
        sourceSessionId: source.session,
        enabled: true,
      }),
    ),
  );
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}
it("loads independent source errors, selected jobs and bounded logs, and prepares one scoped handoff", async () => {
  const cleanup = await setup([
    source,
    {
      ...source,
      target: { ...target, definition: 8 },
      definitionName: "Other source",
    },
  ]);
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    expect(invoke).not.toHaveBeenCalled();
    await click("CI");
    expect(document.body.textContent).toContain("Pipeline access denied");
    expect(document.body.textContent).toContain("Old commit");
    expect(document.body.textContent).toContain("Selected run 12");
    expect(document.body.textContent).toContain("Load log · Unit tests");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([, arg]) =>
            (arg as { input?: { section: string } })?.input?.section === "log",
        ),
    ).toBe(false);
    await click(
      "Run 12 · FailedCurrent checkout commit · head · refs/heads/feature",
    );
    await click("Refresh jobs");
    await click("Load log · Unit tests");
    expect(document.body.textContent).toContain("expected 1, got 2");
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Refresh runs")!
        .click(),
    );
    expect(document.body.textContent).toContain("expected 1, got 2");
    await click("Refresh all");
    expect(document.body.textContent).toContain("expected 1, got 2");
    expect(document.body.textContent).toContain("Selected run 12");
    await act(async () => {
      find("Send log to agent").click();
      find("Send log to agent").click();
    });
    expect(handoff).toHaveBeenCalledTimes(1);
    const request = (handoff.mock.calls[0][0] as CustomEvent).detail;
    expect(request.sourceSessionId).toBe("owner");
    expect(request.cwd).toBe(source.cwd);
    expect(JSON.stringify(request.context)).toContain("attempt: 2");
    const lookups = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "azure_ci_lookup").length;
    await click("Files");
    await act(async () =>
      request.onRefreshEvidence("Keep this repair instruction"),
    );
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "azure_ci_lookup").length,
    ).toBeGreaterThan(lookups);
    await click("Fix CI");
    expect(
      (handoff.mock.calls[1][0] as CustomEvent).detail.context.instruction,
    ).toBe("Keep this repair instruction");
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});
it("prevents a stale run or an old successful commit from being handed to an agent", async () => {
  const cleanup = await setup();
  const handoff = vi.fn();
  window.addEventListener(PREPARE_AGENT_CONTEXT, handoff);
  try {
    await click("CI");
    await click("Run 12 · PassedOld commit · old · refs/heads/feature");
    await click("Refresh jobs");
    await click("Load log · Unit tests");
    expect(find("Send log to agent").disabled).toBe(true);
    await click(
      "Run 12 · FailedCurrent checkout commit · head · refs/heads/feature",
    );
    await click("Refresh jobs");
    await click("Load log · Unit tests");
    stale = true;
    await click("Send log to agent");
    expect(handoff).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Run changed or was retried");
  } finally {
    window.removeEventListener(PREPARE_AGENT_CONTEXT, handoff);
    await cleanup();
  }
});

it("uses the app picker for repository selection and preserves it on Escape", async () => {
  const cleanup = await setup([]);
  try {
    await click("CI");
    expect(document.querySelector("select")).toBeNull();
    expect(
      document.querySelector('input[aria-label="Azure pipeline link"]'),
    ).toBeNull();
    await click("Connect a pipeline");
    const trigger = () =>
      document.querySelector(
        'button[aria-label^="Pipeline repository remote:"]',
      ) as HTMLButtonElement;
    await act(async () => trigger().click());
    const list = () =>
      document.querySelector('[role="listbox"]') as HTMLElement;
    expect(list()).not.toBeNull();
    await act(async () => {
      list().dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    await act(async () =>
      list().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(trigger().textContent).toContain("origin");
    expect(document.activeElement).toBe(trigger());
    await act(async () => trigger().click());
    await act(async () =>
      list().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(list()).toBeNull();
    expect(trigger().textContent).toContain("origin");
  } finally {
    await cleanup();
  }
});

it("clears previous account evidence after reconnecting another account", async () => {
  const cleanup = await setup();
  try {
    await click("CI");
    await click(
      "Run 12 · FailedCurrent checkout commit · head · refs/heads/feature",
    );
    await click("Refresh jobs");
    await click("Load log · Unit tests");
    expect(document.body.textContent).toContain("expected 1, got 2");
    accountId = "another-account";
    await act(async () => window.dispatchEvent(new Event(AZURE_CHANGE_EVENT)));
    expect(document.body.textContent).not.toContain("expected 1, got 2");
    expect(document.body.textContent).not.toContain("Selected run 12");
    expect(document.body.textContent).toContain("Reconnect the mapped Azure");
  } finally {
    await cleanup();
  }
});

it("preserves selected evidence and scroll across tab switches without hidden reads", async () => {
  const cleanup = await setup();
  try {
    await click("CI");
    await click(
      "Run 12 · FailedCurrent checkout commit · head · refs/heads/feature",
    );
    await click("Refresh jobs");
    await click("Load log · Unit tests");
    const panel = document.querySelector('[aria-label="Azure pipeline runs"]')!;
    panel.scrollTop = 180;
    await click("Files");
    const count = vi.mocked(invoke).mock.calls.length;
    await act(async () => window.dispatchEvent(new Event(AZURE_CHANGE_EVENT)));
    expect(invoke).toHaveBeenCalledTimes(count);
    await click("CI");
    expect(document.querySelector('[aria-label="Azure pipeline runs"]')).toBe(
      panel,
    );
    expect(panel.scrollTop).toBe(180);
    expect(document.body.textContent).toContain("expected 1, got 2");
    expect(document.body.textContent).toContain("Selected run 12");
  } finally {
    await cleanup();
  }
});

it("limits initial pipeline reads to two and skips queued reads after hiding", async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  let active = 0,
    peak = 0,
    calls = 0;
  const releases: (() => void)[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "azure_ci_lookup") return original(command, args);
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return {
      target: (args as { input: { target: unknown } }).input.target,
      projectName: "Project",
      definitionName: "Tests",
      items: [],
      continuation: null,
      checkedAt: Date.now(),
    };
  });
  const cleanup = await setup(
    Array.from({ length: 5 }, (_, index) => ({
      ...source,
      target: { ...source.target, definition: 7 + index },
    })),
  );
  try {
    await click("CI");
    expect(calls).toBe(2);
    expect(peak).toBe(2);
    await click("Files");
    await act(async () => {
      releases.splice(0).forEach((release) => release());
    });
    expect(calls).toBe(2);
  } finally {
    releases.splice(0).forEach((release) => release());
    await cleanup();
  }
});

it("opens details only for the first pipeline while loading every source status", async () => {
  const cleanup = await setup([
    source,
    { ...source, target: { ...target, definition: 9 } },
  ]);
  try {
    await click("CI");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "azure_ci_lookup"),
    ).toHaveLength(2);
    const reads = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "azure_ci_read");
    expect(
      reads.map(
        ([, args]) => (args as { input: { section: string } }).input.section,
      ),
    ).toEqual(["summary", "jobs"]);
  } finally {
    await cleanup();
  }
});
