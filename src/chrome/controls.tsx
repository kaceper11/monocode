import { Check } from "./icons";

/** One vocabulary of dialog/sheet footer buttons — pick a tone, don't
 * restyle per dialog. Add `inline-flex items-center gap-1.5` when a button
 * carries a spinner icon. */
export const DIALOG_ACTION = {
  ghost:
    "rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40",
  tonal:
    "rounded-md bg-content/10 px-3 py-1.5 text-[12px] font-medium text-content hover:bg-content/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40",
  accent:
    "rounded-md bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40",
  primary:
    "rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40",
  danger:
    "rounded-md bg-red-500/20 px-3 py-1.5 text-[12px] font-medium text-red-300 hover:bg-red-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 disabled:opacity-40",
} as const;

/**
 * Shared check primitives: a transparent input carries the semantics (focus
 * ring, disabled, keyboard) while a styled span paints the control — the same
 * pattern every checkbox in the app already used, now with a radio sibling.
 * `className` overrides the default `mt-0.5` used to align with multi-line rows.
 */
export function Checkbox({
  label,
  checked,
  disabled,
  onChange,
  className,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  className?: string;
}) {
  return (
    <span
      className={`relative inline-flex size-4 shrink-0 ${className ?? "mt-0.5"}`}
    >
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="peer absolute inset-0 z-10 size-4 cursor-pointer opacity-0 disabled:cursor-default"
      />
      <span className="pointer-events-none flex size-4 items-center justify-center rounded border border-content/25 text-transparent peer-checked:border-content/60 peer-checked:bg-content/10 peer-checked:text-content peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-disabled:opacity-35">
        <Check className="size-3" strokeWidth={2} />
      </span>
    </span>
  );
}

export function Radio({
  label,
  name,
  checked,
  disabled,
  onChange,
  className,
}: {
  label: string;
  name?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  className?: string;
}) {
  return (
    <span
      className={`relative inline-flex size-4 shrink-0 ${className ?? "mt-0.5"}`}
    >
      <input
        type="radio"
        name={name}
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="peer absolute inset-0 z-10 size-4 cursor-pointer opacity-0 disabled:cursor-default"
      />
      <span className="pointer-events-none absolute inset-0 rounded-full border border-content/25 transition-colors peer-checked:border-content/60 peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-disabled:opacity-35" />
      <span className="pointer-events-none absolute inset-0 m-auto size-1.5 rounded-full bg-content opacity-0 transition-opacity peer-checked:opacity-100" />
    </span>
  );
}
