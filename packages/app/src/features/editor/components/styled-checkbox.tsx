import { cn } from "@/lib/utils";

interface StyledCheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  hint?: string;
}

/** Editor-flavored checkbox: rounded square with primary-tinted check
 *  glyph. Used across Lorebook, Audio, etc. — keep visual identical so
 *  the editor reads as one design system. */
export function StyledCheckbox({
  checked,
  onChange,
  label,
  disabled,
  hint,
}: StyledCheckboxProps) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        "group flex items-center gap-2",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      )}
    >
      <div
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded border shadow-inner transition-colors",
          checked
            ? "border-primary/50 bg-primary/10"
            : disabled
              ? "border-border bg-card"
              : "border-border bg-card group-hover:border-muted-foreground/40"
        )}
      >
        {checked && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="h-3.5 w-3.5 text-primary"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
      <span className="text-sm font-bold text-foreground">{label}</span>
      {hint && <span className="text-[10px] text-muted-foreground/40">{hint}</span>}
    </button>
  );
}
