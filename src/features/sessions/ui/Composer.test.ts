// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { UserQuestionPrompt } from "../model/userQuestion";

function renderAction(busy: boolean, hasValue: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerAction, {
      busy,
      hasValue,
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
});

describe("Composer question focus", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jira.status.mockReset().mockResolvedValue({ connected: true, site: "https://team.atlassian.net", accountId: "owner", capabilities: ["Jira", "Confluence"] });
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

  it("shows the selected WSL worktree catalog rather than the project catalog", async () => {
    const cwd = "//wsl.localhost/Ubuntu/home/dev/project";
    const executionCwd = "//wsl.localhost/Ubuntu/home/dev/worktree";
    const model = { id: "claude:scoped", nativeId: "scoped", harness: "claude" as const };
    setHarnessModels("claude", [{ ...model, name: "Project catalog model" }], cwd);
    setHarnessModels("claude", [{ ...model, name: "Worktree catalog model" }], executionCwd);
    try {
      await act(async () => root.render(createElement(Composer, {
        cwd, executionCwd, focused: true, harness: "claude", model: model.id,
        runtimeMode: "supervised", hideProjectPicker: true, hideBranchPicker: true,
        onFocus: vi.fn(), onCwdChange: vi.fn(), onModelChange: vi.fn(),
        onRuntimeModeChange: vi.fn(), onSubmit: vi.fn(), onStop: vi.fn(),
      })));
      expect(container.textContent).toContain("Worktree catalog model");
      expect(container.textContent).not.toContain("Project catalog model");
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
  ) {
    await act(async () =>
      root.render(
        createElement(Composer, {
          focused: true,
          focusToken,
          harness: "claude",
          model: "claude-sonnet",
          runtimeMode: "supervised",
          executionCwd: "/repo",
          initialDraft,
          hideProjectPicker: true,
          hideBranchPicker: true,
          onFocus: () => {},
          onCwdChange: () => {},
          onModelChange: () => {},
          onRuntimeModeChange: () => {},
          onSubmit: () => {},
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
    await render("//wsl.localhost/Ubuntu/home/dev/repo");
    expect(() => original.accept(context)).toThrow(/execution host changed/);
    const moved = targets.find(target => target.sessionId === props.sessionId)!;
    expect(moved.cwd).toContain("wsl.localhost");
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
    for (const change of [{ sessionId: "second" }, { executionCwd: "//wsl.localhost/Ubuntu/home/dev/repo" }, { enabled: false }, { worktreeRemoved: true }]) {
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
    for (const change of [{ sessionId: "other" }, { executionCwd: "//wsl.localhost/Ubuntu/home/dev/repo" }, { harness: "codex" as const }, { enabled: false }, { worktreeRemoved: true }]) {
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
      '[aria-label="Workspace Worktree"]',
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
});
