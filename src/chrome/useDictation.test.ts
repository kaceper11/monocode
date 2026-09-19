// @vitest-environment happy-dom
import { act, createElement, StrictMode, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DictationPartial, DictationSessionEvent } from "../lib/dictation";
import { useDictation, type Dictation } from "./useDictation";

const api = vi.hoisted(() => ({
  catalog: vi.fn(),
  status: vi.fn(),
  prepare: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  partial: vi.fn(),
  session: vi.fn(),
  progress: vi.fn(),
  permission: vi.fn(),
}));
vi.mock("../lib/dictation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/dictation")>()),
  dictationCatalog: api.catalog,
  dictationStatus: api.status,
  dictationPrepare: api.prepare,
  dictationStart: api.start,
  dictationStop: api.stop,
  dictationCancel: api.cancel,
  dictationRequestMicPermission: api.permission,
  listenDictationPartial: api.partial,
  listenDictationSession: api.session,
  listenDictationModelProgress: api.progress,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
let root: Root, container: HTMLDivElement, control: Dictation;
let edit: (value: string) => void;
let partials: ((event: DictationPartial) => void)[];
let sessions: ((event: DictationSessionEvent) => void)[];
let unsubscribes: ReturnType<typeof vi.fn>[];
const models = [{ id: "tiny", installed: true, supportsTranslate: true }];
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const textarea = () => container.querySelector("textarea")!;
function Harness({
  owner = "first",
  enabled = true,
}: {
  owner?: string;
  enabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("before old after");
  edit = (value) => {
    ref.current!.value = value;
    setDraft(value);
  };
  control = useDictation({
    textareaRef: ref,
    draft,
    commitDraft: setDraft,
    owner,
    enabled,
  });
  return createElement("textarea", { ref, defaultValue: "before old after" });
}
async function mount(owner = "first", enabled = true) {
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(Harness, { owner, enabled }),
      ),
    );
  });
}
async function start() {
  textarea().focus();
  textarea().setSelectionRange(7, 10);
  await act(async () => {
    control.press();
    await flush();
  });
}
function transcript(text: string, seq = 1, id = 1) {
  for (const receive of partials)
    receive({
      sessionId: id,
      seq,
      committed: "",
      partial: text,
      audioMs: 1500,
    });
}
beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  partials = [];
  sessions = [];
  unsubscribes = [];
  api.catalog.mockResolvedValue(models);
  api.status.mockResolvedValue({
    phase: "idle",
    micPermission: "authorized",
    sessionId: null,
  });
  api.prepare.mockResolvedValue(1);
  api.start.mockResolvedValue({
    sessionId: 1,
    modelId: "tiny",
    deviceName: "fixture",
  });
  api.stop.mockResolvedValue({ text: "final", droppedAudioMs: 0 });
  api.cancel.mockResolvedValue(undefined);
  api.partial.mockImplementation(async (cb) => {
    partials.push(cb);
    const off = vi.fn();
    unsubscribes.push(off);
    return off;
  });
  api.session.mockImplementation(async (cb) => {
    sessions.push(cb);
    const off = vi.fn();
    unsubscribes.push(off);
    return off;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await mount();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("does no idle IO and deduplicates same-tick start before the catalog resolves", async () => {
  expect(api.catalog).not.toHaveBeenCalled();
  expect(api.status).not.toHaveBeenCalled();
  expect(api.partial).not.toHaveBeenCalled();
  expect(api.progress).not.toHaveBeenCalled();
  const catalog = deferred<typeof models>();
  api.catalog.mockReturnValue(catalog.promise);
  await act(async () => {
    control.press();
    control.press();
  });
  expect(api.catalog).toHaveBeenCalledTimes(1);
  await act(async () => {
    control.cancel();
    catalog.resolve(models);
    await flush();
  });
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.start).not.toHaveBeenCalled();
  expect(textarea().value).toBe("before old after");
});

it("cancels only a late reservation and leaves the replacement attempt active", async () => {
  const preparation = deferred<number>();
  api.prepare.mockReturnValueOnce(preparation.promise).mockResolvedValue(2);
  await start();
  await act(async () => {
    control.cancel();
  });
  api.start.mockResolvedValue({ sessionId: 2 });
  await start();
  await act(async () => {
    preparation.resolve(1);
    await flush();
  });
  expect(api.cancel).toHaveBeenCalledWith(1);
  expect(api.cancel).not.toHaveBeenCalledWith(2);
  expect(api.start).toHaveBeenCalledTimes(1);
  expect(api.start.mock.calls[0][0]).toBe(2);
  await act(async () => transcript("replacement", 1, 2));
  expect(textarea().value).toBe("before replacement after");
});

it("keeps edits outside the dictated span, ignores stale partials and preserves an edit inside it", async () => {
  await start();
  await act(async () => transcript("spoken", 2));
  await act(async () => transcript("stale", 1));
  expect(textarea().value).toBe("before spoken after");
  await act(async () => edit("prefix before spoken after"));
  await act(async () => transcript("new speech", 3));
  expect(textarea().value).toBe("prefix before new speech after");
  await act(async () => edit("prefix before MY EDIT after"));
  await act(async () => transcript("late overwrite", 4));
  expect(textarea().value).toBe("prefix before MY EDIT after");
  expect(control.phase).toBe("idle");
  expect(api.cancel).toHaveBeenCalledWith(1);
});

it("restores the original selection on cancel without erasing edits elsewhere", async () => {
  await start();
  await act(async () => transcript("spoken"));
  await act(async () => edit("prefix before spoken after"));
  await act(async () => control.cancel());
  expect(textarea().value).toBe("prefix before old after");
});

it("preserves the selected text when the final transcript contains no speech", async () => {
  api.stop.mockResolvedValue({ text: "", droppedAudioMs: 0 });
  await start();
  await act(async () => {
    await control.stop();
  });
  expect(textarea().value).toBe("before old after");
});

it("cancels pending capture when the window becomes hidden, preserving the draft", async () => {
  const preparation = deferred<number>();
  api.prepare.mockReturnValue(preparation.promise);
  await start();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  try {
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      preparation.resolve(1);
      await flush();
    });
    expect(api.start).not.toHaveBeenCalled();
    expect(api.cancel).toHaveBeenCalledWith(1);
    expect(textarea().value).toBe("before old after");
  } finally {
    hidden.mockRestore();
  }
});

it("checks live textarea edits before React has committed a partial update", async () => {
  await start();
  await act(async () => transcript("spoken"));
  textarea().value = "before USER after";
  await act(async () => transcript("late overwrite", 2));
  expect(textarea().value).toBe("before USER after");
  expect(control.phase).toBe("idle");
});

it("does not redirect a late start or partial after a session owner changes", async () => {
  const starting = deferred<{ sessionId: number }>();
  api.start.mockReturnValue(starting.promise);
  await start();
  await mount("second");
  await act(async () => {
    edit("second draft");
    starting.resolve({ sessionId: 1 });
    await flush();
    transcript("wrong session");
  });
  expect(textarea().value).toBe("second draft");
  expect(control.phase).toBe("idle");
  expect(api.cancel).toHaveBeenCalledWith(1);
  expect(unsubscribes.every((off) => off.mock.calls.length === 1)).toBe(true);
});

it("does not refill a submitted draft from a late final result", async () => {
  await start();
  await act(async () => transcript("spoken"));
  const final = deferred<{ text: string; droppedAudioMs: number }>();
  api.stop.mockReturnValue(final.promise);
  await act(async () => {
    void control.stop();
  });
  await act(async () => {
    control.detach();
    edit("");
  });
  await act(async () => {
    final.resolve({ text: "late final", droppedAudioMs: 0 });
    await flush();
  });
  expect(textarea().value).toBe("");
  expect(control.phase).toBe("idle");
});

it("requires working event subscriptions before reserving or opening the microphone", async () => {
  api.session.mockRejectedValue(new Error("listener failed"));
  await start();
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.start).not.toHaveBeenCalled();
  expect(control.error).toBe("listener failed");
  expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
});

it("takes over only the exact observed ID and preserves externally cancelled partials", async () => {
  api.prepare
    .mockRejectedValueOnce(new Error("A dictation session is already running"))
    .mockResolvedValue(1);
  api.status.mockResolvedValue({ micPermission: "authorized", sessionId: 7 });
  await start();
  expect(api.cancel).toHaveBeenCalledWith(7, true);
  await act(async () => transcript("keep this"));
  await act(async () => {
    for (const receive of sessions)
      receive({ sessionId: 1, state: "cancelled" });
  });
  expect(textarea().value).toBe("before keep this after");
  expect(control.phase).toBe("idle");
});

it("cleans an in-flight listener after unmount without proceeding to capture", async () => {
  const listener = deferred<() => void>(),
    off = vi.fn();
  api.partial.mockReturnValue(listener.promise);
  await start();
  await act(async () => root.render(null));
  await act(async () => {
    listener.resolve(off);
    await flush();
  });
  expect(off).toHaveBeenCalledTimes(1);
  expect(api.prepare).not.toHaveBeenCalled();
});
