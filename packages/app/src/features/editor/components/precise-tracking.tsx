import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CONTINUITY_MAX_OPTIONS, suggestedContinuityDelta } from "@yumina/engine";
import type { Variable } from "@yumina/engine";
import { NumberInput } from "@/components/ui/number-input";
import { StyledCheckbox } from "./styled-checkbox";

/**
 * Chip editor for a string variable's fixed value list. Enter or blur adds
 * the typed value; duplicates and blanks are ignored.
 */
export function OptionsEditor({
  values,
  onChange,
  addLabel,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  addLabel: string;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    setDraft("");
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
  };
  // One bordered field, like the editor's other inputs: the values sit inside
  // it as tags and the caret follows them. Backspace on an empty caret takes
  // the last tag back, so a typo is one key to undo.
  return (
    <div className="flex min-h-[46px] flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 shadow-inner transition-all focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/50">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-md bg-primary/10 py-1 pl-2.5 pr-1 text-sm text-foreground">
          {v}
          <button
            type="button"
            aria-label={`${addLabel}: ${v} ×`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/15 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); add(); }
          else if (e.key === "Backspace" && draft === "" && values.length > 0) { e.preventDefault(); onChange(values.slice(0, -1)); }
        }}
        onBlur={add}
        placeholder={values.length === 0 ? placeholder : ""}
        aria-label={addLabel}
        className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
      />
    </div>
  );
}

/** What a fresh "max change per turn" defaults to: 15% of the range, or 10. */
export function suggestedDelta(variable: Variable): number {
  return suggestedContinuityDelta(variable);
}

/**
 * "精准追踪" — one checkbox. Numbers reveal the per-turn window (most it may
 * fall / rise); the engine offers the judge every integer in that window, so
 * the window is capped at 255 options and the box says so. Strings and
 * booleans need nothing more.
 */
export function PreciseTrackingEditor({
  variable,
  onChange,
}: {
  variable: Variable;
  onChange: (updates: Partial<Variable>) => void;
}) {
  const { t } = useTranslation("editor");
  const on = variable.precise === true;
  const down = Math.max(0, Math.floor(variable.deltaDown ?? 0));
  const up = Math.max(0, Math.floor(variable.deltaUp ?? 0));
  const tooWide = down + up + 1 > CONTINUITY_MAX_OPTIONS;

  const toggle = (next: boolean) => {
    if (!next) { onChange({ precise: undefined }); return; }
    const updates: Partial<Variable> = { precise: true };
    if (variable.type === "number" && variable.deltaDown === undefined && variable.deltaUp === undefined) {
      const d = suggestedDelta(variable);
      updates.deltaDown = d;
      updates.deltaUp = d;
    }
    onChange(updates);
  };

  let status: { text: string; warn: boolean } | null = null;
  if (on && variable.type === "number") {
    if (tooWide) status = { text: t("variables.preciseTooWide", { max: CONTINUITY_MAX_OPTIONS - 1 }), warn: true };
    else if (down === 0 && up === 0) status = { text: t("variables.preciseZero"), warn: true };
    else if (down === 0) status = { text: t("variables.preciseUpOnly", { up }), warn: false };
    else if (up === 0) status = { text: t("variables.preciseDownOnly", { down }), warn: false };
    else status = { text: t("variables.preciseRange", { down, up }), warn: false };
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <StyledCheckbox
        checked={on}
        onChange={toggle}
        label={t("variables.preciseLabel")}
        hint={variable.type === "string" ? t("variables.preciseStringHint") : t("variables.preciseHint")}
      />
      {on && variable.type === "number" && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-bold text-foreground">{t("variables.preciseDown")}</label>
            <NumberInput
              value={variable.deltaDown ?? ""}
              min={0}
              onChange={(v) => onChange({ deltaDown: v === "" ? 0 : Math.max(0, Math.floor(v)) })}
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-bold text-foreground">{t("variables.preciseUp")}</label>
            <NumberInput
              value={variable.deltaUp ?? ""}
              min={0}
              onChange={(v) => onChange({ deltaUp: v === "" ? 0 : Math.max(0, Math.floor(v)) })}
            />
          </div>
        </div>
      )}
      {status && (
        <p className={cn("text-sm", status.warn ? "text-destructive" : "text-muted-foreground")}>{status.text}</p>
      )}
    </div>
  );
}
