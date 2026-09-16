import { X } from "./icons";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLockOverscroll } from "../hooks/useLockOverscroll";
import { LAYER, PopoverLayerOffset } from "../lib/layers";

export type ModalSize = "sm" | "md" | "lg";

/** Open dialogs in mount order — only the topmost answers Escape, so Esc in a
 * nested dialog (e.g. the WSL picker inside a sheet) never tears down the
 * dialog underneath. */
const openModals: symbol[] = [];

/** Timestamp of the last close→open swap — set by the closing modal's click
 * handler, read by the next modal at render time. */
let modalSwapAt = 0;
const MODAL_SWAP_MS = 400;

/** Call right before closing one modal to open another in the same gesture.
 * The replacement skips its entrance animation — replaying it would flash
 * the screen undimmed for a frame between the two backdrops. */
export function modalSwap() {
  modalSwapAt = Date.now();
}

const WIDTH: Record<ModalSize, string> = {
  sm: "w-[min(420px,calc(100vw-24px))]",
  md: "w-[min(560px,calc(100vw-24px))]",
  lg: "w-[min(680px,calc(100vw-24px))]",
};

const TOP: Record<ModalSize, string> = {
  sm: "top-[22%]",
  md: "top-[10%]",
  lg: "top-[6%]",
};

/** Hard ceiling: top offset plus 24px of bottom breathing room, so no dialog
 * can grow past the viewport even when callers forget a max-height. */
const MAX_H: Record<ModalSize, string> = {
  sm: "max-h-[calc(78vh-24px)]",
  md: "max-h-[calc(90vh-24px)]",
  lg: "max-h-[calc(94vh-24px)]",
};

type Props = {
  onClose: () => void;
  title: string;
  description?: string;
  size?: ModalSize;
  trapFocus?: boolean;
  /** Extra classes on the panel (fixed height, etc). */
  className?: string;
  children: ReactNode;
};

export function ModalPanel({
  onClose,
  title,
  description,
  size = "md",
  trapFocus = false,
  className,
  children,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const uid = useId();
  const titleId = `${uid}-title`;
  const descriptionId = description ? `${uid}-desc` : undefined;

  useEffect(() => {
    // A child's own autoFocus already claimed focus inside the dialog —
    // don't steal it for the close button.
    const dialog = closeRef.current?.closest('[role="dialog"]');
    if (dialog?.contains(document.activeElement)) return;
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!trapFocus) return;
    const contain = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [
        ...(closeRef.current
          ?.closest('[role="dialog"]')
          ?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]",
          ) ?? []),
      ].filter((el) => el.getClientRects().length);
      const first = controls[0],
        last = controls[controls.length - 1];
      if (
        !controls.includes(document.activeElement as HTMLElement) ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener("keydown", contain);
    return () => window.removeEventListener("keydown", contain);
  }, [trapFocus]);

  const modalId = useRef(Symbol("modal")).current;
  useEffect(() => {
    openModals.push(modalId);
    return () => {
      const index = openModals.lastIndexOf(modalId);
      if (index >= 0) openModals.splice(index, 1);
    };
  }, [modalId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (openModals[openModals.length - 1] !== modalId) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, modalId]);

  return (
    <div
      className={`absolute left-1/2 ${TOP[size]} ${MAX_H[size]} ${WIDTH[size]} -translate-x-1/2 flex flex-col`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
        className={`modal-panel flex min-h-0 flex-col overflow-hidden rounded-2xl border border-content/10 bg-background-base/55 shadow-2xl backdrop-blur-xl ${className ?? ""}`}
      >
        <header className="flex shrink-0 items-start gap-2 px-4 pt-3">
          <div className="min-w-0 flex-1 pt-0.5">
            <h2
              id={titleId}
              className="text-2xl font-semibold leading-tight text-content"
            >
              {title}
            </h2>
            {description ? (
              <p
                id={descriptionId}
                className="mt-0.5 truncate text-[12px] leading-snug text-content/50"
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-7 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/8 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </header>
        <div
          ref={lockOverscroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-none"
        >
          <PopoverLayerOffset value={LAYER.dialog + 1 - LAYER.popover}>
            {children}
          </PopoverLayerOffset>
        </div>
      </div>
    </div>
  );
}

export function Modal(props: Props) {
  // Read at render time — the marker was written synchronously by the closing
  // modal's click handler, before this mount. Kept through render so a
  // StrictMode double-read still sees it, then consumed on mount so no
  // later, unrelated dialog can inherit it.
  const [swap] = useState(() => Date.now() - modalSwapAt < MODAL_SWAP_MS);
  useEffect(() => {
    modalSwapAt = 0;
  }, []);
  return createPortal(
    <div
      className={`fixed inset-0${swap ? " modal-swap" : ""}`}
      style={{ zIndex: LAYER.dialog }}
    >
      <div
        className="modal-backdrop absolute inset-0 bg-black/40"
        onMouseDown={props.onClose}
      />
      <ModalPanel {...props} />
    </div>,
    document.body,
  );
}
