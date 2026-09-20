import { Check } from "../../../shared/ui/icons.tsx";

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
