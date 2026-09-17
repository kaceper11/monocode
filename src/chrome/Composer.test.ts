// @vitest-environment happy-dom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, ComposerAction } from "./Composer";
import { SessionPane } from "../surfaces/SessionPane";
import { newSession } from "../lib/session";
import { appendUser } from "../lib/harness/apply";

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

// Native IO is outside this DOM regression; the real composer handles the send.
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => [], convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("./useComposerSkills", () => ({ useComposerSkills: () => ({ skills: [] }) }));
vi.mock("./DictationControl", () => ({ DictationControl: () => null }));
vi.mock("./useDictation", () => ({ useDictation: () => ({}) }));
vi.mock("../surfaces/TerminalGridBackground", () => ({ TerminalGridBackground: () => null }));
vi.mock("../surfaces/AgentTranscript", () => ({ AgentTranscript: () => null }));
vi.mock("../surfaces/SessionReview", () => ({ SessionReview: () => null }));

import { createRoot, type Root } from "react-dom/client";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); });

async function mountComposer(onSubmit: () => boolean | Promise<boolean>, extra: Partial<Parameters<typeof Composer>[0]> = {}) {
  const host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root!.render(createElement(Composer, {
    focused: true, harness: "muse", model: "muse:default", runtimeMode: "supervised",
    executionCwd: "/repo", sessionId: "test", initialDraft: "first", hideTopBar: true,
    onFocus: vi.fn(), onCwdChange: vi.fn(), onModelChange: vi.fn(), onRuntimeModeChange: vi.fn(), onSubmit,
    ...extra,
  })));
  const editor = host.querySelector("textarea")!;
  const send = () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click();
  return { host, editor, send };
}

it("keeps unconfirmed delivery visible and disables steering until the provider is ready", async () => {
  const { host } = await mountComposer(() => true, {
    busy: true, canSteer: false, queueStatus: "paused",
    queuedMessages: [{ id: "followup", text: "next", attachments: [], deliveryError: "write failed" }],
  });
  expect(host.textContent).toContain("Delivery unconfirmed: write failed");
  expect(host.textContent).toContain("review before resuming");
  const steer = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Steer");
  expect(steer?.disabled).toBe(true);
});

it("retains a rejected draft and displays why it was not accepted", async () => {
  const { host, editor, send } = await mountComposer(() => false);
  await act(async () => send());
  expect(editor.value).toBe("first");
  expect(host.textContent).toContain("Message was not accepted");
});

it("does not offer steering for a queued plan even when the provider can steer", async () => {
  const onSteerQueuedMessage = vi.fn();
  const { host } = await mountComposer(() => true, {
    busy: true, canSteer: true, onSteerQueuedMessage,
    queuedMessages: [{ id: "plan", text: "Add sign in", attachments: [], intent: "plan" }],
  });
  const steer = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Steer")!;
  expect(steer.disabled).toBe(true);
  expect(steer.title).toContain("Plans start as a separate turn");
  await act(async () => steer.click());
  expect(onSteerQueuedMessage).not.toHaveBeenCalled();
});

it("reserves an asynchronous send once and preserves the next draft", async () => {
  let accept!: (accepted: boolean) => void;
  const onSubmit = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
  const { editor, send } = await mountComposer(onSubmit);
  await act(async () => { send(); send(); });
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(editor.value).toBe("first");
  await act(async () => {
    editor.value = "second";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    accept(true);
  });
  expect(editor.value).toBe("second");
});

it("clears an accepted draft and recovers after rejected preflight", async () => {
  const onSubmit = vi.fn<() => boolean | Promise<boolean>>()
    .mockRejectedValueOnce(new Error("preflight failed"))
    .mockReturnValueOnce(true);
  const { host, editor, send } = await mountComposer(onSubmit);
  await act(async () => send());
  expect(editor.value).toBe("first");
  expect(host.textContent).toContain("preflight failed");
  await act(async () => send());
  expect(editor.value).toBe("");
  expect(onSubmit).toHaveBeenCalledTimes(2);
});

it.each(["muse", "codex"] as const)("clears the first %s message after the composer docks and preserves the next draft", async (harness) => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  let session = { ...newSession(harness, "/repo"), composerSeed: "first" };
  let accept!: (accepted: boolean) => void;
  const onSubmit = vi.fn((_id: string, text: string) => {
    session = { ...appendUser(session, text), composerSeed: "first" };
    render();
    return new Promise<boolean>(resolve => { accept = resolve; });
  });
  const render = () => root!.render(createElement(SessionPane, {
    session, visible: true, focused: true, inSplit: false, composerFocused: true, recents: [],
    onSubmit, onFocus: vi.fn(), onClose: vi.fn(), onCwdChange: vi.fn(), onBranchChange: vi.fn(),
    onModelChange: vi.fn(), onModelSettingsChange: vi.fn(), onRuntimeModeChange: vi.fn(),
    onStop: vi.fn(), onCompactContext: () => false, onPlaceSessionInFolder: vi.fn(),
    onDeleteQueuedMessage: vi.fn(), onEditQueuedMessage: vi.fn(), onQueuedMessageEditingChange: vi.fn(),
    onSteerQueuedMessage: vi.fn(), onResumeQueue: vi.fn(), onApproval: vi.fn(), onQuestionReply: vi.fn(),
    onOpenFile: vi.fn(), onOpenDiff: vi.fn(), onOpenPlan: vi.fn(), onBuildPlan: vi.fn(), onNewTerminal: vi.fn(),
  }));
  await act(async () => render());
  const editor = host.querySelector("textarea")!;
  expect(document.activeElement).toBe(editor);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  await act(async () => accept(true));
  expect(host.querySelector("textarea")!.value).toBe("");
  expect(host.querySelector("textarea")).toBe(editor);
  expect(document.activeElement).toBe(editor);
  await act(async () => {
    editor.value = "follow-up";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  await act(async () => {
    editor.value = "next draft";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => accept(true));
  expect(editor.value).toBe("next draft");
  expect(onSubmit.mock.calls.map(([, text]) => text)).toEqual(["first", "follow-up"]);
});
