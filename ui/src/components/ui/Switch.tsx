import { cn } from "@/util/cn";

/**
 * Boolean control for settings rows. The accent fill marks the on state, so the
 * knob position is not the only cue.
 */
export const Switch = ({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Names the switch for screen readers; the row's title sits outside it. */
  label: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn(
      "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
      checked ? "bg-accent" : "bg-secondary",
      "disabled:cursor-not-allowed disabled:opacity-40",
    )}
  >
    <span
      className={cn(
        "block size-4 rounded-full bg-white transition-transform duration-150 ease-out",
        checked ? "translate-x-4" : "translate-x-0.5",
      )}
    />
  </button>
);
