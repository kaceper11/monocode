import { useCallback, useEffect, useRef, useState } from "react";
import { resizeComposer } from "../lib/composerResize";
import {
  adjustDictationRange,
  applyModelProgress,
  caretAfterSplice,
  dictationCancel,
  dictationCatalog,
  dictationDraftText,
  dictationModelCancelDownload,
  dictationModelInstall,
  dictationModelRemove,
  dictationOpenMicSettings,
  dictationRequestMicPermission,
  dictationStart,
  dictationStatus,
  dictationStop,
  effectiveTranslate,
  errorMessage,
  formatElapsed,
  isMicAccessError,
  isMicNotDetermined,
  isNoSessionError,
  isSessionBusyError,
  listenDictationModelProgress,
  listenDictationPartial,
  listenDictationSession,
  loadDictationPrefs,
  micPermissionAction,
  reanchorDictationRange,
  reduceSessionEvent,
  resolveDictationModel,
  saveDictationPrefs,
  spliceDictationText,
  type DictationModelInfo,
  type DictationModelProgress,
  type DictationPrefs,
  type DictationRange,
  type DictationSessionEvent,
  type MicPermission,
} from "../lib/dictation";

export type DictationPhase = "idle" | "starting" | "recording" | "finishing";

/** The span of the draft the live session inserted and keeps rewriting. */
type SessionTrack = {
  id: number;
  range: DictationRange;
  /** The dictated text currently occupying `range` (includes pads). */
  text: string;
  /** Text that occupied the anchor before dictation — a replaced selection.
   *  Cancel restores it rather than deleting text dictation never wrote. */
  original: string;
  /** Trailing chars of `text` still provisional (dimmed in the highlight). */
  partialLen: number;
  /** Separators inserted once at the anchor so dictation doesn't jam onto
   * neighbouring text — kept inside the range so rewrites preserve them. */
  padBefore?: string;
  padAfter?: string;
};

export type Dictation = ReturnType<typeof useDictation>;

/**
 * Composer-side dictation session: owns the model catalog, preferences,
 * backend event subscriptions and the splice of committed+partial text into
 * the draft. Dictated text lands in the draft only — sending stays manual.
 */
export function useDictation({
  textareaRef,
  draft,
  commitDraft,
}: {
  textareaRef: { current: HTMLTextAreaElement | null };
  /** Latest draft value; the hook keeps the tracked range aligned with it. */
  draft: string;
  /** Writes a programmatic draft value (dictation text) into composer state. */
  commitDraft: (value: string) => void;
}) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [sessionActive, setSessionActive] = useState(false);
  const [audioMs, setAudioMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);
  const [micPermission, setMicPermission] =
    useState<MicPermission>("unknown");
  const [catalog, setCatalog] = useState<DictationModelInfo[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [progress, setProgress] = useState<
    Record<string, DictationModelProgress>
  >({});
  const [prefs, setPrefs] = useState<DictationPrefs>(loadDictationPrefs);
  const [menuOpen, setMenuOpenState] = useState(false);
  const [dim, setDim] = useState<DictationRange | null>(null);

  const sessionRef = useRef<SessionTrack | null>(null);
  /** A session event that arrived before `dictation_start` resolved. */
  const pendingEventRef = useRef<DictationSessionEvent | null>(null);
  /** Last draft value the hook has seen or written. */
  const valueRef = useRef(draft);
  const startedAtRef = useRef(0);
  /** Set once the session is gone for good — unmounted mid-start must not
   * leave a live recording behind. */
  const aliveRef = useRef(true);
  /** This composer's own `dictation_stop` is in flight — a "finished" event
   * then belongs to it; otherwise it means the session ended externally. */
  const stoppingRef = useRef<number | null>(null);
  /** Hold-to-talk released while the session was still starting. */
  const releaseRequestedRef = useRef(false);
  const commitRef = useRef(commitDraft);
  commitRef.current = commitDraft;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /** Authoritative catalog — patched by progress events even while the menu
   * is closed so a mic press never starts from stale install flags. */
  const catalogRef = useRef<DictationModelInfo[] | null>(null);
  const setCatalogLive = useCallback(
    (next: DictationModelInfo[] | null) => {
      catalogRef.current = next;
      setCatalog(next);
    },
    [],
  );
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;

  const clearSession = useCallback(() => {
    sessionRef.current = null;
    setSessionActive(false);
    setAudioMs(0);
    setDim(null);
    setPhase("idle");
  }, []);

  /** Splice `text` over the tracked range. A caret parked at the range's end
   * follows the growing transcript; a caret elsewhere stays put. */
  const writeDictation = useCallback(
    (text: string, partialLen: number) => {
      const el = textareaRef.current;
      const session = sessionRef.current;
      if (!el || !session) return;
      const range = reanchorDictationRange(
        el.value,
        session.range,
        session.text,
      );
      if (
        session.padBefore !== undefined &&
        !(
          session.text.startsWith(session.padBefore) &&
          session.text.endsWith(session.padAfter ?? "")
        )
      ) {
        // An external edit ate a pad — recompute against live neighbours.
        session.padBefore = undefined;
      }
      if (session.padBefore === undefined) {
        const before = range.start > 0 ? el.value[range.start - 1] : undefined;
        const after = range.end < el.value.length ? el.value[range.end] : undefined;
        session.padBefore = before != null && !/\s/.test(before) ? " " : "";
        session.padAfter = after != null && !/\s/.test(after) ? " " : "";
      }
      const padBefore = session.padBefore ?? "";
      const padAfter = session.padAfter ?? "";
      const padAfterLen = padAfter.length;
      // An empty transcript writes nothing — no stray separator spaces.
      const insert = text === "" ? "" : padBefore + text + padAfter;
      const selStart = el.selectionStart ?? 0;
      const selEnd = el.selectionEnd ?? selStart;
      // The parked "following" caret sits just before padAfter — treat that
      // position as following too, or the caret oscillates one char per
      // partial.
      const following =
        selStart === selEnd &&
        (selStart === range.end || selStart === range.end - padAfterLen);
      const next = spliceDictationText(el.value, range, insert);
      el.value = next.value;
      resizeComposer(el);
      const caret = following
        ? next.range.end - padAfterLen
        : caretAfterSplice(selStart, range, insert.length);
      el.setSelectionRange(caret, caret);
      session.range = next.range;
      session.text = insert;
      session.partialLen = partialLen;
      valueRef.current = next.value;
      const dimEnd = next.range.end - padAfterLen;
      setDim(
        partialLen > 0
          ? { start: dimEnd - partialLen, end: dimEnd }
          : null,
      );
      commitRef.current(next.value);
    },
    [textareaRef],
  );

  /** Drop the dictated span — cancel discards the transcript and restores
   * whatever the session anchored over (a replaced selection). */
  const eraseDictated = useCallback(() => {
    const el = textareaRef.current;
    const session = sessionRef.current;
    if (el && session) {
      const range = reanchorDictationRange(
        el.value,
        session.range,
        session.text,
      );
      const selStart = el.selectionStart ?? 0;
      const next = spliceDictationText(el.value, range, session.original);
      el.value = next.value;
      resizeComposer(el);
      const caret = caretAfterSplice(selStart, range, session.original.length);
      el.setSelectionRange(caret, caret);
      valueRef.current = next.value;
      commitRef.current(next.value);
    }
    clearSession();
  }, [textareaRef, clearSession]);

  // Keep the tracked range aligned across edits and programmatic writes that
  // bypass the textarea's input event (submit clears, skill/quote inserts).
  useEffect(() => {
    const prev = valueRef.current;
    if (draft === prev) return;
    valueRef.current = draft;
    const session = sessionRef.current;
    if (!session) return;
    session.range = adjustDictationRange(session.range, prev, draft);
    // The slice may now include user edits — remember it so the next partial
    // reanchors as a no-op and rewrites the span wholesale.
    session.text = draft.slice(session.range.start, session.range.end);
    if (session.partialLen > 0) {
      session.partialLen = 0;
      setDim(null);
    }
  }, [draft]);

  const refreshCatalog = useCallback(async () => {
    try {
      setCatalogLive(await dictationCatalog());
      setCatalogFailed(false);
    } catch {
      // Leave the stale snapshot; the menu offers a retry when empty.
      setCatalogFailed(true);
    }
  }, [setCatalogLive]);

  const applySessionEvent = useCallback(
    (event: DictationSessionEvent) => {
      const outcome = reduceSessionEvent(
        sessionRef.current?.id ?? null,
        event,
      );
      if (outcome.kind === "ignored") {
        // The worker emits "recording" after engine load, which can beat the
        // start command's resolution — hold it for begin() to replay once
        // the session id is known.
        if (phaseRef.current === "starting" && !sessionRef.current) {
          pendingEventRef.current = event;
        }
        return;
      }
      switch (outcome.kind) {
        case "recording":
          setPhase("recording");
          return;
        case "finished":
          // The dictation_stop promise applies the final transcript — but
          // only when this composer called stop; a "finished" for a session
          // nobody here stopped means the session ended externally and
          // nothing more is coming.
          if (stoppingRef.current === event.sessionId) {
            setPhase("finishing");
          } else {
            clearSession();
          }
          return;
        case "cancelled":
          // Our own cancel() erases the span and clears the session before
          // this event lands, so reaching here means another composer took
          // over the mic — keep the text partials already wrote.
          clearSession();
          return;
        case "error":
          // Keep whatever text partials already landed — it is real
          // transcription the user may still want.
          setError(outcome.error);
          setMicBlocked(isMicAccessError(outcome.error));
          clearSession();
          return;
      }
    },
    [clearSession],
  );

  // Backend listeners live for the component's lifetime; events only fire
  // while a session or download is active so the cost is a registration.
  useEffect(() => {
    let disposed = false;
    // StrictMode remounts: an earlier cleanup must not poison this mount.
    aliveRef.current = true;
    const unlisten: (() => void)[] = [];
    const track = (pending: Promise<() => void>) => {
      void pending
        .then((fn) => (disposed ? fn() : unlisten.push(fn)))
        .catch(() => undefined);
    };

    track(
      listenDictationPartial((payload) => {
        const session = sessionRef.current;
        if (!session || payload.sessionId !== session.id) return;
        setAudioMs(payload.audioMs);
        writeDictation(
          dictationDraftText(payload.committed, payload.partial),
          payload.partial.trim().length,
        );
      }),
    );

    track(listenDictationSession(applySessionEvent));

    track(
      listenDictationModelProgress((event) => {
        // Keep the ref fresh even with the menu closed — a mic press or a
        // later menu open must see the finished install, not stale flags.
        if (catalogRef.current) {
          catalogRef.current = applyModelProgress(catalogRef.current, event);
        }
        // Progress fires every ~250 ms during a download — only re-render
        // while the menu can show it; opening the menu refetches anyway.
        if (!menuOpenRef.current) return;
        if (catalogRef.current) setCatalog(catalogRef.current);
        setProgress((prev) => ({ ...prev, [event.modelId]: event }));
        if (event.phase === "failed" && event.error) {
          setError(event.error);
        }
      }),
    );

    // Other composers may legitimately own a live session (split panes), so
    // an active status is left alone — a mic press here takes over instead.
    void dictationStatus()
      .then((status) => setMicPermission(status.micPermission))
      .catch(() => undefined);

    return () => {
      disposed = true;
      aliveRef.current = false;
      for (const fn of unlisten) fn();
      if (sessionRef.current) {
        const id = sessionRef.current.id;
        sessionRef.current = null;
        void dictationCancel(id).catch(() => undefined);
      }
    };
  }, [writeDictation, clearSession, applySessionEvent]);

  // Mic permission can change in System Settings while the menu sits open —
  // re-check when the window regains focus.
  useEffect(() => {
    if (!menuOpen) return;
    const onFocus = () => {
      void dictationStatus()
        .then((status) => setMicPermission(status.micPermission))
        .catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [menuOpen]);

  const begin = useCallback(async () => {
    // Always refetch — install state can change while the menu is closed
    // (a download finishing in the background is exactly that case).
    const models = await dictationCatalog().catch(() => catalogRef.current);
    if (models) {
      setCatalogLive(models);
      setCatalogFailed(false);
    }
    const model = resolveDictationModel(models ?? [], prefsRef.current.modelId);
    if (!model?.installed) {
      // First use: no model on disk — open the menu to pick/download one
      // rather than kicking off a surprise multi-hundred-MB download.
      setPhase("idle");
      setMenuOpenState(true);
      void refreshCatalog();
      void dictationStatus()
        .then((status) => setMicPermission(status.micPermission))
        .catch(() => undefined);
      return;
    }
    // Read the caret late — the catalog fetch above can take a beat. Dictate
    // at the caret while the field is focused; pressing the mic with focus
    // elsewhere appends at the draft's end instead of offset 0. An active
    // selection is replaced by the dictated text.
    const el = textareaRef.current;
    const focused = el != null && document.activeElement === el;
    const anchorStart = el
      ? focused
        ? (el.selectionStart ?? el.value.length)
        : el.value.length
      : 0;
    const anchorEnd =
      el && focused ? (el.selectionEnd ?? anchorStart) : anchorStart;
    const started = await dictationStart(
      model.id,
      prefsRef.current.language,
      effectiveTranslate(prefsRef.current.translate, model),
    );
    if (!aliveRef.current) {
      // Unmounted while the backend started — don't leave a live mic behind.
      void dictationCancel(started.sessionId).catch(() => undefined);
      return;
    }
    startedAtRef.current = Date.now();
    const original = el?.value.slice(anchorStart, anchorEnd) ?? "";
    sessionRef.current = {
      id: started.sessionId,
      range: { start: anchorStart, end: anchorEnd },
      text: original,
      original,
      partialLen: 0,
    };
    setSessionActive(true);
    setAudioMs(0);
    if (releaseRequestedRef.current) {
      // Hold-to-talk released before the session came up — cancel right away.
      releaseRequestedRef.current = false;
      const id = started.sessionId;
      sessionRef.current = null;
      setSessionActive(false);
      setPhase("idle");
      void dictationCancel(id).catch(() => undefined);
      return;
    }
    // Replay a session event that beat the start resolution (the worker's
    // "recording" lands after engine load but can outrun the invoke reply).
    const pending = pendingEventRef.current;
    pendingEventRef.current = null;
    if (pending) applySessionEvent(pending);
    // Stay "starting" until the worker's recording event — engine load for
    // the larger models can take seconds.
  }, [textareaRef, applySessionEvent, refreshCatalog, setCatalogLive]);

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    setPhase("starting");
    setError(null);
    setMicBlocked(false);
    releaseRequestedRef.current = false;
    let failure: unknown;
    try {
      await begin();
      return;
    } catch (err) {
      failure = err;
    }
    if (isSessionBusyError(failure)) {
      // Another composer (or a session orphaned by a reload) holds the mic.
      // Pressing dictate here is explicit intent to take over — cancel it
      // and retry once; its composer keeps the text partials already wrote.
      await dictationCancel().catch(() => undefined);
      try {
        await begin();
        return;
      } catch (err) {
        failure = err;
      }
    }
    if (isMicNotDetermined(failure)) {
      const permission = await dictationRequestMicPermission().catch(
        () => "unknown" as MicPermission,
      );
      setMicPermission(permission);
      if (micPermissionAction(permission) !== "retry") {
        setMicBlocked(true);
        setError(
          "Microphone access is off — allow it in System Settings to dictate.",
        );
        setPhase("idle");
        return;
      }
      try {
        await begin();
        return;
      } catch (err) {
        failure = err;
      }
    }
    if (isMicNotDetermined(failure) || isMicAccessError(failure)) {
      // The TCC prompt was dismissed or access is off — friendly message,
      // not the raw sentinel string.
      setMicBlocked(true);
      setError(
        "Microphone access is off — allow it in System Settings to dictate.",
      );
    } else if (isSessionBusyError(failure)) {
      // Cancel + retry still found the host finishing — the previous
      // session is winding down, not stuck; say so instead of echoing the
      // raw busy string.
      setError("Dictation is still stopping — try again in a moment.");
    } else if (errorMessage(failure) !== "cancelled") {
      // "cancelled" means a takeover aborted our in-flight start — nothing
      // to show.
      setError(errorMessage(failure));
    }
    setPhase("idle");
  }, [begin]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    // Re-entrant stop (double-click, release after toggle) would lose the
    // final transcript — the second call's finally clears the session before
    // the first's result lands.
    if (!session || stoppingRef.current != null) return;
    setPhase("finishing");
    stoppingRef.current = session.id;
    try {
      const result = await dictationStop(session.id);
      if (sessionRef.current === session) {
        writeDictation(result.text, 0);
        const notices = [
          result.droppedAudioMs > 0
            ? `The first ${formatElapsed(result.droppedAudioMs)} ran past the audio buffer and isn't in the transcript.`
            : null,
          result.streamError ?? null,
        ].filter(Boolean);
        if (notices.length) setError(notices.join(" "));
      }
    } catch (err) {
      // A cancel during the final pass rejects stop with "cancelled", and a
      // take-over rejects with "No dictation in progress" — neither is a
      // failure worth showing; the cancelled event clears the session.
      if (
        sessionRef.current === session &&
        errorMessage(err) !== "cancelled" &&
        !isNoSessionError(err)
      ) {
        setError(errorMessage(err));
      }
    } finally {
      stoppingRef.current = null;
      if (sessionRef.current === session) clearSession();
    }
  }, [writeDictation, clearSession]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    if (!session) {
      // Still starting (no session yet) — flag it so begin() cancels the
      // session the moment dictation_start resolves, same as a hold release.
      // The chip can't wait for that: a hung capture-open can take the full
      // start timeout, so clear the UI now.
      if (phaseRef.current === "starting") {
        releaseRequestedRef.current = true;
        clearSession();
      }
      return;
    }
    eraseDictated();
    void dictationCancel(session.id).catch(() => undefined);
  }, [eraseDictated, clearSession]);

  const toggle = useCallback(() => {
    if (phaseRef.current === "idle") void start();
    else if (phaseRef.current === "recording") void stop();
  }, [start, stop]);

  /** Hold-to-talk: key/button went down. */
  const press = useCallback(() => {
    if (phaseRef.current === "idle") void start();
  }, [start]);

  /** Hold-to-talk: key/button came back up. */
  const release = useCallback(() => {
    if (phaseRef.current === "recording") {
      void stop();
    } else if (phaseRef.current === "starting") {
      if (sessionRef.current) cancel();
      else releaseRequestedRef.current = true;
    }
  }, [stop, cancel]);

  const setMenuOpen = useCallback(
    (open: boolean) => {
      setMenuOpenState(open);
      if (!open) return;
      // Show the freshest snapshot immediately — progress events keep the
      // ref patched even while the menu is closed.
      if (catalogRef.current) setCatalog(catalogRef.current);
      void refreshCatalog();
      void dictationStatus()
        .then((status) => setMicPermission(status.micPermission))
        .catch(() => undefined);
    },
    [refreshCatalog],
  );

  const updatePrefs = useCallback((next: DictationPrefs) => {
    setPrefs(next);
    saveDictationPrefs(next);
  }, []);

  const installModel = useCallback(
    (modelId: string) => {
      void dictationModelInstall(modelId)
        .then(refreshCatalog)
        .catch((err: unknown) => setError(errorMessage(err)));
    },
    [refreshCatalog],
  );

  const cancelDownload = useCallback(
    (modelId: string) => {
      void dictationModelCancelDownload(modelId)
        .catch(() => undefined)
        // Refresh even on failure ("No download in progress") so a stale
        // downloading flag doesn't linger.
        .then(refreshCatalog);
    },
    [refreshCatalog],
  );

  const removeModel = useCallback(
    (modelId: string) => {
      void dictationModelRemove(modelId)
        .then(refreshCatalog)
        .catch((err: unknown) => setError(errorMessage(err)));
    },
    [refreshCatalog],
  );

  const openMicSettings = useCallback(() => {
    void dictationOpenMicSettings().catch(() => undefined);
  }, []);

  const dismissError = useCallback(() => {
    setError(null);
    setMicBlocked(false);
  }, []);

  return {
    phase,
    sessionActive,
    audioMs,
    startedAt: startedAtRef.current,
    error,
    micBlocked,
    micPermission,
    catalog,
    catalogFailed,
    progress,
    prefs,
    menuOpen,
    dim,
    toggle,
    press,
    release,
    stop,
    cancel,
    setMenuOpen,
    selectModel: (modelId: string) => updatePrefs({ ...prefs, modelId }),
    selectLanguage: (language: string | null) =>
      updatePrefs({ ...prefs, language }),
    setTranslate: (translate: boolean) =>
      updatePrefs({ ...prefs, translate }),
    setMode: (mode: DictationPrefs["mode"]) =>
      updatePrefs({ ...prefs, mode }),
    installModel,
    cancelDownload,
    removeModel,
    refreshCatalog,
    openMicSettings,
    dismissError,
  };
}
