import { useTranslation } from "react-i18next";
import { Bot, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Lineup, LineupItem } from "./ai-lineup";

/** Opens the AI lineup from anywhere on the board (a frame's AI chips). */
export const AI_LINEUP_EVENT = "yumina:studio-ai-lineup";

/**
 * 「AI 一览」: every AI the card runs, in the order a turn meets them. The
 * card's own AIs take you to where they live on the board; the platform's
 * are listed so their work is not invisible, with nothing to set here.
 */
export function AiLineupCard({ lineup, ran, onGo, onClose, more }: {
  lineup: Lineup;
  ran?: ReadonlySet<string>;
  onGo: (item: LineupItem) => void;
  onClose: () => void;
  /** The deeper views of the same AIs (who knows what, models and costs):
   *  links at the foot, so 视图 has one way into this card's AIs. */
  more?: ReadonlyArray<{ label: string; onClick: () => void }>;
}) {
  const { t } = useTranslation("editor");
  return (
    <div className="studio-pill w-[300px] overflow-hidden rounded-xl border" data-ai-lineup="">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
        <Bot className="h-3.5 w-3.5 shrink-0 text-pink-400" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-foreground">{t("blueprint.lineup.title")}</span>
        <span className="shrink-0 rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] font-bold text-pink-200">{lineup.total}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common:close", { defaultValue: "Close" })}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ol className="max-h-[60vh] space-y-3 overflow-y-auto px-3 py-2.5">
        {lineup.sections.map((section, index) => (
          <li key={section.id}>
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground/70">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/[0.06] text-[9px]">{index + 1}</span>
              {t(`blueprint.lineup.section.${section.id}` as never)}
            </div>
            <ul className="space-y-1">
              {section.items.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    disabled={item.platform}
                    onClick={() => onGo(item)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors",
                      item.platform
                        ? "cursor-default border-primary/20 bg-primary/[0.05]"
                        : "border-pink-400/25 bg-pink-500/[0.06] hover:border-pink-400/50 hover:bg-pink-500/10",
                    )}
                  >
                    {item.platform
                      ? <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      : <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pink-300" />}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12px] font-semibold text-foreground">{item.name}</span>
                        {item.where && <span className="shrink-0 truncate text-[10px] text-muted-foreground">{item.where}</span>}
                        {item.values !== undefined && <span className="shrink-0 text-[10px] text-muted-foreground">{t("blueprint.lineup.values", { count: item.values })}</span>}
                        {/* In a playtest: this one ran on the turn just played. */}
                        {ran?.has(item.key) && <span className="ml-auto shrink-0 rounded bg-emerald-500/20 px-1 text-[9px] font-bold text-emerald-300">{t("blueprint.lineup.ran")}</span>}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground" title={item.job}>{item.job}</span>
                      {item.memory && <span className="block truncate text-[10px] text-muted-foreground/70" title={item.memory}>{item.memory}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {more && more.length > 0 && (
        <div className="flex items-center gap-3 border-t border-white/[0.07] px-3 py-2">
          {more.map((link) => (
            <button key={link.label} type="button" onClick={link.onClick} className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              {link.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
