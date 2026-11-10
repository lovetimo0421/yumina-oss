import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ExternalLink } from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";

/* The column's controls are glass under the lamp (studio-material.css):
   surface 4%, a hairline, a line of light along the top; the focused one is
   lit. Text is 12px throughout, labels at ink-2. */
export const inputClass =
  "studio-control w-full rounded-lg border px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground/30 focus:studio-control-focus focus:outline-none";
/** The control in a settings row: sized to its content, not to the column. */
export const rowControl =
  "studio-control w-full rounded-lg border px-2 py-1 text-xs text-foreground focus:studio-control-focus focus:outline-none";
export const labelClass = "text-xs font-medium text-foreground/66";
/** A ⓘ beside a label: the explanation, on demand. Every field used to
 *  carry its explanation underneath at all times, and a column of eight
 *  fields read as a wall of small grey type. */
export function Hint({ text }: { text?: string }) {
  return <InfoTip text={text} />;
}
/** A switch: on is lit, off is glass. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors disabled:opacity-40",
        checked ? "bg-[rgba(240,198,116,0.22)] shadow-[0_0_12px_rgba(240,198,116,0.35),inset_0_1px_0_rgba(255,255,255,0.15)]" : "bg-white/10",
      )}
    >
      <span className={cn("absolute top-[2px] h-[14px] w-[14px] rounded-full transition-[left]", checked ? "left-[14px] bg-[#f5d48a] shadow-[0_0_8px_2px_rgba(240,198,116,0.5)]" : "left-[2px] bg-foreground/60")} />
    </button>
  );
}
/** Pick one of a few: the choices stand in a row and the chosen one is lit,
 *  so what a thing can be is visible without opening a menu. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string; hint?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="studio-control inline-flex overflow-hidden rounded-lg border">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.hint}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-[26px] whitespace-nowrap px-2.5 text-[11px] font-medium transition-colors",
            index > 0 && "border-l border-white/[0.08]",
            option.value === value ? "bg-[rgba(240,198,116,0.16)] text-[#f5d48a] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]" : "text-foreground/60 hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
/**
 * A field that holds what is being typed until it is let go of.
 *
 * Read on every keystroke, a field can only ever hold a finished value: a
 * number clamped to its minimum turns "1" on the way to "15" into the minimum,
 * "0." into "0", and a cleared box into whatever empty is read as. So the text
 * is the field's own while it is being written, and it is committed on blur,
 * on Enter, or when the field goes away without either — the floating card
 * closes on Escape, and a value typed there would otherwise be lost.
 */
export function DraftInput({ value, onCommit, onKeyDown, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur"> & {
  value: string;
  onCommit: (raw: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const latest = useRef(onCommit);
  latest.current = onCommit;
  const flush = () => {
    const raw = pending.current;
    if (raw === null) return;
    pending.current = null;
    setText(null);
    latest.current(raw);
  };
  // Unmounted mid-edit (Escape, the selection moved): still keep the words.
  useEffect(() => () => {
    const raw = pending.current;
    pending.current = null;
    if (raw !== null) latest.current(raw);
  }, []);
  return (
    <input
      {...rest}
      value={text ?? value}
      onChange={(e) => { pending.current = e.target.value; setText(e.target.value); }}
      onBlur={flush}
      onKeyDown={(e) => { if (e.key === "Enter") flush(); onKeyDown?.(e); }}
    />
  );
}

/** Read a typed number the way a field's limits say. `undefined` is a draft
 *  that is not a number at all; `null` is a cleared box. */
export function readTypedNumber(raw: string, { min, max, integer }: { min?: number; max?: number; integer?: boolean } = {}): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  if (integer) n = Math.round(n);
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  return n;
}

/**
 * A number typed freely and settled when it is let go of: clamped to its
 * limits then, never while it is being written. A cleared box is `undefined`
 * where the field allows it (`allowEmpty`) and the stored value back again
 * where it does not; so is anything that is not a number.
 */
export function NumberInput({ value, onCommit, min, max, integer, allowEmpty, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur" | "min" | "max"> & {
  value: number | undefined;
  onCommit: (next: number | undefined) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  allowEmpty?: boolean;
}) {
  return (
    <DraftInput
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      min={min}
      max={max}
      {...rest}
      value={value === undefined ? "" : String(value)}
      onCommit={(raw) => {
        const n = readTypedNumber(raw, { min, max, integer });
        if (n === undefined || (n === null && !allowEmpty)) return;
        const next = n ?? undefined;
        if (next !== value) onCommit(next);
      }}
    />
  );
}

/** − n + : a number that is stepped more often than typed. The buttons step
 *  at once; the box in the middle is typed like any other number field. */
export function Stepper({ value, onChange, min = 0, max, label }: { value: number | undefined; onChange: (v: number) => void; min?: number; max?: number; label: string }) {
  const btn = "flex h-[26px] w-6 items-center justify-center text-foreground/55 transition-colors hover:text-foreground";
  const clamp = (n: number) => Math.max(min, max === undefined ? n : Math.min(max, n));
  return (
    <span className="studio-control inline-flex items-center overflow-hidden rounded-lg border">
      <button type="button" aria-label={`${label} −`} onClick={() => onChange(clamp((value ?? min) - 1))} className={btn}>−</button>
      <NumberInput
        aria-label={label}
        value={value}
        min={min}
        max={max}
        integer
        onCommit={(v) => { if (v !== undefined) onChange(v); }}
        className="h-[26px] w-11 border-x border-white/[0.08] bg-transparent text-center text-xs tabular-nums text-foreground focus:outline-none"
      />
      <button type="button" aria-label={`${label} +`} onClick={() => onChange(clamp(value === undefined ? min : value + 1))} className={btn}>+</button>
    </span>
  );
}

/**
 * A field whose control needs the full width — a body of text, a list.
 *
 * Its label is sentence case and quiet. Every field used to wear a tracked-out
 * ALL-CAPS label, which gave a checkbox the same visual weight as the entry's
 * own words and turned the panel into a wall of shouting.
 */
export function Field({ label, hint, children }: { label?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      {label && <label className={cn(labelClass, "flex items-center gap-1.5")}>{label}<Hint text={hint} /></label>}
      {children}
    </div>
  );
}

/** A settings line: what it is on the left, what it is set to on the right.
 *  Six of these read as a list; six stacked label-over-full-width-input read
 *  as six unrelated forms. */
export function Row({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground/66">{label}<Hint text={hint} /></span>
      {/* One fixed column for every control on the panel. Auto-width controls
          gave each row its own right edge, and a stack of them read as a
          ragged margin rather than a list of settings. A `wide` control (a
          row of choices) takes what it needs. */}
      <div className={cn("flex min-w-0 shrink-0 items-center justify-end gap-1.5", wide ? "max-w-[72%]" : "w-[176px]")}>{children}</div>
    </div>
  );
}

/** One heading for a group of settings, instead of a label on each. */
export function Group({ title, hint, right, children }: { title: string; hint?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-0.5 pt-4 first:pt-0">
      {(title || right) && <h3 className="flex items-center gap-1.5 pb-1 text-xs font-semibold text-foreground">{title}<Hint text={hint} />{right && <span className="ml-auto">{right}</span>}</h3>}
      {children}
    </section>
  );
}

/** Module membership, shaped as a settings row: what it belongs to is a
 *  setting about the object, not a form of its own. */


/**
 * The rarely-touched half, folded.
 *
 * An object's panel has to hold everything about it or it is not the place you
 * edit it — that was what "open the full editor" admitted every time it
 * appeared. But everything at once is its own kind of unusable, and the split
 * is not arbitrary: the fields above are the ones that decide what the object
 * DOES, the ones in here tune how it does it.
 */
export function More({ children, label, defaultOpen = false }: { children: ReactNode; label?: ReactNode; defaultOpen?: boolean }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(defaultOpen);
  // A fold is a line, not a box: a box read as one more input.
  return (
    <div className="mt-2 border-t border-white/[0.06]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn("flex w-full items-center gap-1.5 py-2.5 text-left text-xs font-medium transition-colors hover:text-foreground", open ? "text-foreground" : "text-foreground/50")}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        {label ?? t("entries.advanced")}
      </button>
      {open && <div className="space-y-3 pb-3">{children}</div>}
    </div>
  );
}

/** A labelled checkbox with a line of explanation — the shape most of the
 *  rarely-touched settings take. */
export function Check({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  // A setting is a row like any other: what it is on the left, a switch on
  // the right, the explanation behind ⓘ.
  return (
    <Row label={label} hint={hint}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </Row>
  );
}

/**
 * Open a different instrument.
 *
 * NOT "open the full editor". That button used to sit under every object, and
 * every time it appeared it admitted the panel above it was the lesser copy —
 * so a creator learned that the real editing happened somewhere else and the
 * canvas was a picture of their card. The panels hold everything about their
 * object now, and those links are gone.
 * What survives is the two places that are genuinely another tool: the
 * interface builder and the audio library are not more fields about this
 * object. They say which tool they open.
 */
export function OpenToolButton({ labelKey, onOpen }: { labelKey: string; onOpen: () => void }) {
  const { t } = useTranslation("editor");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="studio-control flex w-full items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium text-foreground/70 transition-colors hover:text-foreground"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      {t(labelKey as never)}
    </button>
  );
}
