// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const voice = vi.hoisted(() => ({ detach: vi.fn(), options: vi.fn() }));
vi.mock("./useDictation", () => ({
  useDictation: (options: unknown) => {
    voice.options(options);
    return { dim: null, detach: voice.detach };
  },
}));
vi.mock("./DictationControl", () => ({
  DictationControl: () => null,
  DictationError: () => null,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({ branches: null, settled: true }),
}));
import { Composer } from "./Composer";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
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
async function mount(
  draft: string,
  onSubmit: () => boolean,
  onCompactContext?: () => boolean,
  onSaveDraft?: () => boolean,
) {
  await act(async () =>
    root.render(
      createElement(Composer, {
        focused: true,
        sessionId: "voice-test",
        harness: "claude",
        model: "claude-sonnet",
        runtimeMode: "supervised",
        executionCwd: "/repo",
        initialDraft: draft,
        hideProjectPicker: true,
        hideBranchPicker: true,
        onFocus: () => {},
        onCwdChange: () => {},
        onModelChange: () => {},
        onRuntimeModeChange: () => {},
        onSubmit,
        onCompactContext,
        canSaveDraft: !!onSaveDraft,
        onSaveDraft,
      }),
    ),
  );
}
async function send() {
  await act(async () =>
    (
      container.querySelector('button[aria-label="Send"]') as HTMLButtonElement
    ).click(),
  );
}

it("detaches dictation only after upstream accepts the turn", async () => {
  const submit = vi.fn(() => false);
  await mount("Preserve this draft", submit);
  await send();
  expect(submit).toHaveBeenCalledTimes(1);
  expect(voice.detach).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe(
    "Preserve this draft",
  );
  submit.mockReturnValue(true);
  await send();
  expect(voice.detach).toHaveBeenCalledTimes(1);
  expect(container.querySelector("textarea")!.value).toBe("");
});

it("uses the same acceptance gate for compact without replacing upstream dispatch", async () => {
  const compact = vi.fn(() => false),
    submit = vi.fn(() => true);
  await mount("/compact", submit, compact);
  await send();
  expect(voice.detach).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe("/compact");
  compact.mockReturnValue(true);
  await send();
  expect(voice.detach).toHaveBeenCalledTimes(1);
  expect(container.querySelector("textarea")!.value).toBe("");
  expect(submit).not.toHaveBeenCalled();
});

it("detaches only after the upstream persistent-draft save is accepted", async () => {
  const save = vi.fn(() => false), submit = vi.fn(() => true);
  await mount("Dictated draft", submit, undefined, save);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add files or choose a mode"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Save this message"))!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Save draft"]')!.click());
  expect(voice.detach).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")!.value).toBe("Dictated draft");
  save.mockReturnValue(true);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Save draft"]')!.click());
  expect(voice.detach).toHaveBeenCalledOnce();
  expect(container.querySelector("textarea")!.value).toBe("");
  expect(submit).not.toHaveBeenCalled();
});
