/**
 * In-app replacements for the native `ask`/`message` sheets — same async
 * contract as @tauri-apps/plugin-dialog, rendered through the app's Modal so
 * they inherit its theme, Esc/backdrop handling and stacking instead of
 * dropping into OS chrome. Requests queue and are answered one at a time,
 * matching the serialized nature of the native dialogs they replace.
 */
export type DialogKind = "info" | "warning" | "error";

export type DialogOptions = {
  title?: string;
  kind?: DialogKind;
  okLabel?: string;
  cancelLabel?: string;
};

export type DialogRequest = {
  id: number;
  /** confirm = Cancel/OK buttons, notice = a single dismiss button. */
  mode: "confirm" | "notice";
  text: string;
  title: string;
  kind: DialogKind;
  okLabel: string;
  cancelLabel: string;
  /** Idempotent — the host may resolve a request exactly once. `null` marks
   * a bare dismiss (Esc/backdrop/close button) rather than the Cancel action —
   * most callers only care about falsy-vs-true, but a request whose Cancel
   * label does real work (e.g. "Rebase instead…") can tell them apart. */
  settle: (ok: boolean | null) => void;
};

const APP_DIALOGS_CHANGED = "monocode:app-dialogs";

const pending = new Map<number, DialogRequest>();
let snapshot: readonly DialogRequest[] = [];
let nextId = 1;

const emit = () => {
  snapshot = [...pending.values()];
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(APP_DIALOGS_CHANGED));
};

export const appDialogSnapshot = () => snapshot;

export function subscribeAppDialogs(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(APP_DIALOGS_CHANGED, listener);
  return () => window.removeEventListener(APP_DIALOGS_CHANGED, listener);
}

function push(
  mode: DialogRequest["mode"],
  text: string,
  options?: DialogOptions,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const id = nextId++;
    let done = false;
    pending.set(id, {
      id,
      mode,
      text,
      title: options?.title ?? "MonoCode",
      kind: options?.kind ?? "info",
      okLabel: options?.okLabel ?? "OK",
      cancelLabel: options?.cancelLabel ?? "Cancel",
      settle: (ok) => {
        if (done) return;
        done = true;
        pending.delete(id);
        emit();
        resolve(ok);
      },
    });
    emit();
  });
}

/** Resolves true on OK, false on the Cancel action, null when dismissed
 * (Esc/backdrop/X) — like `ask`, with a distinct bare-dismiss answer. */
export function ask(
  text: string,
  options?: DialogOptions,
): Promise<boolean | null> {
  return push("confirm", text, options);
}

/** Resolves once dismissed — matching `message`. */
export async function message(
  text: string,
  options?: DialogOptions,
): Promise<void> {
  await push("notice", text, options);
}
