import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { resizeComposer } from "../model/composerResize";
import {
  alignDictationRange,
  applyModelProgress,
  caretAfterSplice,
  dictationCancel,
  dictationCatalog,
  dictationDraftText,
  dictationModelCancelDownload,
  dictationModelInstall,
  dictationModelRemove,
  dictationOpenMicSettings,
  dictationPrepare,
  dictationRequestMicPermission,
  dictationStart,
  dictationStatus,
  dictationStop,
  effectiveTranslate,
  errorMessage,
  isMicAccessError,
  isMicNotDetermined,
  isSessionBusyError,
  listenDictationModelProgress,
  listenDictationPartial,
  listenDictationSession,
  loadDictationPrefs,
  saveDictationPrefs,
  resolveDictationModel,
  spliceDictationText,
  type DictationModelInfo,
  type DictationModelProgress,
  type DictationPrefs,
  type DictationRange,
  type MicPermission,
} from "../model/dictation";

export type DictationPhase = "idle" | "starting" | "recording" | "finishing";
type Attempt = {
  owner: string;
  id: number | null;
  range: DictationRange;
  value: string;
  text: string;
  original: string;
  seq: number;
  stopping: boolean;
  unlisten: (() => void)[];
  padBefore?: string;
  padAfter?: string;
};
export type Dictation = ReturnType<typeof useDictation>;

/** Dictation owns only a span of the selected draft. Sending, providers and
 * session persistence remain under the upstream composer's ownership. */
export function useDictation({
  textareaRef,
  draft,
  commitDraft,
  owner,
  enabled,
}: {
  textareaRef: { current: HTMLTextAreaElement | null };
  draft: string;
  commitDraft: (value: string) => void;
  owner: string;
  enabled: boolean;
}) {
  const [phase, setPhaseState] = useState<DictationPhase>("idle");
  const phaseRef = useRef<DictationPhase>("idle");
  const setPhase = useCallback((next: DictationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);
  const [audioMs, setAudioMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [micPermission, setMicPermission] = useState<MicPermission>("unknown");
  const [catalog, setCatalog] = useState<DictationModelInfo[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [progress, setProgress] = useState<
    Record<string, DictationModelProgress>
  >({});
  const [prefs, setPrefs] = useState<DictationPrefs>(loadDictationPrefs);
  const [menuOpen, setMenuOpenState] = useState(false);
  const [dim, setDim] = useState<DictationRange | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const startedAt = useRef(0);
  const current = useRef({ owner, enabled, commitDraft, prefs });
  current.current = { owner, enabled, commitDraft, prefs };
  const catalogRequest = useRef(0);
  const valid = useCallback(
    (op: Attempt) =>
      mounted.current &&
      current.current.enabled &&
      current.current.owner === op.owner &&
      attempt.current === op,
    [],
  );

  const detach = useCallback(() => {
    const op = attempt.current;
    attempt.current = null;
    if (op) {
      for (const off of op.unlisten) off();
      op.unlisten = [];
      if (op.id !== null) void dictationCancel(op.id).catch(() => undefined);
    }
    phaseRef.current = "idle";
    if (mounted.current) {
      setPhaseState("idle");
      setDim(null);
      setAudioMs(0);
    }
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    lifetime.current++;
    setPhase("idle");
    setDim(null);
    setAudioMs(0);
    setError(null);
    setMenuOpenState(false);
    return () => {
      mounted.current = false;
      lifetime.current++;
      detach();
    };
  }, [owner, enabled, detach, setPhase]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) detach();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [detach]);

  const align = useCallback(
    (op: Attempt, value: string) => {
      if (!valid(op)) return false;
      const range = alignDictationRange(op.range, op.value, value);
      if (!range || value.slice(range.start, range.end) !== op.text) {
        detach(); // Preserve the user's replacement; no later result owns it.
        return false;
      }
      op.range = range;
      op.value = value;
      return true;
    },
    [detach, valid],
  );

  useLayoutEffect(() => {
    const op = attempt.current;
    if (op) align(op, textareaRef.current?.value ?? draft);
  }, [draft, align, textareaRef]);

  const write = useCallback(
    (op: Attempt, text: string, partialLen: number, restore = false) => {
      const el = textareaRef.current;
      if (!el || !align(op, el.value)) return;
      const range = op.range;
      if (op.padBefore === undefined) {
        op.padBefore =
          range.start > 0 && !/\s/.test(el.value[range.start - 1]) ? " " : "";
        op.padAfter =
          range.end < el.value.length && !/\s/.test(el.value[range.end])
            ? " "
            : "";
      }
      const restoring = restore || !text;
      const after = restoring ? "" : (op.padAfter ?? "");
      const insert = restoring ? op.original : op.padBefore + text + after;
      const start = el.selectionStart,
        end = el.selectionEnd;
      const follows =
        start === end &&
        (start === range.end ||
          start === range.end - (op.padAfter?.length ?? 0));
      const next = spliceDictationText(el.value, range, insert);
      el.value = next.value;
      resizeComposer(el);
      el.setSelectionRange(
        follows
          ? next.range.end - after.length
          : caretAfterSplice(start, range, insert.length),
        follows
          ? next.range.end - after.length
          : caretAfterSplice(end, range, insert.length),
      );
      op.range = next.range;
      op.text = insert;
      op.value = next.value;
      const dimEnd = next.range.end - after.length;
      setDim(
        partialLen > 0 ? { start: dimEnd - partialLen, end: dimEnd } : null,
      );
      current.current.commitDraft(next.value);
    },
    [align, textareaRef],
  );

  const refreshCatalog = useCallback(async () => {
    const request = ++catalogRequest.current,
      life = lifetime.current;
    try {
      const models = await dictationCatalog();
      if (
        mounted.current &&
        lifetime.current === life &&
        request === catalogRequest.current
      ) {
        setCatalog(models);
        setCatalogFailed(false);
      }
    } catch {
      if (
        mounted.current &&
        lifetime.current === life &&
        request === catalogRequest.current
      )
        setCatalogFailed(true);
    }
  }, []);

  const refreshPermission = useCallback(async () => {
    const life = lifetime.current;
    try {
      const status = await dictationStatus();
      if (mounted.current && lifetime.current === life)
        setMicPermission(status.micPermission);
    } catch {
      /* The catalog and start paths surface actionable failures. */
    }
  }, []);

  // No catalog, permission IO or progress subscription for a closed idle control.
  useEffect(() => {
    if (!menuOpen) return;
    let disposed = false;
    let off: (() => void) | undefined;
    void listenDictationModelProgress((event) => {
      if (disposed) return;
      setCatalog((models) => models && applyModelProgress(models, event));
      setProgress((previous) => ({ ...previous, [event.modelId]: event }));
      if (event.phase === "failed" && event.error) setError(event.error);
      if (["done", "cancelled", "failed"].includes(event.phase))
        void refreshCatalog();
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      })
      .catch((err) => {
        if (!disposed) setError(errorMessage(err));
      });
    void refreshCatalog();
    void refreshPermission();
    window.addEventListener("focus", refreshPermission);
    return () => {
      disposed = true;
      off?.();
      window.removeEventListener("focus", refreshPermission);
    };
  }, [menuOpen, refreshCatalog, refreshPermission]);

  const start = useCallback(async () => {
    const el = textareaRef.current;
    if (
      !mounted.current ||
      !current.current.enabled ||
      phaseRef.current !== "idle" ||
      !el
    )
      return;
    const focused = document.activeElement === el;
    const range = {
      start: focused ? el.selectionStart : el.value.length,
      end: focused ? el.selectionEnd : el.value.length,
    };
    const op: Attempt = {
      owner: current.current.owner,
      id: null,
      range,
      value: el.value,
      text: el.value.slice(range.start, range.end),
      original: el.value.slice(range.start, range.end),
      seq: 0,
      stopping: false,
      unlisten: [],
    };
    const options = current.current.prefs;
    attempt.current = op;
    startedAt.current = Date.now();
    setPhase("starting");
    setError(null);
    setAudioMs(0);
    const track = async (pending: Promise<() => void>) => {
      const off = await pending;
      if (valid(op)) op.unlisten.push(off);
      else off();
    };
    try {
      const models = await dictationCatalog();
      if (!valid(op)) return;
      setCatalog(models);
      setCatalogFailed(false);
      const model = resolveDictationModel(models, options.modelId);
      if (!model?.installed) {
        detach();
        setMenuOpenState(true);
        return;
      }
      const status = await dictationStatus();
      if (!valid(op)) return;
      let permission = status.micPermission;
      if (permission === "not-determined")
        permission = await dictationRequestMicPermission();
      if (!valid(op)) return;
      setMicPermission(permission);
      if (permission === "denied" || permission === "restricted")
        throw new Error(
          "Microphone access is off — allow it in System Settings to dictate.",
        );
      await track(
        listenDictationPartial((payload) => {
          if (
            !valid(op) ||
            payload.sessionId !== op.id ||
            payload.seq <= op.seq
          )
            return;
          op.seq = payload.seq;
          setAudioMs(payload.audioMs);
          write(
            op,
            dictationDraftText(payload.committed, payload.partial),
            payload.partial.trim().length,
          );
        }),
      );
      if (!valid(op)) return;
      await track(
        listenDictationSession((event) => {
          if (!valid(op) || event.sessionId !== op.id) return;
          if (event.state === "recording") {
            if (!op.stopping) setPhase("recording");
            return;
          }
          if (event.state === "finished" && op.stopping) return;
          if (event.state === "error")
            setError(event.error ?? "Dictation failed");
          detach(); // A takeover keeps the existing partial text in this draft.
        }),
      );
      if (!valid(op)) return;
      let id: number;
      try {
        id = await dictationPrepare();
      } catch (err) {
        if (!valid(op) || !isSessionBusyError(err)) throw err;
        const observed = await dictationStatus();
        if (!valid(op)) return;
        if (observed.sessionId !== null)
          await dictationCancel(observed.sessionId, true);
        if (!valid(op)) return;
        id = await dictationPrepare();
      }
      if (!valid(op)) {
        void dictationCancel(id).catch(() => undefined);
        return;
      }
      op.id = id;
      if (!align(op, el.value)) return;
      const started = await dictationStart(
        id,
        model.id,
        options.language,
        effectiveTranslate(options.translate, model),
      );
      if (!valid(op)) {
        void dictationCancel(id).catch(() => undefined);
        return;
      }
      if (started.sessionId !== id)
        throw new Error("Dictation session identity changed");
      // The worker's recording event follows model loading; do not overwrite
      // a recording/error event that arrived before the start reply.
    } catch (err) {
      if (!valid(op)) return;
      const message = errorMessage(err);
      if (message !== "cancelled")
        setError(
          isMicNotDetermined(err)
            ? "Microphone permission was not granted. Try again to request access."
            : isSessionBusyError(err)
              ? "Dictation is still stopping — try again in a moment."
              : message,
        );
      detach();
    }
  }, [textareaRef, valid, setPhase, detach, write, align]);

  const stop = useCallback(async () => {
    const op = attempt.current;
    if (!op || !valid(op) || op.id === null || op.stopping) return;
    op.stopping = true;
    setPhase("finishing");
    try {
      const result = await dictationStop(op.id);
      if (!valid(op)) return;
      write(op, result.text, 0);
      if (valid(op) && result.streamError) setError(result.streamError);
    } catch (err) {
      if (valid(op) && errorMessage(err) !== "cancelled")
        setError(errorMessage(err));
    } finally {
      if (valid(op)) detach();
    }
  }, [valid, setPhase, write, detach]);

  const cancel = useCallback(() => {
    const op = attempt.current;
    if (op && valid(op)) write(op, op.original, 0, true);
    detach();
  }, [write, detach, valid]);
  const toggle = useCallback(() => {
    if (phaseRef.current === "idle") void start();
    else if (phaseRef.current === "recording") void stop();
  }, [start, stop]);
  const release = useCallback(() => {
    if (phaseRef.current === "recording") void stop();
    else if (phaseRef.current === "starting") cancel();
  }, [stop, cancel]);
  const updatePrefs = useCallback((next: DictationPrefs) => {
    try {
      saveDictationPrefs(next);
      current.current.prefs = next;
      setPrefs(next);
    } catch (err) {
      setError(`Could not save dictation settings: ${errorMessage(err)}`);
    }
  }, []);
  const modelAction = useCallback(
    async (action: () => Promise<void>) => {
      const life = lifetime.current;
      try {
        await action();
        if (mounted.current && lifetime.current === life)
          await refreshCatalog();
      } catch (err) {
        if (mounted.current && lifetime.current === life)
          setError(errorMessage(err));
      }
    },
    [refreshCatalog],
  );

  return {
    phase,
    sessionActive: phase !== "idle",
    audioMs,
    startedAt: startedAt.current,
    error,
    micBlocked: error !== null && isMicAccessError(error),
    micPermission,
    catalog,
    catalogFailed,
    progress,
    prefs,
    menuOpen,
    dim,
    toggle,
    press: () => {
      void start();
    },
    release,
    stop,
    cancel,
    // Called only after upstream accepts a submission; late results lose their draft.
    detach,
    setMenuOpen: (open: boolean) =>
      setMenuOpenState(open && current.current.enabled),
    selectModel: (modelId: string) =>
      updatePrefs({ ...current.current.prefs, modelId }),
    selectLanguage: (language: string | null) =>
      updatePrefs({ ...current.current.prefs, language }),
    setTranslate: (translate: boolean) =>
      updatePrefs({ ...current.current.prefs, translate }),
    setMode: (mode: DictationPrefs["mode"]) =>
      updatePrefs({ ...current.current.prefs, mode }),
    installModel: (id: string) => {
      void modelAction(() => dictationModelInstall(id));
    },
    cancelDownload: (id: string) => {
      void modelAction(() => dictationModelCancelDownload(id));
    },
    removeModel: (id: string) => {
      void modelAction(() => dictationModelRemove(id));
    },
    refreshCatalog,
    openMicSettings: () => {
      void modelAction(dictationOpenMicSettings);
    },
    dismissError: () => setError(null),
  };
}
