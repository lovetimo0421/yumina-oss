import { useTranslation } from "react-i18next";
import { InfoTip } from "@/components/ui/info-tip";

/**
 * One line per opening, shown only inside a 自定义 panel.
 *
 * Nothing to click. Whoever writes the code (usually the creation assistant
 * or an outside AI) reads the sticky note; this just says what can be asked
 * for.
 */
export type HintArea = "ai" | "behavior" | "context";

const HINTS: Record<HintArea, string[]> = {
  ai: ["codeCall", "replyRules", "ownAi"],
  behavior: ["codeBehavior", "fromCode"],
  context: ["messages", "lore", "session"],
};

/** The board listens: a panel that found an implementation asks to open it at its line. */
export const OPEN_CODE_EVENT = "yumina:blueprint-open-code";

export function requestOpenCode(file: string, line = 1): void {
  window.dispatchEvent(new CustomEvent(OPEN_CODE_EVENT, { detail: { file, line } }));
}

export function CustomizationHints({ area }: { area: HintArea }) {
  const { t } = useTranslation("editor");
  return (
    <p data-customization-hints={area} className="mt-3 flex items-center gap-1.5 text-[11px] text-foreground/50">
      {t("blueprint.hints.title")}
      <InfoTip text={HINTS[area].map((key) => `${t(`blueprint.hints.${area}.${key}.title` as never) as string} · ${t(`blueprint.hints.${area}.${key}.body` as never) as string}`).join("\n")} />
    </p>
  );
}
