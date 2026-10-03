// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mcpInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@tauri-apps/api/core")>();
  return {
    ...original,
    invoke: (command: string, args?: unknown) =>
      command === "mcp_discover" || command === "claude_mcp_list"
        ? mcpInvoke(command, args)
        : original.invoke(command, args),
  };
});

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({
    branches: {
      current: "mc/greeting",
      detached: false,
      branches: [
        { name: "mc/greeting", remote: null, current: true },
        { name: "main", remote: null, current: false },
      ],
    },
    settled: true,
  }),
}));

vi.mock("./ConfluencePicker", () => ({
  ConfluencePicker: () => createElement("div", { "data-confluence-picker": "" }),
}));
const jira = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../model/jira", async (original) => ({
  ...await original<typeof import("../model/jira")>(),
  jiraConnected: jira.status,
}));

import { Composer, ComposerAction } from "./Composer";
import { setHarnessModels, resetHarnessModelOverlays } from "../model/models";
import { useBrowserContextTargets, type BrowserContextTarget } from "../model/browserContext";
import { contextFromText } from "../model/agentContext";
import {
  clearMcpSettingsCache,
  loadMcpSettings,
} from "../../settings/model/mcpSettingsCache";
import type { ComposerTurnOptions, Attachment } from "../model/session";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraft,
} from "../model/draftCache";
import type { UserQuestionPrompt } from "../model/userQuestion";

function renderAction(
  busy: boolean,
  hasValue: boolean,
  allowBusySubmit = true,
) {
  return renderToStaticMarkup(
    createElement(ComposerAction, {
      busy,
      hasValue,
      allowBusySubmit,
      onSend: vi.fn(),
      onStop: vi.fn(),
    }),
  );
}

describe("ComposerAction", () => {
  it("replaces Stop with Send when typing during a running turn", () => {
    const empty = renderAction(true, false);
    expect(empty).toContain('aria-label="Stop"');
    expect(empty).not.toContain('aria-label="Send"');

    const typed = renderAction(true, true);
    expect(typed).toContain('aria-label="Send"');
    expect(typed).toContain("composer-send");
    expect(typed).toContain("primary-action");
    expect(typed).not.toContain('aria-label="Stop"');
  });

  it("keeps Stop while busy when submitting follow-up text is disabled", () => {
    const typed = renderAction(true, true, false);
    expect(typed).toContain('aria-label="Stop"');
    expect(typed).not.toContain('aria-label="Send"');
  });
});

describe("Composer question focus", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jira.status.mockReset().mockResolvedValue({ connected: true, site: "https://team.atlassian.net", accountId: "owner", capabilities: ["Jira", "Confluence"] });
    clearMcpSettingsCache();
    mcpInvoke.mockReset();
    mcpInvoke.mockImplementation(async (command: string) =>
      command === "mcp_discover"
        ? [
            {
              provider: "claude",
              name: "docs",
              scope: "project",
              configPath: "/repo/.mcp.json",
              transport: "stdio",
            },
            {
              provider: "cursor",
              name: "other",
              scope: "user",
              configPath: "/cursor/mcp.json",
              transport: "stdio",
            },
          ]
        : command === "claude_mcp_list"
          ? "docs: local - ✔ Connected"
          : undefined,
    );
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows the live catalog model name in the picker", async () => {
    const cwd = "/home/dev/project";
    const executionCwd = "/home/dev/worktree";
    const model = { id: "claude:scoped", nativeId: "scoped", harness: "claude" as const };
    setHarnessModels("claude", [{ ...model, name: "Worktree catalog model" }]);
    try {
      await act(async () => root.render(createElement(Composer, {
        cwd, executionCwd, focused: true, harness: "claude", model: model.id,
        runtimeMode: "supervised", hideProjectPicker: true, hideBranchPicker: true,
        onFocus: vi.fn(), onCwdChange: vi.fn(), onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(), onSubmit: vi.fn(), onStop: vi.fn(),
      })));
      expect(container.textContent).toContain("Worktree catalog model");
      
    } finally {
      act(() => resetHarnessModelOverlays());
    }
  });

  const question: UserQuestionPrompt = {
    requestId: 1,
    questions: [
      {
        id: "q1",
        prompt: "Pick one",
        multiSelect: false,
        allowCustom: false,
        options: [{ id: "a", label: "Option A" }],
      },
    ],
  };

  async function renderComposer(
    currentQuestion: UserQuestionPrompt | undefined,
    onQuestionReply: (requestId: number, reply: unknown) => void,
    busy = false,
    focusToken = 0,
    initialDraft?: string,
    onBtwCommand?: (
      text: string,
      options?: { draft?: boolean },
    ) => boolean | void,
    onSubmit: (text: string, attachments: Attachment[]) => void = () => {},
    sessionId?: string,
    harness: "claude" | "codex" = "claude",
  ) {
    await act(async () =>
      root.render(
        createElement(Composer, {
          key: sessionId,
          focused: true,
          focusToken,
          harness,
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          initialDraft,
          sessionId,
          onDraftChange: sessionId
            ? (text) => setComposerDraft(sessionId, text)
            : undefined,
          hideProjectPicker: true,
          hideBranchPicker: true,
          onFocus: () => {},
          onCwdChange: () => {},
          onModelChange: () => {},
          onRuntimeModeChange: () => {},
          onSubmit,
          onBtwCommand,
          question: currentQuestion,
          onQuestionReply,
          busy,
        }),
      ),
    );
  }


  it("adds reviewed browser context to the existing draft without submitting, and rejects stale destinations", async () => {
    let targets: readonly BrowserContextTarget[] = [];
    function Targets() { targets = useBrowserContextTargets(); return null; }
    const onSubmit = vi.fn();
    const onDraftChange = vi.fn();
    const props = {
      focused: true, harness: "claude" as const, model: "claude-sonnet",
      runtimeMode: "supervised" as const, executionCwd: "/repo", sessionId: "browser-target",
      shell: true,
      hideProjectPicker: true, hideBranchPicker: true, initialDraft: "Keep my draft",
      onFocus: vi.fn(), onCwdChange: vi.fn(), onModelChange: vi.fn(),
      onRuntimeModeChange: vi.fn(), onSubmit, onDraftChange,
    };
    const render = async (cwd: string, removed = false, enabled = true) => {
      await act(async () => root.render(createElement(Fragment, null,
        createElement(Composer, { ...props, executionCwd: cwd, worktreeRemoved: removed, enabled }), createElement(Targets))));
    };
    await render("/repo");
    onDraftChange.mockClear();
    const original = targets.find(target => target.sessionId === props.sessionId)!;
    const context = contextFromText("Captured page", "Page evidence", "Browser native host · https://example.test");
    await render("/repo", false, false);
    expect(targets).toContain(original); // Explicit browser selection may reveal an inactive open tab.
    act(() => original.accept(context));
    expect(container.querySelector("textarea")?.value).toContain("Keep my draft");
    expect(container.querySelector("textarea")?.value).toContain("Page evidence");
    expect(onDraftChange).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    await render("/home/dev/other-repo");
    expect(() => original.accept(context)).toThrow(/execution host changed/);
    const moved = targets.find(target => target.sessionId === props.sessionId)!;
    expect(moved.cwd).toBe("/home/dev/other-repo");
    await render(moved.cwd, true);
    expect(targets).toEqual([]);
    expect(() => moved.accept(context)).toThrow(/execution host changed/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects an over-capacity browser capture before changing the draft or attachments", async () => {
    let target: BrowserContextTarget | undefined;
    function Targets() { target = useBrowserContextTargets()[0]; return null; }
    const onDraftChange = vi.fn();
    await act(async () => root.render(createElement(Fragment, null,
      createElement(Composer, {
        focused: true, harness: "claude", model: "claude-sonnet", sessionId: "capacity-target",
        runtimeMode: "supervised", executionCwd: "/repo", initialDraft: "Unchanged",
        hideProjectPicker: true, hideBranchPicker: true, onFocus: vi.fn(), onCwdChange: vi.fn(),
        onModelChange: vi.fn(), onRuntimeModeChange: vi.fn(), onSubmit: vi.fn(), onDraftChange,
      }), createElement(Targets))));
    onDraftChange.mockClear();
    const context = contextFromText("Captured page", "Too large", "Browser");
    context.attachments = [{ id: "image", kind: "image", name: "capture.png", mime: "image/png", size: 21 * 1024 * 1024, data: "" }];
    expect(() => target!.accept(context)).toThrow(/too many attachments/);
    expect(container.querySelector("textarea")?.value).toBe("Unchanged");
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("capture.png");
  });

  it("closes Confluence selection when the conversation or execution host changes", async () => {
    const props = {
      focused: true, harness: "claude" as const, model: "claude-sonnet",
      runtimeMode: "supervised" as const, executionCwd: "/repo", sessionId: "first",
      hideProjectPicker: true, hideBranchPicker: true, initialDraft: "Keep my draft",
      onFocus: vi.fn(), onCwdChange: vi.fn(), onModelChange: vi.fn(),
      onRuntimeModeChange: vi.fn(), onSubmit: vi.fn(),
    };
    for (const change of [{ sessionId: "second" }, { executionCwd: "/home/dev/other-repo" }, { enabled: false }, { worktreeRemoved: true }]) {
      await act(async () => root.render(createElement(Composer, props)));
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Add files or choose a mode"]')!.click());
      act(() => document.querySelector<HTMLButtonElement>('[aria-label="Add Confluence pages"]')!.click());
      expect(document.querySelector("[data-composer-plus]")).toBeNull();
      expect(container.querySelector("[data-confluence-picker]")).not.toBeNull();
      await act(async () => root.render(createElement(Composer, { ...props, ...change })));
      expect(container.querySelector("[data-confluence-picker]")).toBeNull();
      expect(container.querySelector("textarea")!.value).toBe("Keep my draft");
    }
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it.each(["Actions", "Add Confluence pages", "Dictation settings"])("opens %s before the first agent message", async (label) => {
    const onSubmit = vi.fn();
    await act(async () => root.render(createElement(Composer, {
      shell: true, enabled: true, focused: true, sessionId: "empty-session",
      harness: "claude", model: "claude-sonnet", runtimeMode: "supervised",
      executionCwd: "/repo", initialDraft: "First message draft",
      hideProjectPicker: true, hideBranchPicker: true,
      onFocus: vi.fn(), onCwdChange: vi.fn(), onModelChange: vi.fn(),
      onRuntimeModeChange: vi.fn(), onSubmit,
    })));
    if (label === "Add Confluence pages") act(() => container.querySelector<HTMLButtonElement>('[aria-label="Add files or choose a mode"]')!.click());
    const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    expect(button.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[aria-label^="Dictate ("]')!.disabled).toBe(false);
    await act(async () => button.click());
    if (label === "Actions") expect(document.body.textContent).toContain("Choose a prompt to review it.");
    if (label === "Add Confluence pages") expect(container.querySelector("[data-confluence-picker]")).not.toBeNull();
    if (label === "Dictation settings") expect(document.querySelector('[data-dictation-menu]')).not.toBeNull();
    expect(container.querySelector("textarea")!.value).toBe("First message draft");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows Confluence only for the current connected account and closes it on disconnect", async () => {
    jira.status.mockResolvedValue({ connected: false, capabilities: [] });
    await renderComposer(undefined, vi.fn());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Add files or choose a mode"]')!.click());
    const button = () => document.querySelector<HTMLButtonElement>('[aria-label="Add Confluence pages"]');
    expect(button()).toBeNull();
    jira.status.mockResolvedValue({ connected: true, accountId: "owner", capabilities: ["Jira", "Confluence"] });
    await act(async () => window.dispatchEvent(new Event("monocode:jira-change")));
    expect(button()!.closest("[data-composer-plus]")).not.toBeNull();
    act(() => button()!.click());
    expect(document.querySelector("[data-composer-plus]")).toBeNull();
    expect(container.querySelector("[data-confluence-picker]")).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Add files or choose a mode"]')!.click());
    let stale!: (value: unknown) => void;
    jira.status.mockImplementationOnce(() => new Promise(resolve => { stale = resolve; }));
    await act(async () => window.dispatchEvent(new Event("focus")));
    jira.status.mockResolvedValue({ connected: false, capabilities: [] });
    await act(async () => window.dispatchEvent(new Event("monocode:jira-change")));
    expect(button()).toBeNull();
    expect(container.querySelector("[data-confluence-picker]")).toBeNull();
    await act(async () => stale({ connected: true, accountId: "old", capabilities: ["Confluence"] }));
    expect(button()).toBeNull();
    jira.status.mockResolvedValue({ connected: true, accountId: "owner", capabilities: ["Jira"] });
    await act(async () => window.dispatchEvent(new Event("monocode:jira-change")));
    expect(button()).toBeNull();
  });

  it("adds a saved prompt to the existing draft without submitting and clears picker ownership", async () => {
    localStorage.removeItem("monocode.savedPrompts.v1");
    localStorage.removeItem("monocode.agentActions.v1");
    const props = {
      focused: true, harness: "claude" as const, model: "claude-sonnet",
      runtimeMode: "supervised" as const, executionCwd: "/repo", sessionId: "prompt-session",
      shell: true,
      hideProjectPicker: true, hideBranchPicker: true, initialDraft: "Keep my draft",
      onFocus: vi.fn(), onCwdChange: vi.fn(), onModelChange: vi.fn(),
      onRuntimeModeChange: vi.fn(), onSubmit: vi.fn(), onDraftChange: vi.fn(),
    };
    await act(async () => root.render(createElement(Composer, props)));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Actions"]')!.click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "ImplementAll working copies")!.click());
    props.onDraftChange.mockClear();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Add to draft")!.click());
    expect(container.querySelector("textarea")!.value).toContain("Keep my draft");
    expect(container.querySelector("textarea")!.value).toContain("Implement the work described in this conversation");
    expect(props.onDraftChange).toHaveBeenCalledOnce();
    for (const change of [{ sessionId: "other" }, { executionCwd: "/home/dev/other-repo" }, { harness: "codex" as const }, { enabled: false }, { worktreeRemoved: true }]) {
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Actions"]')!.click());
      expect(document.querySelector('[aria-label="Prompt name"]')).toBeNull();
      expect(document.body.textContent).toContain("Choose a prompt to review it.");
      await act(async () => root.render(createElement(Composer, { ...props, ...change })));
      expect(document.body.textContent).not.toContain("Choose a prompt to review it.");
      await act(async () => root.render(createElement(Composer, props)));
      expect(document.body.textContent).not.toContain("Choose a prompt to review it.");
    }
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ["/btw", ""],
    ["/btw some text here...", "some text here..."],
  ])("routes %s to BTW instead of the main submit", async (draft, text) => {
    const onBtwCommand = vi.fn(() => true);
    const onSubmit = vi.fn();
    await renderComposer(
      undefined,
      vi.fn(),
      false,
      0,
      draft,
      onBtwCommand,
      onSubmit,
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onBtwCommand).toHaveBeenCalledWith(text);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  async function typeInto(textarea: HTMLTextAreaElement, value: string) {
    await act(async () => {
      textarea.value = value;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("opens BTW as soon as `/btw ` is typed and hands over the rest", async () => {
    const onBtwCommand = vi.fn(() => true);
    await renderComposer(undefined, vi.fn(), false, 0, undefined, onBtwCommand);
    const textarea = container.querySelector("textarea")!;
    await typeInto(textarea, "/btw");
    expect(onBtwCommand).not.toHaveBeenCalled();

    await typeInto(textarea, "/btw why");
    expect(onBtwCommand).toHaveBeenCalledWith("why", { draft: true });
    expect(textarea.value).toBe("");
  });

  it("leaves a typed `/btw ` alone when BTW is unavailable", async () => {
    const onBtwCommand = vi.fn(() => false);
    await renderComposer(undefined, vi.fn(), false, 0, undefined, onBtwCommand);
    const textarea = container.querySelector("textarea")!;
    await typeInto(textarea, "/btw ");
    expect(textarea.value).toBe("/btw ");
  });

  it("opens a searchable MCP picker and sends selected context", async () => {
    const onSubmit = vi.fn();
    const onOpen = vi.fn();
    window.addEventListener("monocode:open-mcp-settings", onOpen);
    try {
      await renderComposer(
        undefined,
        vi.fn(),
        false,
        0,
        "/mcp",
        undefined,
        onSubmit,
      );
      const textarea = container.querySelector("textarea")!;
      await act(async () =>
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(container.querySelector("[data-mcp-picker]")).not.toBeNull();
      expect(container.textContent).toContain("docs");
      expect(container.textContent).toContain("other");
      const unavailable = [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[data-mcp-picker] [role="option"]',
        ),
      ].find((button) => button.textContent?.includes("other"))!;
      expect(unavailable.disabled).toBe(true);
      const search = container.querySelector<HTMLInputElement>(
        '[aria-label="Search MCP servers"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(search, "docs");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(
        container.querySelector("[data-mcp-picker]")?.textContent,
      ).not.toContain("other");
      const available = [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[data-mcp-picker] [role="option"]',
        ),
      ].find((button) => button.textContent?.includes("docs"))!;
      await act(async () => available.click());
      expect(textarea.value).toBe("@mcp/docs ");
      expect(
        container.querySelector('[data-mcp-tag="@mcp/docs"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Selected MCP context"]'),
      ).toBeNull();
      await typeInto(textarea, `${textarea.value}Find the docs`);
      await act(async () =>
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(onSubmit).toHaveBeenCalledWith(
        expect.stringContaining('"docs" (claude)'),
        expect.any(Array),
        expect.any(Object),
      );
      expect(container.querySelector('[data-mcp-tag="@mcp/docs"]')).toBeNull();
      expect(onOpen).not.toHaveBeenCalled();
      expect(textarea.value).toBe("");
    } finally {
      window.removeEventListener("monocode:open-mcp-settings", onOpen);
    }
  });

  it("reuses MCP discovery on reopen and applies shared settings refreshes", async () => {
    await renderComposer(undefined, vi.fn(), false, 0, "/mcp");
    const textarea = container.querySelector("textarea")!;
    const enter = () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    await act(async () => enter());
    expect(mcpInvoke).toHaveBeenCalledTimes(2);
    await act(async () =>
      container
        .querySelector('[aria-label="Search MCP servers"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    );
    await typeInto(textarea, "/mcp");
    await act(async () => enter());
    expect(container.querySelector("[data-mcp-picker]")).not.toBeNull();
    expect(mcpInvoke).toHaveBeenCalledTimes(2);

    mcpInvoke.mockImplementation(async (command: string) =>
      command === "mcp_discover"
        ? [
            {
              provider: "claude",
              name: "docs",
              scope: "project",
              configPath: "/repo/.mcp.json",
              transport: "stdio",
              enabled: false,
            },
          ]
        : "docs: local - Connected",
    );
    await act(async () => {
      await loadMcpSettings("/repo", true);
    });
    const docs = container.querySelector<HTMLButtonElement>(
      '[data-mcp-picker] [role="option"]',
    )!;
    expect(docs.disabled).toBe(true);
    expect(docs.textContent).toContain("Disabled in provider configuration");
    expect(mcpInvoke).toHaveBeenCalledTimes(4);
  });

  it("shows four MCP rows at a time and dismisses on outside click or Escape", async () => {
    mcpInvoke.mockImplementation(async (command: string) =>
      command === "mcp_discover"
        ? Array.from({ length: 6 }, (_, index) => ({
            provider: "claude",
            name: `server-${index}`,
            scope: "project",
            configPath: "/repo/.mcp.json",
            transport: "stdio",
          }))
        : "",
    );
    await renderComposer(undefined, vi.fn(), false, 0, "/mcp");
    const textarea = container.querySelector("textarea")!;
    const openPicker = async () => {
      await act(async () =>
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
    };
    await openPicker();

    const list = container.querySelector<HTMLElement>(
      '[data-mcp-picker] [role="listbox"]',
    )!;
    expect(list.querySelectorAll('[role="option"]')).toHaveLength(6);
    expect(list.classList.contains("max-h-[min(184px,45vh)]")).toBe(true);
    expect(
      list.querySelector('[role="option"]')?.classList.contains("h-11"),
    ).toBe(true);
    expect(container.querySelector("[data-mcp-picker]")?.className).toContain(
      "bg-content/5",
    );
    const searchInput = container.querySelector<HTMLInputElement>(
      '[aria-label="Search MCP servers"]',
    )!;
    const options = list.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(searchInput.getAttribute("aria-controls")).toBe(list.id);
    await act(async () => options[1].focus());
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(searchInput.getAttribute("aria-activedescendant")).toBe(
      options[1].id,
    );
    await act(async () => {
      searchInput.focus();
      for (const key of ["ArrowDown", "Enter", "Escape"]) {
        searchInput.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            isComposing: true,
          }),
        );
      }
    });
    expect(container.querySelector("[data-mcp-picker]")).not.toBeNull();
    expect(container.textContent).not.toContain("MCP: server-");

    const outside = document.createElement("button");
    document.body.append(outside);
    await act(async () => {
      outside.focus();
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(container.querySelector("[data-mcp-picker]")).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();

    await typeInto(textarea, "/mcp");
    await openPicker();
    const search = container.querySelector<HTMLInputElement>(
      '[aria-label="Search MCP servers"]',
    )!;
    await act(async () =>
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(container.querySelector("[data-mcp-picker]")).toBeNull();
    expect(document.activeElement).toBe(textarea);

    await typeInto(textarea, "/mcp");
    await openPicker();
    const close = container.querySelector<HTMLButtonElement>(
      '[aria-label="Close MCP picker"]',
    )!;
    expect(close.title).toContain("Esc");
    await act(async () => close.click());
    expect(container.querySelector("[data-mcp-picker]")).toBeNull();
  });

  it("removes MCP context when its inline tag is deleted", async () => {
    const onSubmit = vi.fn();
    await renderComposer(
      undefined,
      vi.fn(),
      false,
      0,
      "/mcp",
      undefined,
      onSubmit,
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const docs = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-mcp-picker] [role="option"]',
      ),
    ].find((button) => button.textContent?.includes("docs"))!;
    await act(async () => docs.click());
    expect(textarea.value).toContain("@mcp/docs");
    await typeInto(textarea, "Find the docs");
    expect(container.querySelector("[data-mcp-tag]")).toBeNull();
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onSubmit).toHaveBeenCalledWith(
      "Find the docs",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("inserts an MCP tag beside existing composer text", async () => {
    await renderComposer(undefined, vi.fn());
    const textarea = container.querySelector("textarea")!;
    await typeInto(textarea, "sad /mcp");
    const command = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-skill-picker] [role="option"]',
      ),
    ].find((button) => button.textContent?.includes("/mcp"))!;
    expect(command).toBeDefined();
    await act(async () => command.click());
    const docs = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-mcp-picker] [role="option"]',
      ),
    ].find((button) => button.textContent?.includes("docs"))!;
    await act(async () => docs.click());
    expect(textarea.value).toBe("sad @mcp/docs ");
    expect(
      container.querySelector('[data-mcp-tag="@mcp/docs"]'),
    ).not.toBeNull();
  });

  it("restores a Codex MCP tag and its context after switching sessions", async () => {
    mcpInvoke.mockImplementation(async (command: string) =>
      command === "mcp_discover"
        ? [
            {
              provider: "codex",
              name: "docs",
              scope: "user",
              configPath: "/codex/config.toml",
              transport: "stdio",
            },
          ]
        : "",
    );
    const onSubmit = vi.fn();
    try {
      await renderComposer(
        undefined,
        vi.fn(),
        false,
        0,
        "/mcp",
        undefined,
        onSubmit,
        "mcp-session-one",
        "codex",
      );
      let textarea = container.querySelector("textarea")!;
      await act(async () =>
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      const docs = container.querySelector<HTMLButtonElement>(
        '[data-mcp-picker] [role="option"]',
      )!;
      expect(mcpInvoke).not.toHaveBeenCalledWith(
        "claude_mcp_list",
        expect.anything(),
      );
      await act(async () => docs.click());
      expect(textarea.value).toContain("@mcp/docs");
      expect(container.querySelector("[data-mcp-tag] svg")).toBeNull();

      await renderComposer(
        undefined,
        vi.fn(),
        false,
        0,
        "Other draft",
        undefined,
        onSubmit,
        "mcp-session-two",
        "codex",
      );
      expect(container.querySelector("[data-mcp-tag]")).toBeNull();

      await renderComposer(
        undefined,
        vi.fn(),
        false,
        0,
        getComposerDraft("mcp-session-one"),
        undefined,
        onSubmit,
        "mcp-session-one",
        "codex",
      );
      textarea = container.querySelector("textarea")!;
      expect(textarea.value).toContain("@mcp/docs");
      expect(
        container.querySelector('[data-mcp-tag="@mcp/docs"]'),
      ).not.toBeNull();
      await typeInto(textarea, `${textarea.value}Use docs`);
      await act(async () =>
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(onSubmit).toHaveBeenCalledWith(
        expect.stringContaining('"docs" (codex)'),
        expect.any(Array),
        expect.any(Object),
      );
    } finally {
      clearComposerDraft("mcp-session-one");
      clearComposerDraft("mcp-session-two");
    }
  });

  it("keeps the draft when onBtwCommand rejects the command", async () => {
    const onBtwCommand = vi.fn(() => false);
    const onSubmit = vi.fn();
    await renderComposer(
      undefined,
      vi.fn(),
      false,
      0,
      "/btw",
      onBtwCommand,
      onSubmit,
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onBtwCommand).toHaveBeenCalledWith("");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/btw");
  });

  it("clears the draft when the reset token advances", async () => {
    const onDraftChange = vi.fn();
    const props = {
      focused: true,
      harness: "claude" as const,
      model: "claude-sonnet",
      runtimeMode: "supervised" as const,
      executionCwd: "/repo",
      hideProjectPicker: true,
      hideBranchPicker: true,
      initialDraft: "something here...",
      draftResetToken: 1,
      onDraftChange,
      onFocus: vi.fn(),
      onCwdChange: vi.fn(),
      onModelChange: vi.fn(),
      onRuntimeModeChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    await act(async () => root.render(createElement(Composer, props)));
    expect(container.querySelector("textarea")?.value).toBe(
      "something here...",
    );

    await act(async () =>
      root.render(createElement(Composer, { ...props, draftResetToken: 2 })),
    );
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("keeps drafts and blocks sending until a working copy is selected", async () => {
    const onSubmit = vi.fn();
    const props = {
      harness: "claude" as const,
      model: "claude-sonnet",
      runtimeMode: "supervised" as const,
      executionCwd: "/deleted-worktree",
      hideProjectPicker: true,
      hideBranchPicker: true,
      initialDraft: "Continue this feature",
      onFocus: vi.fn(),
      onCwdChange: vi.fn(),
      onModelChange: vi.fn(),
      onRuntimeModeChange: vi.fn(),
      onSubmit,
    };
    await act(async () =>
      root.render(createElement(Composer, { ...props, worktreeRemoved: true })),
    );
    const textarea = container.querySelector("textarea")!;
    const send = container.querySelector<HTMLButtonElement>(
      '[aria-label="Send"]',
    )!;
    expect(send.disabled).toBe(true);
    expect(textarea.placeholder).toContain("Select a branch or worktree");
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Continue this feature");
    await act(async () =>
      root.render(
        createElement(Composer, { ...props, worktreeRemoved: false }),
      ),
    );
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(onSubmit).toHaveBeenCalledWith("Continue this feature", [], {
      intent: "default",
    });
  });

  it("places the caret at the end of an initial draft", async () => {
    const initialDraft = "Comment on src/App.tsx:42\n\n";
    await renderComposer(undefined, vi.fn(), false, 0, initialDraft);

    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe(initialDraft);
    expect(textarea.selectionStart).toBe(initialDraft.length);
    expect(textarea.selectionEnd).toBe(initialDraft.length);
  });

  it("offers /operator in the slash picker and submits it as a local command", async () => {
    const onSubmit = vi.fn(() => true);
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          initialDraft: "/operator",
          hideProjectPicker: true,
          hideBranchPicker: true,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
        }),
      ),
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () =>
      textarea.dispatchEvent(new Event("input", { bubbles: true })),
    );
    const command = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) => button.textContent?.includes("/operator"));
    expect(command).toBeDefined();
    await act(async () => command!.click());
    expect(textarea.value).toBe("/operator ");
    expect(
      container.querySelector('[aria-label="Turn off Operator"]'),
    ).not.toBeNull();
    await act(async () => {
      textarea.value += "list my notes";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );
    expect(onSubmit).toHaveBeenCalledWith("/operator list my notes", [], {
      intent: "default",
    });
  });

  it("keeps /plan in the text beside its pill and submits with the plan intent", async () => {
    const onSubmit = vi.fn(() => true);
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          initialDraft: "/pla",
          hideProjectPicker: true,
          hideBranchPicker: true,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
        }),
      ),
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () =>
      textarea.dispatchEvent(new Event("input", { bubbles: true })),
    );
    const command = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) => button.textContent?.includes("/plan"));
    await act(async () => command!.click());
    expect(textarea.value).toBe("/plan ");
    expect(
      container.querySelector('[aria-label="Turn off Plan mode"]'),
    ).not.toBeNull();
    await act(async () => {
      textarea.value += "sketch the refactor";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );
    expect(onSubmit).toHaveBeenLastCalledWith("sketch the refactor", [], {
      intent: "plan",
    });
  });

  it("keeps a picked /plan in the text beside its pill and submits with the plan intent", async () => {
    const onSubmit = vi.fn(() => true);
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          initialDraft: "/pla",
          hideProjectPicker: true,
          hideBranchPicker: true,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
        }),
      ),
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () =>
      textarea.dispatchEvent(new Event("input", { bubbles: true })),
    );
    const command = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) => button.textContent?.includes("/plan"));
    expect(command).toBeDefined();
    await act(async () => command!.click());
    expect(textarea.value).toBe("/plan ");
    expect(
      container.querySelector('[aria-label="Turn off Plan mode"]'),
    ).not.toBeNull();
    await act(async () => {
      textarea.value += "sketch the refactor";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );
    expect(onSubmit).toHaveBeenLastCalledWith("sketch the refactor", [], {
      intent: "plan",
    });
  });

  it("offers /orchestrator in the slash picker and submits with the orchestrate intent", async () => {
    const onSubmit = vi.fn(() => true);
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          initialDraft: "/orch",
          hideProjectPicker: true,
          hideBranchPicker: true,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
        }),
      ),
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () =>
      textarea.dispatchEvent(new Event("input", { bubbles: true })),
    );
    const command = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) => button.textContent?.includes("/orchestrator"));
    expect(command).toBeDefined();
    await act(async () => command!.click());
    expect(textarea.value).toBe("/orchestrator ");
    expect(
      container.querySelector('[aria-label="Turn off Orchestrator mode"]'),
    ).not.toBeNull();
    await act(async () => {
      textarea.value += "ship the release";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = container.querySelector<HTMLButtonElement>(
      '[aria-label="Send"]',
    )!;
    await act(async () => send.click());
    expect(onSubmit).toHaveBeenLastCalledWith("ship the release", [], {
      intent: "orchestrate",
    });

    await act(async () => {
      textarea.value = "/orchestrator fix the build";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => send.click());
    expect(onSubmit).toHaveBeenLastCalledWith("fix the build", [], {
      intent: "orchestrate",
    });
  });

  it("offers Operator above Orchestrator and sends the /operator command", async () => {
    const onSubmit = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          initialDraft: "List my notes",
          hideProjectPicker: true,
          hideBranchPicker: true,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
        }),
      ),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Add files or choose a mode"]',
        )!
        .click(),
    );
    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-composer-plus] button",
      ),
    );
    const operator = options.find((button) =>
      button.textContent?.includes("Operator"),
    )!;
    expect(operator).toBeDefined();
    expect(options.indexOf(operator)).toBeLessThan(
      options.findIndex((button) =>
        button.textContent?.includes("Orchestrator"),
      ),
    );
    await act(async () => operator.click());
    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("List my notes");
    expect(
      container.querySelector('[aria-label="Turn off Operator"]'),
    ).not.toBeNull();

    const send = container.querySelector<HTMLButtonElement>(
      '[aria-label="Send"]',
    )!;
    await act(async () => send.click());
    expect(onSubmit).toHaveBeenLastCalledWith("/operator List my notes", [], {
      intent: "default",
    });
    expect(textarea.value).toBe("List my notes");
    expect(
      container.querySelector('[aria-label="Turn off Operator"]'),
    ).not.toBeNull();

    await act(async () => {
      textarea.value = "/operator List my notes";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith("/operator List my notes", [], {
      intent: "default",
    });
    expect(textarea.value).toBe("");
    expect(
      container.querySelector('[aria-label="Turn off Operator"]'),
    ).toBeNull();
  });

  it("clears the parent draft before submit so a remounting composer stays empty", async () => {
    let parentDraft = "Ship the empty-state fix";
    const onDraftChange = vi.fn((text: string) => {
      parentDraft = text;
    });
    const baseProps = {
      focused: true,
      harness: "claude" as const,
      model: "claude-sonnet",
      runtimeMode: "supervised" as const,
      executionCwd: "/repo",
      hideProjectPicker: true,
      hideBranchPicker: true,
      initialDraft: parentDraft,
      onDraftChange,
      onFocus: vi.fn(),
      onCwdChange: vi.fn(),
      onModelChange: vi.fn(),
      onRuntimeModeChange: vi.fn(),
    };
    const onSubmit = vi.fn(() => {
      act(() =>
        root.render(
          createElement(Composer, {
            ...baseProps,
            key: "docked",
            initialDraft: parentDraft,
            onSubmit,
          }),
        ),
      );
      return true;
    });
    await act(async () =>
      root.render(
        createElement(Composer, { ...baseProps, key: "empty", onSubmit }),
      ),
    );

    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("Ship the empty-state fix");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );

    expect(onSubmit).toHaveBeenCalledWith("Ship the empty-state fix", [], {
      intent: "default",
    });
    expect(onDraftChange).toHaveBeenCalledWith("");
    expect(parentDraft).toBe("");
    expect(textarea.value).toBe("");
  });

  it("restores the draft when submit is rejected", async () => {
    let parentDraft = "Blocked while orchestration is paused";
    const onDraftChange = vi.fn((text: string) => {
      parentDraft = text;
    });
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          hideProjectPicker: true,
          hideBranchPicker: true,
          initialDraft: parentDraft,
          onDraftChange,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit: () => false,
        }),
      ),
    );

    const textarea = container.querySelector("textarea")!;
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );

    expect(textarea.value).toBe("Blocked while orchestration is paused");
    expect(parentDraft).toBe("Blocked while orchestration is paused");
  });

  it("does not restore a failed resend over newer composer text", async () => {
    let recallLastTurn: (() => void) | undefined;
    let rejectResend: ComposerTurnOptions["onResendRejected"];
    const onSubmit = vi.fn(
      (_text: string, _files: Attachment[], options?: ComposerTurnOptions) => {
        rejectResend = options?.onResendRejected;
        return true;
      },
    );

    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "pi",
          model: "pi:default",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          hideProjectPicker: true,
          hideBranchPicker: true,
          editLastTurnSupported: true,
          lastTurnRecall: { text: "Original prompt", attachments: [] },
          onRecallLastTurnReady: (recall) => {
            recallLastTurn = recall;
          },
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
        }),
      ),
    );

    await act(async () => recallLastTurn?.());
    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("Original prompt");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );
    await act(async () => {
      textarea.value = "New prompt";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => rejectResend?.({ providerRewound: false }));

    expect(textarea.value).toBe("New prompt");
  });

  it("retries an already rewound prompt as a normal submission", async () => {
    let recallLastTurn: (() => void) | undefined;
    let rejectResend: ComposerTurnOptions["onResendRejected"];
    const onSubmit = vi.fn(
      (_text: string, _files: Attachment[], options?: ComposerTurnOptions) => {
        rejectResend = options?.onResendRejected;
        return true;
      },
    );

    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "pi",
          model: "pi:default",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          hideProjectPicker: true,
          hideBranchPicker: true,
          editLastTurnSupported: true,
          lastTurnRecall: { text: "Edited prompt", attachments: [] },
          onRecallLastTurnReady: (recall) => {
            recallLastTurn = recall;
          },
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
        }),
      ),
    );

    await act(async () => recallLastTurn?.());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );
    await act(async () => rejectResend?.({ providerRewound: true }));

    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("Edited prompt");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1][2]).toEqual({ intent: "default" });
  });

  it("preserves attachment ownership when a resend is restored", async () => {
    const createObjectURL = vi.fn(() => "blob:owned");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    let recallLastTurn: (() => void) | undefined;
    let rejectResend: ComposerTurnOptions["onResendRejected"];
    const borrowed: Attachment = {
      id: "borrowed",
      name: "borrowed.png",
      mimeType: "image/png",
      kind: "image",
      size: 3,
      previewUrl: "blob:borrowed",
    };
    const onSubmit = vi.fn(
      (_text: string, _files: Attachment[], options?: ComposerTurnOptions) => {
        rejectResend = options?.onResendRejected;
        return true;
      },
    );

    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "pi",
          model: "pi:default",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          hideProjectPicker: true,
          hideBranchPicker: true,
          editLastTurnSupported: true,
          lastTurnRecall: {
            text: "Edited prompt",
            attachments: [borrowed],
          },
          onRecallLastTurnReady: (recall) => {
            recallLastTurn = recall;
          },
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
        }),
      ),
    );

    await act(async () => recallLastTurn?.());
    const owned = new File(["new"], "owned.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        getData: () => "",
        files: [owned],
        items: [
          {
            kind: "file",
            type: owned.type,
            getAsFile: () => owned,
          },
        ],
      },
    });
    await act(async () => {
      container.querySelector("textarea")!.dispatchEvent(paste);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Send"]')!
        .click(),
    );
    await act(async () => rejectResend?.({ providerRewound: false }));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove owned.png"]')!
        .click(),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove borrowed.png"]')!
        .click(),
    );

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:owned");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:borrowed");
  });

  it("saves a new message as a draft without submitting it", async () => {
    const onSubmit = vi.fn();
    const onSaveDraft = vi.fn();
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          hideProjectPicker: true,
          hideBranchPicker: true,
          canSaveDraft: true,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
          onSaveDraft,
        }),
      ),
    );

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Add files or choose a mode"]',
        )!
        .click(),
    );
    const draftMode = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("Save this message"));
    expect(draftMode).toBeDefined();
    await act(async () => draftMode!.click());

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      textarea.value = "Explore a quieter empty state";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = container.querySelector<HTMLButtonElement>(
      '[aria-label="Save draft"]',
    );
    expect(save?.disabled).toBe(false);
    await act(async () => save!.click());

    expect(onSaveDraft).toHaveBeenCalledWith(
      "Explore a quieter empty state",
      [],
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("saves a /draft message as a draft and keeps the command in the text", async () => {
    const onSubmit = vi.fn();
    const onSaveDraft = vi.fn();
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          initialDraft: "/dra",
          hideProjectPicker: true,
          hideBranchPicker: true,
          canSaveDraft: true,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit,
          onSaveDraft,
        }),
      ),
    );
    const textarea = container.querySelector("textarea")!;
    await act(async () =>
      textarea.dispatchEvent(new Event("input", { bubbles: true })),
    );
    const command = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((button) => button.textContent?.includes("/draft"));
    expect(command).toBeDefined();
    await act(async () => command!.click());
    expect(textarea.value).toBe("/draft ");
    expect(
      container.querySelector('[title="Turn off Draft mode"]'),
    ).not.toBeNull();
    await act(async () => {
      textarea.value += "Explore a quieter empty state";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = container.querySelector<HTMLButtonElement>(
      '[aria-label="Save draft"]',
    );
    expect(save).not.toBeNull();
    await act(async () => save!.click());

    expect(onSaveDraft).toHaveBeenCalledWith(
      "Explore a quieter empty state",
      [],
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("locks a started session to its worktree while keeping its branch editable", async () => {
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          cwd: "/repo",
          executionCwd: "/repo-worktrees/mc-greeting",
          hideProjectPicker: true,
          onFocus: vi.fn(),
          onCwdChange: vi.fn(),
          onWorktreeChange: vi.fn(async () => {}),
          onModelChange: vi.fn(),
          onRuntimeModeChange: vi.fn(),
          onSubmit: vi.fn(),
        }),
      ),
    );

    const workspace = container.querySelector(
      '[aria-label="Workspace Worktree · /repo-worktrees/mc-greeting"]',
    );
    expect(workspace?.tagName).toBe("DIV");
    expect(
      container.querySelector('[aria-label="Choose working copy"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Branch mc/greeting"]'),
    ).not.toBeNull();
  });

  it("toggles a draft between the current checkout and a new worktree", async () => {
    const onWorkspaceModeChange = vi.fn();
    const onWorktreeBaseChange = vi.fn();
    const props = {
      focused: true,
      harness: "claude" as const,
      model: "claude-sonnet",
      runtimeMode: "supervised" as const,
      cwd: "/repo",
      executionCwd: "/repo",
      branch: "main",
      hideProjectPicker: true,
      draftWorkspace: true,
      onFocus: vi.fn(),
      onCwdChange: vi.fn(),
      onBranchChange: vi.fn(async () => {}),
      onWorktreeChange: vi.fn(async () => {}),
      onWorkspaceModeChange,
      onWorktreeBaseChange,
      onModelChange: vi.fn(),
      onRuntimeModeChange: vi.fn(),
      onSubmit: vi.fn(),
    };
    await act(async () =>
      root.render(
        createElement(Composer, { ...props, workspaceMode: "current" }),
      ),
    );
    const textarea = container.querySelector("textarea")!;
    const workspace = container.querySelector<HTMLButtonElement>(
      '[aria-label="Workspace Current checkout"]',
    )!;
    expect(
      container.querySelector('[aria-label="Branch main"]'),
    ).not.toBeNull();
    await act(async () => workspace.click());
    expect(document.body.textContent).toContain("Existing worktree…");
    expect(
      container.querySelector('[aria-label="Branch main"]'),
    ).not.toBeNull();
    await act(async () => workspace.click());

    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "g",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onWorkspaceModeChange).toHaveBeenLastCalledWith("worktree", "main");

    await act(async () =>
      root.render(
        createElement(Composer, { ...props, workspaceMode: "worktree" }),
      ),
    );
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "G",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onWorkspaceModeChange).toHaveBeenLastCalledWith(
      "current",
      undefined,
    );

    await act(async () =>
      root.render(
        createElement(Composer, {
          ...props,
          branch: undefined,
          workspaceMode: "current",
        }),
      ),
    );
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "g",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onWorkspaceModeChange).toHaveBeenLastCalledWith(
      "worktree",
      "mc/greeting",
    );

    await act(async () =>
      root.render(
        createElement(Composer, {
          ...props,
          branch: undefined,
          workspaceMode: "worktree",
          worktreeBase: "HEAD",
        }),
      ),
    );
    expect(onWorktreeBaseChange).toHaveBeenLastCalledWith("mc/greeting");
  });

  it("returns focus to the composer textarea once a question is answered", async () => {
    const onQuestionReply = vi.fn();
    await renderComposer(question, onQuestionReply);

    await act(async () =>
      (
        container.querySelector("button[aria-pressed]") as HTMLButtonElement
      ).click(),
    );
    await act(async () =>
      (
        container.querySelector('button[type="submit"]') as HTMLButtonElement
      ).click(),
    );
    expect(onQuestionReply).toHaveBeenCalledWith(1, {
      kind: "answered",
      answers: { q1: ["a"] },
    });

    // The real app clears `question` once onQuestionReply resolves it.
    await renderComposer(undefined, onQuestionReply);

    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });

  it("returns focus to the composer textarea once the agent turn finishes", async () => {
    await renderComposer(undefined, vi.fn(), true);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    const decoy = document.createElement("input");
    document.body.append(decoy);
    decoy.focus();
    expect(document.activeElement).toBe(decoy);

    await renderComposer(undefined, vi.fn(), false);

    expect(document.activeElement).toBe(textarea);
    decoy.remove();
  });

  it("returns focus to the composer textarea when focusToken bumps while already focused", async () => {
    await renderComposer(undefined, vi.fn());
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;

    const decoy = document.createElement("input");
    document.body.append(decoy);
    decoy.focus();
    expect(document.activeElement).toBe(decoy);

    // `focused` never changes value here (stays true throughout) — mirrors a
    // real window blur/refocus, where React's composerFocused state doesn't
    // change even though the OS took DOM focus away and back.
    await renderComposer(undefined, vi.fn(), false, 1);

    expect(document.activeElement).toBe(textarea);
    decoy.remove();
  });

  it("does not steal focus from a control inside a different composer", async () => {
    await renderComposer(undefined, vi.fn(), true);

    // Simulates focus reaching another mounted Composer's control via
    // keyboard Tab navigation, which never fires the onMouseDown-based
    // onFocus that would normally update which pane is "focused".
    const otherComposer = document.createElement("div");
    otherComposer.setAttribute("data-composer", "");
    const otherInput = document.createElement("textarea");
    otherComposer.append(otherInput);
    document.body.append(otherComposer);
    otherInput.focus();
    expect(document.activeElement).toBe(otherInput);

    await renderComposer(undefined, vi.fn(), false);

    expect(document.activeElement).toBe(otherInput);
    otherComposer.remove();
  });

  it("takes focus from a composer in a hidden session", async () => {
    const hiddenSession = document.createElement("div");
    hiddenSession.setAttribute("aria-hidden", "true");
    const hiddenComposer = document.createElement("div");
    hiddenComposer.setAttribute("data-composer", "");
    const hiddenInput = document.createElement("textarea");
    hiddenComposer.append(hiddenInput);
    hiddenSession.append(hiddenComposer);
    document.body.append(hiddenSession);
    hiddenInput.focus();
    expect(document.activeElement).toBe(hiddenInput);

    await renderComposer(undefined, vi.fn());

    expect(document.activeElement).toBe(container.querySelector("textarea"));
    hiddenSession.remove();
  });

  it("does not steal focus from a picker portaled outside the composer", async () => {
    await renderComposer(undefined, vi.fn(), true);

    // Popover.tsx portals picker content directly into document.body, so it
    // never sits under this composer's own [data-composer] subtree.
    const portaledPicker = document.createElement("div");
    portaledPicker.setAttribute("data-model-picker", "");
    const searchInput = document.createElement("input");
    portaledPicker.append(searchInput);
    document.body.append(portaledPicker);
    searchInput.focus();
    expect(document.activeElement).toBe(searchInput);

    await renderComposer(undefined, vi.fn(), false);

    expect(document.activeElement).toBe(searchInput);
    portaledPicker.remove();
  });

  it("opens the MCP picker in Save draft mode and offers Manage", async () => {
    const onSaveDraft = vi.fn();
    const onOpen = vi.fn();
    window.addEventListener("monocode:open-mcp-settings", onOpen);
    try {
      await act(async () =>
        root.render(
          createElement(Composer, {
            focused: true,
            harness: "claude",
            model: "claude-sonnet",
            runtimeMode: "supervised",
            executionCwd: "/repo",
            hideProjectPicker: true,
            hideBranchPicker: true,
            canSaveDraft: true,
            onFocus: vi.fn(),
            onCwdChange: vi.fn(),
            onModelChange: vi.fn(),
            onRuntimeModeChange: vi.fn(),
            onSubmit: vi.fn(),
            onSaveDraft,
          }),
        ),
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Add files or choose a mode"]',
          )!
          .click(),
      );
      const draftMode = [
        ...document.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.includes("Save this message"))!;
      await act(async () => draftMode.click());
      const textarea = container.querySelector("textarea")!;
      await act(async () => {
        textarea.value = "/mcp";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(container.querySelector("[data-mcp-picker]")).not.toBeNull();
      expect(onSaveDraft).not.toHaveBeenCalled();
      const manage = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.includes("Manage MCP Servers"))!;
      await act(async () => manage.click());
      expect(onOpen).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("monocode:open-mcp-settings", onOpen);
    }
  });
});
