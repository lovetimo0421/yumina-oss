import { useTranslation } from "react-i18next";
import type { UiKnob, UiKnobGroup } from "@yumina/engine";

/**
 * One decomposed region's knobs, shown for whichever block the inspector has
 * selected.
 *
 * A knob is a visual constant lifted OUT of hand-written code (拆积木), so the
 * person editing it never reads the code — they see "标题颜色" with a swatch.
 * Values land in the document, the compiler regenerates `_knobs.tsx`, the live
 * preview picks it up. The card's own code is never touched, which is what
 * makes this safe on a 30k-character frontend.
 *
 * This is the inspector's third exit: when the block you picked happens to be
 * a decomposed region, a colour change needs neither the code panel nor the AI.
 */

const MINI_INPUT =
  "w-full min-w-0 rounded border border-border/50 bg-background/60 px-1.5 py-0.5 text-[11px] text-foreground outline-none focus:border-primary/50";
const LABEL = "text-[10px] text-muted-foreground/60";

/** Native colour pickers only speak #rrggbb. Everything else (rgba(), and the
 *  gradients that hide in text knobs) edits as text with a live swatch. */
const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

function ColorKnob({ knob, onChange }: { knob: UiKnob; onChange: (value: string) => void }) {
  const value = String(knob.value ?? "");
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        className="h-5 w-5 shrink-0 rounded border border-border/40"
        style={{ background: value || "transparent" }}
      />
      {isHex(value) && (
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-5 w-6 shrink-0 cursor-pointer rounded border border-border/40 bg-transparent p-0"
        />
      )}
      <input className={MINI_INPUT} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </div>
  );
}

function NumberKnob({ knob, onChange }: { knob: UiKnob; onChange: (value: number) => void }) {
  const value = typeof knob.value === "number" ? knob.value : Number(knob.value) || 0;
  const hasRange = knob.min !== undefined && knob.max !== undefined;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {hasRange && (
        <input
          type="range"
          min={knob.min}
          max={knob.max}
          step={knob.step ?? 1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="min-w-0 flex-1 accent-amber-400"
        />
      )}
      <input
        type="number"
        className={`${MINI_INPUT} max-w-[72px] shrink-0`}
        value={value}
        step={knob.step ?? 1}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {knob.unit && <span className="shrink-0 text-[9px] text-muted-foreground/50">{knob.unit}</span>}
    </div>
  );
}

function TextKnob({ knob, onChange }: { knob: UiKnob; onChange: (value: string) => void }) {
  const value = String(knob.value ?? "");
  // Gradients and other long CSS values need room; display strings do not.
  return value.length > 40 ? (
    <textarea
      className={`${MINI_INPUT} h-14 resize-y py-1 leading-relaxed`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
    />
  ) : (
    <input className={MINI_INPUT} value={value} onChange={(e) => onChange(e.target.value)} />
  );
}

export function KnobPanel({
  group,
  onChange,
}: {
  group: UiKnobGroup;
  onChange: (knobId: string, value: string | number) => void;
}) {
  const { t } = useTranslation("editor");
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">{group.label}</span>
        <span className="text-[9px] text-muted-foreground/45">{t("studio.inspect.knobsBadge")}</span>
      </div>
      <p className="pb-1 text-[9px] leading-relaxed text-muted-foreground/45">
        {t("studio.inspect.knobsHint")}
      </p>
      {group.knobs.map((knob) => (
        <label key={knob.id} className="block space-y-0.5">
          <span className={LABEL}>{knob.label}</span>
          {knob.kind === "color" ? (
            <ColorKnob knob={knob} onChange={(v) => onChange(knob.id, v)} />
          ) : knob.kind === "number" ? (
            <NumberKnob knob={knob} onChange={(v) => onChange(knob.id, v)} />
          ) : (
            <TextKnob knob={knob} onChange={(v) => onChange(knob.id, v)} />
          )}
        </label>
      ))}
    </div>
  );
}
