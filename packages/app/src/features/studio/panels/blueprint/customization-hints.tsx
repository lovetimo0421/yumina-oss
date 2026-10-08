import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";

/**
 * One line per opening, shown only inside a 自定义 panel.
 *
 * Nothing to click. Whoever writes the code (usually the creation assistant
 * or an outside AI) reads the sticky note; this just says what can be asked
 * for.
 */
export type HintArea = "ai" | "behavior";

const HINTS: Record<HintArea, string[]> = {
  ai: ["codeCall", "replyRules", "ownAi"],
  behavior: ["codeBehavior", "fromCode"],
};

/** The board listens: a panel that found an implementation asks to open it at its line. */
export const OPEN_CODE_EVENT = "yumina:blueprint-open-code";

export function requestOpenCode(file: string, line = 1): void {
  window.dispatchEvent(new CustomEvent(OPEN_CODE_EVENT, { detail: { file, line } }));
}

export function CustomizationHints({ area }: { area: HintArea }) {
  const { t } = useTranslation("editor");
  return (
    <div data-customization-hints={area} className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.025] px-2.5 py-2">
      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-foreground/60">
        <Sparkles className="h-3.5 w-3.5 text-violet-300/80" />
        {t("blueprint.hints.title")}
      </p>
      <ul className="space-y-1">
        {HINTS[area].map((key) => (
          <li key={key} className="flex items-start gap-2 text-[11px] leading-relaxed text-foreground/65">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-violet-300/60" />
            <span className="min-w-0">
              <span className="font-medium text-foreground/85">{t(`blueprint.hints.${area}.${key}.title` as never) as string}</span>
              {" · "}
              {t(`blueprint.hints.${area}.${key}.body` as never) as string}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
