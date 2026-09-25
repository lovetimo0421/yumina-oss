import * as React from "react";

/** Accept whole token counts, including correctly grouped numbers in this locale.
 * Never turn a decimal, exponent, or a partially numeric string into a token count. */
export function parseTokenCount(text: string, locale?: string): number | null {
  const raw = text.trim();
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }
  const formatter = new Intl.NumberFormat(locale);
  const group = formatter.formatToParts(12345).find((part) => part.type === "group")?.value;
  if (!group) return null;
  const normalizeSpaces = (value: string) => value.replace(/[\u00a0\u202f]/g, " ");
  const normalized = normalizeSpaces(raw);
  const digits = normalized.split(normalizeSpaces(group)).join("");
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && normalizeSpaces(formatter.format(value)) === normalized
    ? value : null;
}

interface TokenNumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max"> {
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  formatted?: boolean;
}

/** A draft belongs to the field, not the persisted account configuration. */
export const TokenNumberInput = React.forwardRef<HTMLInputElement, TokenNumberInputProps>(
  ({ value, onCommit, min, max, formatted = false, onFocus, onBlur, onKeyDown, ...props }, ref) => {
    const [draft, setDraft] = React.useState<string | null>(null);
    const draftRef = React.useRef<string | null>(null);
    const updateDraft = (next: string | null) => {
      draftRef.current = next;
      setDraft(next);
    };

    // A preset, reset, or server refresh is authoritative. Merely focusing a
    // null-backed default must not write an explicit preference to the server.
    React.useEffect(() => { updateDraft(null); }, [value]);

    const commit = () => {
      const text = draftRef.current;
      updateDraft(null);
      if (text === null) return;
      const parsed = parseTokenCount(text);
      if (parsed === null) return; // Blank/malformed drafts restore the saved value.
      const next = Math.max(min, Math.min(max, parsed));
      if (next !== value) onCommit(next);
    };

    return <input
      {...props}
      ref={ref}
      type="text"
      inputMode="numeric"
      value={draft ?? (formatted ? value.toLocaleString() : String(value))}
      onFocus={(event) => {
        // Edit plain digits so grouping separators cannot move the caret or
        // turn a Dutch "32.000" into 32 via parseInt.
        updateDraft(String(value));
        onFocus?.(event);
      }}
      onChange={(event) => updateDraft(event.target.value)}
      onBlur={(event) => { commit(); onBlur?.(event); }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          updateDraft(null);
          event.currentTarget.blur();
        }
      }}
    />;
  },
);
TokenNumberInput.displayName = "TokenNumberInput";
