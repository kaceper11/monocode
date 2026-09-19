import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Languages,
  Loader,
  Mic,
  MicOff,
  Search,
  Square,
  Trash2,
  X,
} from "./icons";
import { Popover } from "./Popover";
import {
  dictationLanguageLabel,
  downloadPercent,
  filterDictationLanguages,
  formatElapsed,
  formatModelSize,
  resolveDictationModel,
  type DictationModelInfo,
  type DictationModelProgress,
} from "../lib/dictation";
import type { Dictation } from "./useDictation";
import { hotkeyBlockedByTarget } from "../lib/hotkeyTarget";
import { MOD, SHIFT } from "../lib/platform";

const TOOL_BUTTON =
  "grid size-6.5 shrink-0 place-items-center rounded-md bg-content/10 text-content/70 hover:bg-content/15 hover:text-content disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content/70";

const ROW_ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-md text-content/70 hover:bg-content/10 hover:text-content";

const SECTION_LABEL =
  "px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-content/70";

export function DictationError({ dictation }: { dictation: Dictation }) {
  if (!dictation.error) return null;
  return (
    <p
      role="alert"
      className="flex items-center gap-2 px-3 pt-2 text-xs text-red-400 in-[.theme-light]:text-red-700"
    >
      <span className="min-w-0 flex-1">{dictation.error}</span>
      {dictation.micBlocked && (
        <button
          type="button"
          onClick={dictation.openMicSettings}
          className="shrink-0 underline"
        >
          Open Settings
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss dictation error"
        onClick={dictation.dismissError}
        className={ROW_ICON_BUTTON}
      >
        <X className="size-3" />
      </button>
    </p>
  );
}

function ModelRow({
  model,
  selected,
  progress,
  dictation,
}: {
  model: DictationModelInfo;
  selected: boolean;
  progress: DictationModelProgress | undefined;
  dictation: Dictation;
}) {
  // The catalog flag is authoritative — progress events only flow while
  // the menu is open, so a stale "downloading" entry must not light up a
  // finished row.
  const downloading = model.downloading;
  const status = model.installed
    ? "installed"
    : progress?.phase === "failed"
      ? "download failed"
      : model.partialBytes > 0
        ? `${formatModelSize(model.partialBytes)} kept`
        : null;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => dictation.selectModel(model.id)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/10"
      >
        <span className="grid size-3.5 shrink-0 place-items-center">
          {selected ? <Check className="size-3 text-accent" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-4.5">
            {model.label}
          </span>
          <span className="block text-[11px] leading-4 text-content/70">
            {model.tier} · {formatModelSize(model.sizeBytes)}
            {status ? ` · ${status}` : ""}
          </span>
        </span>
      </button>
      {downloading ? (
        <>
          <span className="shrink-0 text-[11px] tabular-nums text-content/70">
            {progress?.phase === "verifying"
              ? "Verifying"
              : progress
                ? `${downloadPercent(progress)}%`
                : "…"}
          </span>
          <button
            type="button"
            title="Cancel download"
            aria-label={`Cancel ${model.label} download`}
            onClick={() => dictation.cancelDownload(model.id)}
            className={ROW_ICON_BUTTON}
          >
            <X className="size-3" />
          </button>
        </>
      ) : null}
      {!downloading && model.removable ? (
        <button
          type="button"
          title={`Remove ${model.label}`}
          aria-label={`Remove ${model.label}`}
          onClick={() => dictation.removeModel(model.id)}
          className={ROW_ICON_BUTTON}
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
      {!downloading && !model.installed ? (
        <button
          type="button"
          title={
            model.partialBytes > 0
              ? `Resume download — ${formatModelSize(model.partialBytes)} of ${formatModelSize(model.sizeBytes)} on disk`
              : `Download ${model.label} (${formatModelSize(model.sizeBytes)})`
          }
          aria-label={
            model.partialBytes > 0
              ? `Resume ${model.label} download`
              : `Download ${model.label}`
          }
          onClick={() => dictation.installModel(model.id)}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-content/70 hover:bg-content/10 hover:text-content"
        >
          <Download className="size-3.5" />
          {model.partialBytes > 0 || progress?.phase === "failed"
            ? "Resume"
            : null}
        </button>
      ) : null}
    </div>
  );
}

/** ⌘⇧M / Ctrl+Shift+M — press toggles in "toggle" mode, hold dictates in
 * "hold" mode. Listed in Settings → Keybindings; `code` keeps it
 * layout-independent. */
const DICTATION_HOTKEY_CODE = "KeyM";

/** Ticks the chip's elapsed label between partial events — kept here so the
 * 500 ms cadence re-renders only the control, not the whole composer. */
function useElapsedMs(phase: string, audioMs: number, startedAt: number) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (phase !== "starting" && phase !== "recording") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [phase]);
  // audioMs only advances on partial events (~1.5 s apart) — max() with the
  // wall clock keeps the chip ticking between them.
  return phase === "starting" || phase === "recording"
    ? Math.max(audioMs, now - startedAt)
    : 0;
}

/** Spoken-language picker: a compact row that expands into a filterable
 * list of whisper's multilingual set. Translate stays a separate toggle —
 * whisper.cpp can only translate *into* English regardless of source. */
function LanguageSection({ dictation }: { dictation: Dictation }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const languages = filterDictationLanguages(query);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setQuery("");
        }}
        className="mx-0.5 flex w-[calc(100%-4px)] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-content hover:bg-content/10"
      >
        <Languages className="size-3.5 shrink-0 text-content/70" />
        <span className="min-w-0 flex-1 text-[13px]">Spoken language</span>
        <span className="shrink-0 text-[11px] text-content/70">
          {dictationLanguageLabel(dictation.prefs.language)}
        </span>
        <ChevronRight
          className={`size-3 shrink-0 text-content/70 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div className="mx-0.5 mb-1 mt-0.5 overflow-hidden rounded-lg border border-content/10">
          <label className="flex h-7 items-center gap-2 border-b border-content/10 px-2 text-content/70">
            <Search className="size-3 shrink-0" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter"
              aria-label="Filter languages"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
            />
          </label>
          <div
            role="group"
            aria-label="Spoken languages"
            className="max-h-40 overflow-y-auto py-0.5"
          >
            {languages.length === 0 ? (
              <p className="px-2 py-1.5 text-[12px] text-content/70">
                No matching language
              </p>
            ) : (
              languages.map((language) => {
                const active = dictation.prefs.language === language.id;
                return (
                  <button
                    key={language.id ?? "auto"}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      dictation.selectLanguage(language.id);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-2 py-1 text-left text-[12.5px] text-content hover:bg-content/10"
                  >
                    <span className="grid size-3.5 shrink-0 place-items-center">
                      {active ? <Check className="size-3 text-accent" /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {language.label}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The composer's dictation affordance: a mic button that toggles or holds
 * recording, a status chip while a session runs, and a popover for
 * model/language/translate/mode settings. Session state lives in
 * `useDictation`; this is presentation.
 */
export function DictationControl({
  dictation,
  enabled,
  hotkeys = false,
}: {
  dictation: Dictation;
  enabled: boolean;
  hotkeys?: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const hold = dictation.prefs.mode === "hold";
  const elapsedMs = useElapsedMs(
    dictation.phase,
    dictation.audioMs,
    dictation.startedAt,
  );
  const selected = dictation.catalog
    ? resolveDictationModel(dictation.catalog, dictation.prefs.modelId)
    : null;
  const translateDisabled = selected != null && !selected.supportsTranslate;

  // ⌘⇧M dictates — toggle mode presses start/stop; hold mode runs while the
  // chord is held. Window-level so it works wherever focus sits in the pane.
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  /** True while a hotkey-started hold is down — a stray KeyM keyup (typing
   * "m" during a pointer hold) must not end it. */
  const hotkeyHoldRef = useRef(false);
  const pointerReleaseRef = useRef<(() => void) | null>(null);
  useEffect(() => () => pointerReleaseRef.current?.(), [enabled, hold]);
  useEffect(() => {
    if (!hotkeys || !enabled) return;
    const isHotkey = (event: KeyboardEvent) =>
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      !event.altKey &&
      event.code === DICTATION_HOTKEY_CODE;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        // Cancel an active (or still-starting) session — unless an overlay
        // owns this Escape.
        const current = dictationRef.current;
        if (
          (current.sessionActive || current.phase === "starting") &&
          !hotkeyBlockedByTarget(event.target)
        ) {
          event.preventDefault();
          event.stopPropagation();
          current.cancel();
        }
        return;
      }
      if (!isHotkey(event) || event.repeat) return;
      const current = dictationRef.current;
      if (current.phase === "idle" && hotkeyBlockedByTarget(event.target))
        return;
      event.preventDefault();
      event.stopPropagation();
      if (hold) {
        hotkeyHoldRef.current = true;
        current.press();
      } else {
        current.toggle();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      // Only a hold the hotkey itself started ends here — a stray "m" keyup
      // (or a chord modifier coming up) must not stop a pointer hold. Any
      // chord key releasing ends the hold.
      if (!hotkeyHoldRef.current) return;
      if (
        event.code !== DICTATION_HOTKEY_CODE &&
        event.key !== "Meta" &&
        event.key !== "Shift" &&
        event.key !== "Control"
      )
        return;
      hotkeyHoldRef.current = false;
      dictationRef.current.release();
    };
    // Releasing outside the window (or an app switch mid-hold) fires no
    // keyup/pointerup here — treat blur as the release.
    const onBlur = () => {
      hotkeyHoldRef.current = false;
      if (hold) dictationRef.current.release();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      // Pane focus changed mid-hold — treat as a release so the mic doesn't
      // keep recording while the keyup goes to another pane.
      hotkeyHoldRef.current = false;
      if (hold) dictationRef.current.release();
    };
  }, [hotkeys, hold, enabled]);

  const shortcut = `${MOD}${SHIFT}M`;
  const micTitle = hold
    ? `Hold to dictate (${shortcut})`
    : `Dictate (${shortcut})`;

  return (
    <div ref={anchor} className="flex shrink-0 items-center gap-1">
      {dictation.phase === "idle" ? (
        <button
          type="button"
          title={micTitle}
          aria-label={micTitle}
          disabled={!enabled}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={
            hold
              ? (event) => {
                  if (event.button !== 0) return;
                  pointerReleaseRef.current?.();
                  dictation.press();
                  // The button unmounts as soon as the phase changes, so the
                  // release has to be heard at window level.
                  const done = () => {
                    window.removeEventListener("pointerup", done, true);
                    window.removeEventListener("pointercancel", done, true);
                    window.removeEventListener("blur", done, true);
                    pointerReleaseRef.current = null;
                    dictationRef.current.release();
                  };
                  pointerReleaseRef.current = done;
                  window.addEventListener("pointerup", done, true);
                  window.addEventListener("pointercancel", done, true);
                  window.addEventListener("blur", done, true);
                }
              : undefined
          }
          onClick={(event) => {
            // In hold mode a mouse click already ran press+release; only
            // keyboard activation (detail 0) toggles so Enter/Space work.
            if (hold && event.detail !== 0) return;
            dictation.toggle();
          }}
          className={TOOL_BUTTON}
        >
          <Mic className="size-3.5" strokeWidth={1.5} />
        </button>
      ) : (
        <div
          role="status"
          aria-live="polite"
          className="flex h-6.5 items-center gap-1 rounded-md bg-red-500/15 pl-1.5 pr-0.5 text-[11px] text-red-300 in-[.theme-light]:text-red-700"
          data-dictation-recording
        >
          {dictation.phase === "recording" ? (
            <>
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-red-400"
              />
              <span className="shrink-0 tabular-nums">
                {formatElapsed(elapsedMs)}
              </span>
              <button
                type="button"
                title="Stop dictation"
                aria-label="Stop dictation"
                onClick={dictation.stop}
                className="grid size-5.5 shrink-0 place-items-center rounded hover:bg-red-400/20"
              >
                <Square className="size-2.5 fill-current" strokeWidth={0} />
              </button>
            </>
          ) : (
            <>
              <Loader
                className="size-3 shrink-0 animate-spin"
                strokeWidth={2}
              />
              <span className="shrink-0">
                {dictation.phase === "finishing" ? "Finishing…" : "Starting…"}
              </span>
            </>
          )}
          <button
            type="button"
            title="Cancel dictation"
            aria-label="Cancel dictation"
            onClick={dictation.cancel}
            className="grid size-5.5 shrink-0 place-items-center rounded hover:bg-red-400/20"
          >
            <X className="size-3" />
          </button>
        </div>
      )}
      <button
        type="button"
        title="Dictation settings"
        aria-label="Dictation settings"
        aria-haspopup="dialog"
        aria-expanded={dictation.menuOpen}
        disabled={!enabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => dictation.setMenuOpen(!dictation.menuOpen)}
        className={TOOL_BUTTON}
      >
        <ChevronDown
          className={`size-3 ${dictation.menuOpen ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {dictation.menuOpen ? (
        <Popover
          anchor={anchor}
          side="top"
          align="end"
          width={264}
          onDismiss={() => dictation.setMenuOpen(false)}
          role="dialog"
          aria-label="Dictation"
          data-dictation-menu
          className="p-1.5"
        >
          {dictation.micPermission === "denied" ||
          dictation.micPermission === "restricted" ? (
            <div className="mx-0.5 mb-1 flex items-center gap-2 rounded-lg bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300 in-[.theme-light]:text-red-700">
              <MicOff className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">Microphone access is off</span>
              <button
                type="button"
                onClick={dictation.openMicSettings}
                className="shrink-0 underline hover:text-red-200"
              >
                Open Settings
              </button>
            </div>
          ) : null}
          <p className={SECTION_LABEL}>Voice model</p>
          {dictation.catalog === null ? (
            <p className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-content/70">
              <span className="min-w-0 flex-1">
                {dictation.catalogFailed
                  ? "Couldn't load the model list"
                  : "Loading models…"}
              </span>
              {dictation.catalogFailed ? (
                <button
                  type="button"
                  onClick={dictation.refreshCatalog}
                  className="shrink-0 underline hover:text-content"
                >
                  Retry
                </button>
              ) : null}
            </p>
          ) : (
            dictation.catalog.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                selected={selected?.id === model.id}
                progress={dictation.progress[model.id]}
                dictation={dictation}
              />
            ))
          )}
          <LanguageSection dictation={dictation} />
          <p className={SECTION_LABEL}>Trigger · {shortcut}</p>
          <div className="flex gap-1 px-0.5 pb-0.5">
            {(
              [
                { id: "hold", label: "Hold to talk" },
                { id: "toggle", label: "Press to start" },
              ] as const
            ).map((mode) => {
              const active = dictation.prefs.mode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => dictation.setMode(mode.id)}
                  className={`flex-1 rounded-md px-2 py-1 text-[11px] ${
                    active
                      ? "bg-content/15 text-content"
                      : "text-content/70 hover:bg-content/10 hover:text-content"
                  }`}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
          <div className="mt-1 border-t border-content/10 pt-1">
            <button
              type="button"
              aria-pressed={dictation.prefs.translate}
              disabled={translateDisabled}
              title={
                translateDisabled
                  ? `${selected?.label ?? "This model"} cannot translate — pick a translate-capable model`
                  : "Translate speech to English — whisper only translates into English"
              }
              onClick={() => dictation.setTranslate(!dictation.prefs.translate)}
              className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-content hover:bg-content/10 disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Languages className="size-3.5 shrink-0 text-content/70" />
              <span className="min-w-0 flex-1">Translate to English</span>
              <span
                aria-hidden="true"
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  dictation.prefs.translate ? "bg-content/35" : "bg-content/15"
                }`}
              >
                <span
                  className={`absolute top-0.5 size-4 rounded-full bg-content shadow-sm transition-transform ${
                    dictation.prefs.translate
                      ? "translate-x-4.5"
                      : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
