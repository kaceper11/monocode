/** Should a global hotkey ignore this event target? Shared rule: terminals
 * and editors swallow keys, inputs other than the composer own their
 * typing, and any visible overlay (popover, dialog, menu, picker) wins. */
export function hotkeyBlockedByTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".cm-editor, .monocode-terminal")) return true;
  if (
    target.closest('input, textarea, select, [contenteditable="true"]') &&
    !target.closest("[data-composer]")
  )
    return true;

  // Popovers can leave focus in the composer. Check the whole document,
  // excluding overlays in hidden or inactive surfaces.
  return Array.from(
    document.querySelectorAll(
      '[data-popover-side], [role="dialog"], [role="alertdialog"], [role="menu"], [data-skill-picker], [data-mention-picker]',
    ),
  ).some(
    (element) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== "hidden" &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}
