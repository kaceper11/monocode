//! Local dictation: IPC surface for the whisper.cpp backend plus the pure
//! draft/session reducers the composer unit-tests. Audio and transcripts never
//! leave the machine — see `src-tauri/src/dictation.rs` for the authoritative
//! command/event contract mirrored below.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── IPC types (camelCase mirrors of the Rust structs) ───────────────────────

export type MicPermission =
  "unknown" | "not-determined" | "restricted" | "denied" | "authorized";

export type DictationModelInfo = {
  id: string;
  label: string;
  tier: string;
  sizeBytes: number;
  installed: boolean;
  removable: boolean;
  /** Bytes of a resumable `.part` download on disk. */
  partialBytes: number;
  downloading: boolean;
  supportsTranslate: boolean;
};

export type DictationStatus = {
  micPermission: MicPermission;
  phase: "idle" | "starting" | "recording" | "finishing";
  recording: boolean;
  sessionId: number | null;
  modelId: string | null;
  ownedByWindow: boolean;
};

export type DictationStarted = {
  sessionId: number;
  deviceName: string;
  modelId: string;
};

export type DictationResult = {
  text: string;
  language: string | null;
  audioMs: number;
  modelLoadMs: number;
  inferMs: number;
  droppedAudioMs: number;
  streamError?: string;
};

export type DictationPartial = {
  sessionId: number;
  seq: number;
  /** All committed text so far — replaces the draft's committed portion. */
  committed: string;
  /** Provisional text for the trailing window. */
  partial: string;
  audioMs: number;
};

export type DictationSessionEvent = {
  sessionId: number;
  state: "recording" | "finished" | "cancelled" | "error";
  error?: string;
};

export type DictationModelProgress = {
  modelId: string;
  phase: "downloading" | "verifying" | "done" | "cancelled" | "failed";
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
};

// ── Commands ────────────────────────────────────────────────────────────────

export function dictationCatalog() {
  return invoke<DictationModelInfo[]>("dictation_catalog");
}

export function dictationModelInstall(modelId: string) {
  return invoke<void>("dictation_model_install", { modelId });
}

export function dictationModelCancelDownload(modelId: string) {
  return invoke<void>("dictation_model_cancel_download", { modelId });
}

export function dictationModelRemove(modelId: string) {
  return invoke<void>("dictation_model_remove", { modelId });
}

export function dictationStatus() {
  return invoke<DictationStatus>("dictation_status");
}

export function dictationRequestMicPermission() {
  return invoke<MicPermission>("dictation_request_mic_permission");
}

export function dictationOpenMicSettings() {
  return invoke<void>("dictation_open_mic_settings");
}

export function dictationPrepare() {
  return invoke<number>("dictation_prepare");
}

export function dictationStart(
  sessionId: number,
  modelId: string,
  language: string | null,
  translate: boolean,
) {
  return invoke<DictationStarted>("dictation_start", {
    sessionId,
    modelId,
    language,
    translate,
  });
}

/** Stops the running session and resolves with the final transcript that
 * replaces everything partials inserted. The id guards the stop: if the
 * caller's session was already superseded, the backend refuses rather than
 * stopping a foreign session. */
export function dictationStop(sessionId: number) {
  return invoke<DictationResult>("dictation_stop", { sessionId });
}

export function dictationCancel(sessionId: number, takeover = false) {
  return invoke<void>("dictation_cancel", { sessionId, takeover });
}

export function listenDictationPartial(
  handler: (payload: DictationPartial) => void,
) {
  return listen<DictationPartial>("dictation:partial", (event) =>
    handler(event.payload),
  );
}

export function listenDictationSession(
  handler: (payload: DictationSessionEvent) => void,
) {
  return listen<DictationSessionEvent>("dictation:session", (event) =>
    handler(event.payload),
  );
}

export function listenDictationModelProgress(
  handler: (payload: DictationModelProgress) => void,
) {
  return listen<DictationModelProgress>("dictation:model-progress", (event) =>
    handler(event.payload),
  );
}

// ── Preferences ─────────────────────────────────────────────────────────────

export const DICTATION_PREFS_KEY = "monocode.dictation.v1";
export const LEGACY_DICTATION_PREFS_KEY = "monocode.dictation";

/** Whisper's full multilingual set; `null` auto-detects the spoken language.
 * Auto, English and Polish are pinned ahead of the alphabetical rest. */
export const DICTATION_LANGUAGES: { id: string | null; label: string }[] = [
  { id: null, label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "pl", label: "Polish" },
  ...[
    ["af", "Afrikaans"],
    ["am", "Amharic"],
    ["ar", "Arabic"],
    ["as", "Assamese"],
    ["az", "Azerbaijani"],
    ["ba", "Bashkir"],
    ["be", "Belarusian"],
    ["bg", "Bulgarian"],
    ["bn", "Bengali"],
    ["bo", "Tibetan"],
    ["br", "Breton"],
    ["bs", "Bosnian"],
    ["ca", "Catalan"],
    ["cs", "Czech"],
    ["cy", "Welsh"],
    ["da", "Danish"],
    ["de", "German"],
    ["el", "Greek"],
    ["es", "Spanish"],
    ["et", "Estonian"],
    ["eu", "Basque"],
    ["fa", "Persian"],
    ["fi", "Finnish"],
    ["fo", "Faroese"],
    ["fr", "French"],
    ["gl", "Galician"],
    ["gu", "Gujarati"],
    ["ha", "Hausa"],
    ["haw", "Hawaiian"],
    ["he", "Hebrew"],
    ["hi", "Hindi"],
    ["hr", "Croatian"],
    ["ht", "Haitian Creole"],
    ["hu", "Hungarian"],
    ["hy", "Armenian"],
    ["id", "Indonesian"],
    ["is", "Icelandic"],
    ["it", "Italian"],
    ["ja", "Japanese"],
    ["jw", "Javanese"],
    ["ka", "Georgian"],
    ["kk", "Kazakh"],
    ["km", "Khmer"],
    ["kn", "Kannada"],
    ["ko", "Korean"],
    ["la", "Latin"],
    ["lb", "Luxembourgish"],
    ["ln", "Lingala"],
    ["lo", "Lao"],
    ["lt", "Lithuanian"],
    ["lv", "Latvian"],
    ["mg", "Malagasy"],
    ["mi", "Māori"],
    ["mk", "Macedonian"],
    ["ml", "Malayalam"],
    ["mn", "Mongolian"],
    ["mr", "Marathi"],
    ["ms", "Malay"],
    ["mt", "Maltese"],
    ["my", "Burmese"],
    ["ne", "Nepali"],
    ["nl", "Dutch"],
    ["nn", "Norwegian Nynorsk"],
    ["no", "Norwegian"],
    ["oc", "Occitan"],
    ["pa", "Punjabi"],
    ["ps", "Pashto"],
    ["pt", "Portuguese"],
    ["ro", "Romanian"],
    ["ru", "Russian"],
    ["sa", "Sanskrit"],
    ["sd", "Sindhi"],
    ["si", "Sinhala"],
    ["sk", "Slovak"],
    ["sl", "Slovenian"],
    ["sn", "Shona"],
    ["so", "Somali"],
    ["sq", "Albanian"],
    ["sr", "Serbian"],
    ["su", "Sundanese"],
    ["sv", "Swedish"],
    ["sw", "Swahili"],
    ["ta", "Tamil"],
    ["te", "Telugu"],
    ["tg", "Tajik"],
    ["th", "Thai"],
    ["tk", "Turkmen"],
    ["tl", "Tagalog"],
    ["tr", "Turkish"],
    ["tt", "Tatar"],
    ["uk", "Ukrainian"],
    ["ur", "Urdu"],
    ["uz", "Uzbek"],
    ["vi", "Vietnamese"],
    ["yi", "Yiddish"],
    ["yo", "Yoruba"],
    ["yue", "Cantonese"],
    ["zh", "Chinese"],
  ].map(([id, label]) => ({ id, label })),
];

/** Case-insensitive label filter for the language list. */
export function filterDictationLanguages(
  query: string,
): { id: string | null; label: string }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return DICTATION_LANGUAGES;
  return DICTATION_LANGUAGES.filter((language) =>
    language.label.toLowerCase().includes(needle),
  );
}

export function dictationLanguageLabel(id: string | null): string {
  return (
    DICTATION_LANGUAGES.find((language) => language.id === id)?.label ??
    "Auto-detect"
  );
}

/** How dictation engages: `hold` runs while the mic/shortcut is held down,
 * `toggle` starts on press and stops on the next. */
export type DictationMode = "toggle" | "hold";

export type DictationPrefs = {
  modelId: string | null;
  language: string | null;
  translate: boolean;
  mode: DictationMode;
};

export const DICTATION_PREFS_DEFAULT: DictationPrefs = {
  modelId: null,
  language: null,
  translate: false,
  mode: "toggle",
};

export function isDictationMode(value: unknown): value is DictationMode {
  return value === "toggle" || value === "hold";
}

export function isDictationLanguage(value: unknown): value is string | null {
  return (
    value === null ||
    DICTATION_LANGUAGES.some((language) => language.id === value)
  );
}

export function loadDictationPrefs(): DictationPrefs {
  try {
    const raw =
      localStorage.getItem(DICTATION_PREFS_KEY) ??
      localStorage.getItem(LEGACY_DICTATION_PREFS_KEY);
    if (!raw) return DICTATION_PREFS_DEFAULT;
    const parsed = JSON.parse(raw) as Partial<DictationPrefs>;
    return {
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : null,
      language: isDictationLanguage(parsed.language ?? null)
        ? (parsed.language ?? null)
        : null,
      translate: parsed.translate === true,
      mode: isDictationMode(parsed.mode) ? parsed.mode : "toggle",
    };
  } catch {
    return DICTATION_PREFS_DEFAULT;
  }
}

/** Explicit writes use an owned versioned key. Legacy bytes stay recoverable;
 * quota/access failures must be shown by the control, not silently ignored. */
export function saveDictationPrefs(prefs: DictationPrefs) {
  localStorage.setItem(DICTATION_PREFS_KEY, JSON.stringify(prefs));
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Sentinel the backend returns when macOS has never been asked for the mic. */
export const MIC_NOT_DETERMINED = "mic-permission-not-determined";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMicNotDetermined(error: unknown): boolean {
  return errorMessage(error).includes(MIC_NOT_DETERMINED);
}

/** The backend's mic-off message for denied/restricted permission. */
export function isMicAccessError(error: unknown): boolean {
  return errorMessage(error).startsWith("Microphone access is off");
}

/** The backend allows exactly one session — another composer (or an orphaned
 * session) is holding the mic. */
export function isSessionBusyError(error: unknown): boolean {
  return errorMessage(error).includes("dictation session is already running");
}

/** The caller's session was already superseded/cleared — a stop or cancel
 * raced a take-over, not a real failure. */
export function isNoSessionError(error: unknown): boolean {
  return errorMessage(error).includes("No dictation in progress");
}

/** What to do after `dictation_request_mic_permission` resolves: retry the
 * start when the OS granted access (or does not gate it), otherwise send the
 * user to System Settings. */
export function micPermissionAction(
  permission: MicPermission,
): "retry" | "settings" {
  return permission === "authorized" || permission === "unknown"
    ? "retry"
    : "settings";
}

// ── Model state ─────────────────────────────────────────────────────────────

/** Which model a dictation start should use: the preferred one when installed,
 * else the first installed, else the preferred (for the menu to highlight),
 * else Base, else the first catalog entry. */
export function resolveDictationModel(
  models: DictationModelInfo[],
  preferredId: string | null,
): DictationModelInfo | null {
  const preferred = models.find((model) => model.id === preferredId);
  if (preferred?.installed) return preferred;
  const installed = models.find((model) => model.installed);
  if (installed) return installed;
  if (preferred) return preferred;
  return models.find((model) => model.id === "base") ?? models[0] ?? null;
}

/** Turbo was trained for transcription only — silently drop translate for it. */
export function effectiveTranslate(
  translate: boolean,
  model: DictationModelInfo | null,
): boolean {
  return translate && model?.supportsTranslate === true;
}

/** Merge a `dictation:model-progress` event into the catalog snapshot. */
export function applyModelProgress(
  models: DictationModelInfo[],
  progress: DictationModelProgress,
): DictationModelInfo[] {
  return models.map((model) => {
    if (model.id !== progress.modelId) return model;
    switch (progress.phase) {
      case "downloading":
      case "verifying":
        return {
          ...model,
          downloading: true,
          partialBytes: progress.downloadedBytes,
        };
      case "done":
        return {
          ...model,
          downloading: false,
          installed: true,
          partialBytes: 0,
        };
      case "cancelled":
      case "failed":
        return {
          ...model,
          downloading: false,
          partialBytes: progress.downloadedBytes,
        };
    }
  });
}

export function downloadPercent(progress: DictationModelProgress): number {
  if (progress.totalBytes <= 0) return 0;
  return Math.min(
    100,
    Math.floor((progress.downloadedBytes / progress.totalBytes) * 100),
  );
}

// ── Session events ──────────────────────────────────────────────────────────

export type SessionEventOutcome =
  | { kind: "ignored" }
  | { kind: "recording" }
  | { kind: "finished" }
  | { kind: "cancelled" }
  | { kind: "error"; error: string };

/** Guard every `dictation:session` event by the live session id — events from
 * a stale session (e.g. one started by another composer) never touch this UI. */
export function reduceSessionEvent(
  sessionId: number | null,
  event: DictationSessionEvent,
): SessionEventOutcome {
  if (sessionId == null || event.sessionId !== sessionId) {
    return { kind: "ignored" };
  }
  switch (event.state) {
    case "recording":
      return { kind: "recording" };
    case "finished":
      return { kind: "finished" };
    case "cancelled":
      return { kind: "cancelled" };
    case "error":
      return { kind: "error", error: event.error ?? "Dictation failed" };
  }
}

// ── Draft text flow ─────────────────────────────────────────────────────────

/** The span of the draft the current session inserted: `[start, end)` char
 * offsets into the textarea value. */
export type DictationRange = { start: number; end: number };

/** `committed` is stable text, `partial` is the trailing provisional window —
 * join them the way the session worker joins segments. */
export function dictationDraftText(committed: string, partial: string): string {
  const head = committed.trim();
  const tail = partial.trim();
  if (!tail) return head;
  return head ? `${head} ${tail}` : tail;
}

/** Minimal changed span between two drafts via common prefix/suffix. */
export function draftEditSpan(
  prev: string,
  next: string,
): { start: number; prevEnd: number; nextEnd: number } {
  let start = 0;
  const shared = Math.min(prev.length, next.length);
  while (start < shared && prev[start] === next[start]) start += 1;
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (
    prevEnd > start &&
    nextEnd > start &&
    prev[prevEnd - 1] === next[nextEnd - 1]
  ) {
    prevEnd -= 1;
    nextEnd -= 1;
  }
  return { start, prevEnd, nextEnd };
}

/** Move a tracked dictation range across a user edit to the draft. Edits
 * before the range shift it, edits inside it are absorbed (the next partial or
 * the final result rewrites them), edits after it leave it alone. */
export function adjustDictationRange(
  range: DictationRange,
  prev: string,
  next: string,
): DictationRange {
  const edit = draftEditSpan(prev, next);
  if (edit.prevEnd <= range.start) {
    const delta = edit.nextEnd - edit.prevEnd;
    return { start: range.start + delta, end: range.end + delta };
  }
  if (edit.start >= range.end) return range;
  return {
    start: Math.min(range.start, edit.start),
    end: edit.nextEnd + Math.max(0, range.end - edit.prevEnd),
  };
}

/** User edits inside the dictated span take ownership of that text. Only
 * edits wholly outside it may move the anchor for subsequent transcription. */
export function alignDictationRange(
  range: DictationRange,
  prev: string,
  next: string,
): DictationRange | null {
  if (prev === next) return range;
  const edit = draftEditSpan(prev, next);
  if (
    range.start === range.end &&
    edit.start <= range.start &&
    edit.prevEnd >= range.end
  )
    return null;
  if (edit.prevEnd <= range.start || edit.start >= range.end)
    return adjustDictationRange(range, prev, next);
  return null;
}

/** Splice `text` into `value` at `range`; the result's range covers exactly
 * the inserted text. */
export function spliceDictationText(
  value: string,
  range: DictationRange,
  text: string,
): { value: string; range: DictationRange } {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end > value.length
  )
    throw new Error("Dictation draft range is no longer valid.");
  return {
    value: value.slice(0, range.start) + text + value.slice(range.end),
    range: { start: range.start, end: range.start + text.length },
  };
}

/** Where the caret lands after a splice: keep it when it sits outside the
 * replaced span, shift it by the size delta when after, park it at the end of
 * the inserted text when it was inside. */
export function caretAfterSplice(
  caret: number,
  range: DictationRange,
  insertedLength: number,
): number {
  if (caret <= range.start) return caret;
  if (caret >= range.end) {
    return caret + insertedLength - (range.end - range.start);
  }
  return range.start + insertedLength;
}

/** Recover only an unambiguous dictated span. A missing or duplicated span
 * means ownership was lost: the caller must stop writing, never clamp over
 * unrelated text or insert a late result into a cleared/new draft. */
export function reanchorDictationRange(
  value: string,
  range: DictationRange,
  expected: string,
): DictationRange | null {
  const valid =
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end >= range.start &&
    range.end <= value.length;
  if (valid && value.slice(range.start, range.end) === expected) return range;
  if (!expected) return null;
  const at = value.indexOf(expected);
  if (at < 0 || value.indexOf(expected, at + 1) >= 0) return null;
  return { start: at, end: at + expected.length };
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** `m:ss` elapsed label for the recording chip. */
export function formatElapsed(audioMs: number): string {
  const total = Math.floor(audioMs / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Decimal MB/GB label for model rows (`148 MB`, `1.5 GB`). */
export function formatModelSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
