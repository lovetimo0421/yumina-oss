import { useState, type ReactNode } from "react";
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
/** − n + : a number that is stepped more often than typed. */
export function Stepper({ value, onChange, min = 0, label }: { value: number; onChange: (v: number) => void; min?: number; label: string }) {
  const btn = "flex h-[26px] w-6 items-center justify-center text-foreground/55 transition-colors hover:text-foreground";
  return (
    <span className="studio-control inline-flex items-center overflow-hidden rounded-lg border">
      <button type="button" aria-label={`${label} −`} onClick={() => onChange(Math.max(min, value - 1))} className={btn}>−</button>
      <input
        type="number"
        aria-label={label}
        value={value}
        min={min}
        onChange={(e) => onChange(Math.max(min, Math.floor(Number(e.target.value) || 0)))}
        className="h-[26px] w-11 border-x border-white/[0.08] bg-transparent text-center text-xs tabular-nums text-foreground focus:outline-none"
      />
      <button type="button" aria-label={`${label} +`} onClick={() => onChange(value + 1)} className={btn}>+</button>
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
export function More({ children, label, defaultOpen = false }: { children: ReactNode; label?: string; defaultOpen?: boolean }) {
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
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  // A setting is a row like any other: what it is on the left, a switch on
  // the right, the explanation behind ⓘ.
  return (
    <Row label={label} hint={hint}>
      <Switch checked={checked} onChange={onChange} label={label} />
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
