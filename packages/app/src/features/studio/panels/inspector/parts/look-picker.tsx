import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { currentUiLook, uiLookPartOf, uiLooksFor } from "@yumina/engine";
import type { UiElement, UiLook, UiLookPart } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { Section } from "./part-kit";

/**
 * 「换个样子」: a row of looks for the selected part, one click each.
 *
 * Every thumbnail is painted under the card's own theme — the tokens are set
 * on the row — so what the creator is choosing between is what their card
 * will actually look like, not a neutral mock. A look only rewrites style
 * fields (engine/src/ui-doc/looks.ts); the part's content and steps stay, and
 * every field it set can still be changed one by one afterwards.
 */
export function LookPicker({
  el,
  tokens,
  onApply,
}: {
  el: UiElement;
  tokens: Record<string, string> | undefined;
  onApply: (lookId: string) => void;
}) {
  const { t } = useTranslation("editor");
  const part = uiLookPartOf(el as UiElement & { card?: unknown });
  if (!part) return null;
  const looks = uiLooksFor(part);
  const current = currentUiLook(el) ?? looks.find((l) => !l.style && !l.css)?.id ?? null;
  const themeVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens ?? {})) themeVars[key.startsWith("--") ? key : `--${key}`] = value;

  return (
    <Section label={t("studio.parts.looks.title")} hint={t("studio.parts.looks.hint")} testId="look-picker">
      <div
        role="radiogroup"
        aria-label={t("studio.parts.looks.title")}
        className="grid grid-cols-3 gap-1.5 rounded-md p-1.5"
        style={{ ...themeVars, background: "var(--yc-bg-solid, #111318)" } as CSSProperties}
      >
        {looks.map((look) => (
          <button
            key={look.id}
            type="button"
            role="radio"
            aria-checked={current === look.id}
            data-testid={`look-${look.id}`}
            onClick={() => onApply(look.id)}
            title={t(`studio.parts.looks.names.${look.id}`, { defaultValue: look.name.en })}
            className={cn(
              "group flex min-w-0 flex-col items-stretch gap-1 rounded-md p-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary",
              current === look.id ? "bg-white/10 ring-1 ring-primary" : "hover:bg-white/5",
            )}
          >
            <Swatch look={look} part={part} />
            <span
              className="truncate px-0.5 text-[10.5px] leading-tight"
              style={{ color: "color-mix(in srgb, var(--yc-text, #f1ece4) 78%, transparent)" }}
            >
              {t(`studio.parts.looks.names.${look.id}`, { defaultValue: look.name.en })}
            </span>
          </button>
        ))}
      </div>
    </Section>
  );
}

/** A small card in the look's own colours: what the part will be made of. */
function Swatch({ look, part }: { look: UiLook; part: UiLookPart }) {
  const s = look.swatch;
  const frame: CSSProperties = {
    background: s.bg,
    color: s.fg,
    border: s.border ? `1px solid ${s.border}` : "1px solid transparent",
    borderRadius: Math.min(s.radius, 999),
    boxShadow: s.shadow,
    fontFamily: s.font,
  };
  if (part === "button") {
    return (
      <span className="flex h-10 items-center justify-center">
        <span className="flex h-6 w-[80%] items-center justify-center text-[10px] font-semibold" style={frame}>Aa</span>
      </span>
    );
  }
  if (part === "field") {
    return (
      <span className="flex h-10 flex-col justify-center gap-1 px-1">
        <span className="h-1 w-1/3 rounded-full" style={{ background: "color-mix(in srgb, var(--yc-text, #f1ece4) 55%, transparent)" }} />
        <span
          className="h-4 w-full"
          style={s.underline
            ? { borderBottom: "1.5px solid color-mix(in srgb, var(--yc-text, #f1ece4) 40%, transparent)" }
            : frame}
        />
      </span>
    );
  }
  if (s.media) {
    // A card: its picture where the look puts it, then its words.
    const tile = "linear-gradient(160deg, color-mix(in srgb, #8a62c4 55%, var(--yc-bg-solid, #111318)), color-mix(in srgb, #4f7fc4 30%, var(--yc-bg-solid, #111318)))";
    return (
      <span className="relative flex h-12 flex-col overflow-hidden" style={{ ...frame, padding: s.media === "inset" ? 3 : 0 }}>
        <span
          className={s.media === "cover" ? "absolute inset-0" : "block h-6 w-full shrink-0"}
          style={{ background: tile, borderRadius: s.media === "inset" ? Math.max(1, Math.min(s.radius, 999) - 3) : 0, opacity: s.media === "cover" ? 0.9 : 1 }}
        />
        {s.media === "cover" && <span className="absolute inset-x-0 bottom-0 h-3/5" style={{ background: "linear-gradient(180deg, transparent, rgba(6,6,10,.85))" }} />}
        <span className="relative mt-auto flex flex-col gap-[3px] p-1.5">
          <span className="h-[3px] w-3/5 rounded-full" style={{ background: s.fg }} />
          {s.sub && <span className="h-[3px] w-2/5 rounded-full" style={{ background: s.sub }} />}
        </span>
      </span>
    );
  }
  return (
    <span
      className="relative flex h-10 flex-col justify-end gap-[3px] overflow-hidden p-1.5"
      style={{
        ...frame,
        ...(s.band === "stripe" ? { borderLeft: "3px solid var(--yc-send-bg, #d9a13f)" } : {}),
        ...(s.underline ? { border: 0, borderBottom: "1px solid color-mix(in srgb, var(--yc-text, #f1ece4) 22%, transparent)", borderRadius: 0 } : {}),
      }}
    >
      {s.band === "print" && <span className="absolute inset-x-1 top-1 h-4 rounded-[1px]" style={{ background: "#9fb3c8" }} />}
      <span className="relative h-[3px] w-3/5 rounded-full" style={{ background: s.fg }} />
      {s.sub && <span className="relative h-[3px] w-2/5 rounded-full" style={{ background: s.sub }} />}
    </span>
  );
}
