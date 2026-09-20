// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

import {
  adjustDictationRange,
  applyModelProgress,
  caretAfterSplice,
  DICTATION_LANGUAGES,
  dictationDraftText,
  dictationLanguageLabel,
  downloadPercent,
  draftEditSpan,
  effectiveTranslate,
  filterDictationLanguages,
  formatElapsed,
  formatModelSize,
  isMicAccessError,
  isMicNotDetermined,
  isNoSessionError,
  isSessionBusyError,
  loadDictationPrefs,
  micPermissionAction,
  reanchorDictationRange,
  reduceSessionEvent,
  resolveDictationModel,
  saveDictationPrefs,
  spliceDictationText,
  type DictationModelInfo,
} from "./dictation";

function model(partial: Partial<DictationModelInfo>): DictationModelInfo {
  return {
    id: "base",
    label: "Base",
    tier: "fast",
    sizeBytes: 100,
    installed: false,
    removable: false,
    partialBytes: 0,
    downloading: false,
    supportsTranslate: true,
    ...partial,
  };
}

describe("dictationDraftText", () => {
  it("joins committed and partial with a space", () => {
    expect(dictationDraftText("hello", "wor")).toBe("hello wor");
  });

  it("returns committed alone when partial is blank", () => {
    expect(dictationDraftText("hello", "  ")).toBe("hello");
    expect(dictationDraftText("hello", "")).toBe("hello");
  });

  it("returns partial alone when nothing is committed", () => {
    expect(dictationDraftText("", "hel")).toBe("hel");
  });

  it("trims whisper's leading spaces", () => {
    expect(dictationDraftText(" hello ", " world ")).toBe("hello world");
  });
});

describe("draftEditSpan", () => {
  it("locates a middle insertion", () => {
    expect(draftEditSpan("ac", "abc")).toEqual({
      start: 1,
      prevEnd: 1,
      nextEnd: 2,
    });
  });

  it("locates a deletion", () => {
    expect(draftEditSpan("abc", "ac")).toEqual({
      start: 1,
      prevEnd: 2,
      nextEnd: 1,
    });
  });

  it("reports an append", () => {
    expect(draftEditSpan("ab", "abcd")).toEqual({
      start: 2,
      prevEnd: 2,
      nextEnd: 4,
    });
  });
});

describe("adjustDictationRange", () => {
  // Covers "dictated" inside "hello dictated".
  const range = { start: 6, end: 14 };

  it("shifts the range when the user types before it", () => {
    const next = adjustDictationRange(
      range,
      "hello dictated",
      "hi! hello dictated",
    );
    expect(next).toEqual({ start: 10, end: 18 });
    expect("hi! hello dictated".slice(next.start, next.end)).toBe("dictated");
  });

  it("leaves the range alone when the user types after it", () => {
    expect(
      adjustDictationRange(range, "hello dictated", "hello dictated end"),
    ).toEqual(range);
  });

  it("absorbs an edit inside the range", () => {
    const next = adjustDictationRange(
      range,
      "hello dictated",
      "hello diXctated",
    );
    expect(next).toEqual({ start: 6, end: 15 });
    expect("hello diXctated".slice(next.start, next.end)).toBe("diXctated");
  });

  it("collapses when the draft is cleared", () => {
    expect(adjustDictationRange(range, "hello dictated", "")).toEqual({
      start: 0,
      end: 0,
    });
  });
});

describe("spliceDictationText", () => {
  it("replaces the range and reports the inserted span", () => {
    expect(
      spliceDictationText(
        "say something here",
        { start: 4, end: 13 },
        "dictated",
      ),
    ).toEqual({
      value: "say dictated here",
      range: { start: 4, end: 12 },
    });
  });

  it("inserts into a collapsed range", () => {
    expect(spliceDictationText("ab", { start: 1, end: 1 }, "X")).toEqual({
      value: "aXb",
      range: { start: 1, end: 2 },
    });
  });
});

describe("caretAfterSplice", () => {
  const range = { start: 5, end: 10 };

  it("keeps a caret before the range", () => {
    expect(caretAfterSplice(2, range, 20)).toBe(2);
    expect(caretAfterSplice(5, range, 20)).toBe(5);
  });

  it("shifts a caret after the range by the size delta", () => {
    expect(caretAfterSplice(12, range, 20)).toBe(27);
    expect(caretAfterSplice(10, range, 3)).toBe(8);
  });

  it("parks a caret that was inside at the end of the insert", () => {
    expect(caretAfterSplice(7, range, 20)).toBe(25);
  });
});

describe("reanchorDictationRange", () => {
  it("keeps the range when the slice still matches", () => {
    const value = "hi hello world";
    expect(
      reanchorDictationRange(value, { start: 3, end: 14 }, "hello world"),
    ).toEqual({ start: 3, end: 14 });
  });

  it("relocates only one unambiguous occurrence", () => {
    expect(
      reanchorDictationRange(
        "prefix hello world",
        { start: 3, end: 14 },
        "hello world",
      ),
    ).toEqual({ start: 7, end: 18 });
    expect(
      reanchorDictationRange(
        "hello world … hello world",
        { start: 15, end: 26 },
        "hello world",
      ),
    ).toBeNull();
  });
  it("refuses to overwrite unrelated text or insert into a cleared draft", () => {
    expect(
      reanchorDictationRange("short", { start: 3, end: 14 }, "gone"),
    ).toBeNull();
    expect(
      reanchorDictationRange("", { start: 3, end: 14 }, "gone"),
    ).toBeNull();
    expect(
      reanchorDictationRange("new draft", { start: 20, end: 20 }, ""),
    ).toBeNull();
    expect(() =>
      spliceDictationText("new", { start: -1, end: 1 }, "bad"),
    ).toThrow("range");
  });
});

describe("reduceSessionEvent", () => {
  it("ignores events without a live session", () => {
    expect(
      reduceSessionEvent(null, { sessionId: 1, state: "recording" }),
    ).toEqual({ kind: "ignored" });
  });

  it("ignores events from a stale session", () => {
    expect(
      reduceSessionEvent(2, { sessionId: 1, state: "error", error: "boom" }),
    ).toEqual({ kind: "ignored" });
  });

  it("maps each state for the live session", () => {
    expect(reduceSessionEvent(7, { sessionId: 7, state: "recording" })).toEqual(
      { kind: "recording" },
    );
    expect(reduceSessionEvent(7, { sessionId: 7, state: "finished" })).toEqual({
      kind: "finished",
    });
    expect(reduceSessionEvent(7, { sessionId: 7, state: "cancelled" })).toEqual(
      { kind: "cancelled" },
    );
  });

  it("carries the error message, with a default", () => {
    expect(
      reduceSessionEvent(7, { sessionId: 7, state: "error", error: "boom" }),
    ).toEqual({ kind: "error", error: "boom" });
    expect(reduceSessionEvent(7, { sessionId: 7, state: "error" })).toEqual({
      kind: "error",
      error: "Dictation failed",
    });
  });
});

describe("applyModelProgress", () => {
  const models = [model({ id: "base" }), model({ id: "small" })];

  it("marks the model downloading with byte progress", () => {
    const next = applyModelProgress(models, {
      modelId: "base",
      phase: "downloading",
      downloadedBytes: 40,
      totalBytes: 100,
    });
    expect(next[0]).toMatchObject({ downloading: true, partialBytes: 40 });
    expect(next[1]).toMatchObject({ downloading: false, partialBytes: 0 });
  });

  it("verifying keeps the downloading flag", () => {
    const next = applyModelProgress(models, {
      modelId: "small",
      phase: "verifying",
      downloadedBytes: 100,
      totalBytes: 100,
    });
    expect(next[1].downloading).toBe(true);
  });

  it("done marks installed and clears partial bytes", () => {
    const next = applyModelProgress(models, {
      modelId: "base",
      phase: "done",
      downloadedBytes: 100,
      totalBytes: 100,
    });
    expect(next[0]).toMatchObject({
      downloading: false,
      installed: true,
      partialBytes: 0,
    });
  });

  it("cancelled/failed keep the resumable byte count", () => {
    for (const phase of ["cancelled", "failed"] as const) {
      const next = applyModelProgress(models, {
        modelId: "base",
        phase,
        downloadedBytes: 30,
        totalBytes: 100,
      });
      expect(next[0]).toMatchObject({
        downloading: false,
        installed: false,
        partialBytes: 30,
      });
    }
  });
});

describe("resolveDictationModel", () => {
  it("returns the preferred model when installed", () => {
    const models = [
      model({ id: "base", installed: true }),
      model({ id: "small", installed: true }),
    ];
    expect(resolveDictationModel(models, "small")?.id).toBe("small");
  });

  it("falls back to the first installed model", () => {
    const models = [
      model({ id: "base", installed: true }),
      model({ id: "small" }),
    ];
    expect(resolveDictationModel(models, "small")?.id).toBe("base");
  });

  it("returns the uninstalled preference so the menu can highlight it", () => {
    const models = [model({ id: "base" }), model({ id: "medium" })];
    expect(resolveDictationModel(models, "medium")?.id).toBe("medium");
  });

  it("defaults to base, then the first catalog entry", () => {
    expect(resolveDictationModel([model({ id: "base" })], null)?.id).toBe(
      "base",
    );
    expect(resolveDictationModel([model({ id: "tiny" })], null)?.id).toBe(
      "tiny",
    );
    expect(resolveDictationModel([], null)).toBeNull();
  });
});

describe("effectiveTranslate", () => {
  it("keeps translate only for translate-capable models", () => {
    expect(effectiveTranslate(true, model({ supportsTranslate: true }))).toBe(
      true,
    );
    expect(
      effectiveTranslate(
        true,
        model({ id: "large-v3-turbo", supportsTranslate: false }),
      ),
    ).toBe(false);
    expect(effectiveTranslate(true, null)).toBe(false);
    expect(effectiveTranslate(false, model({}))).toBe(false);
  });
});

describe("permission transitions", () => {
  it("retries the start when the OS granted access (or does not gate it)", () => {
    expect(micPermissionAction("authorized")).toBe("retry");
    expect(micPermissionAction("unknown")).toBe("retry");
  });

  it("sends the user to settings for denied, restricted, and still-undetermined", () => {
    expect(micPermissionAction("denied")).toBe("settings");
    expect(micPermissionAction("restricted")).toBe("settings");
    expect(micPermissionAction("not-determined")).toBe("settings");
  });

  it("matches the not-determined sentinel in an error string", () => {
    expect(isMicNotDetermined("mic-permission-not-determined")).toBe(true);
    expect(isMicNotDetermined(new Error("mic-permission-not-determined"))).toBe(
      true,
    );
    expect(isMicNotDetermined("other error")).toBe(false);
  });

  it("matches the backend's mic-off message", () => {
    expect(
      isMicAccessError(
        "Microphone access is off — enable it in System Settings → Privacy & Security → Microphone",
      ),
    ).toBe(true);
    expect(isMicAccessError("Model download failed")).toBe(false);
  });

  it("matches the single-session busy error", () => {
    expect(isSessionBusyError("A dictation session is already running")).toBe(
      true,
    );
    expect(isSessionBusyError("mic-permission-not-determined")).toBe(false);
  });

  it("matches the no-session race error", () => {
    expect(isNoSessionError("No dictation in progress")).toBe(true);
    expect(isNoSessionError("Dictation worker panicked")).toBe(false);
  });
});

describe("dictation prefs", () => {
  beforeEach(() => localStorage.clear());

  it("keeps legacy bytes after an explicit preference change and exposes write failures", () => {
    const legacy = JSON.stringify({
      modelId: "small",
      language: "pl",
      translate: true,
      mode: "hold",
    });
    localStorage.setItem("monocode.dictation", legacy);
    saveDictationPrefs({ ...loadDictationPrefs(), mode: "toggle" });
    expect(localStorage.getItem("monocode.dictation")).toBe(legacy);
    expect(loadDictationPrefs().mode).toBe("toggle");
    const storage = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: storage.getItem.bind(storage),
      setItem: () => {
        throw new Error("quota");
      },
    });
    try {
      expect(() =>
        saveDictationPrefs({ ...loadDictationPrefs(), language: "en" }),
      ).toThrow("quota");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("round-trips saved preferences", () => {
    saveDictationPrefs({
      modelId: "small",
      language: "pl",
      translate: true,
      mode: "hold",
    });
    expect(loadDictationPrefs()).toEqual({
      modelId: "small",
      language: "pl",
      translate: true,
      mode: "hold",
    });
  });

  it("defaults when nothing is stored or the JSON is broken", () => {
    expect(loadDictationPrefs()).toEqual({
      modelId: null,
      language: null,
      translate: false,
      mode: "toggle",
    });
    localStorage.setItem("monocode.dictation", "{not json");
    expect(loadDictationPrefs()).toEqual({
      modelId: null,
      language: null,
      translate: false,
      mode: "toggle",
    });
  });

  it("drops values that are not in the fixed language list", () => {
    localStorage.setItem(
      "monocode.dictation",
      JSON.stringify({ modelId: "base", language: "klingon", translate: 1 }),
    );
    expect(loadDictationPrefs()).toEqual({
      modelId: "base",
      language: null,
      translate: false,
      mode: "toggle",
    });
  });

  it("drops an unknown trigger mode", () => {
    localStorage.setItem(
      "monocode.dictation",
      JSON.stringify({ mode: "double-tap" }),
    );
    expect(loadDictationPrefs().mode).toBe("toggle");
  });
});

describe("dictation languages", () => {
  it("pins auto-detect, English and Polish ahead of the full list", () => {
    expect(DICTATION_LANGUAGES[0].id).toBeNull();
    expect(DICTATION_LANGUAGES[1].id).toBe("en");
    expect(DICTATION_LANGUAGES[2].id).toBe("pl");
    expect(DICTATION_LANGUAGES.length).toBeGreaterThanOrEqual(99);
  });

  it("filters languages case-insensitively by label", () => {
    expect(filterDictationLanguages("pol").map((l) => l.id)).toEqual(["pl"]);
    expect(filterDictationLanguages("GERMAN").map((l) => l.id)).toEqual(["de"]);
    expect(filterDictationLanguages("").length).toBe(
      DICTATION_LANGUAGES.length,
    );
    expect(filterDictationLanguages("zzz")).toEqual([]);
  });

  it("labels the selected language", () => {
    expect(dictationLanguageLabel(null)).toBe("Auto-detect");
    expect(dictationLanguageLabel("pl")).toBe("Polish");
    expect(dictationLanguageLabel("xx")).toBe("Auto-detect");
  });
});

describe("formatting", () => {
  it("formats elapsed audio as m:ss", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(61_500)).toBe("1:01");
    expect(formatElapsed(600_000)).toBe("10:00");
  });

  it("formats model sizes", () => {
    expect(formatModelSize(147_951_465)).toBe("148 MB");
    expect(formatModelSize(1_624_555_275)).toBe("1.6 GB");
  });

  it("computes download percent", () => {
    expect(
      downloadPercent({
        modelId: "base",
        phase: "downloading",
        downloadedBytes: 25,
        totalBytes: 100,
      }),
    ).toBe(25);
    expect(
      downloadPercent({
        modelId: "base",
        phase: "downloading",
        downloadedBytes: 200,
        totalBytes: 100,
      }),
    ).toBe(100);
    expect(
      downloadPercent({
        modelId: "base",
        phase: "downloading",
        downloadedBytes: 1,
        totalBytes: 0,
      }),
    ).toBe(0);
  });
});
