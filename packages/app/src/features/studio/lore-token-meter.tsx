import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { useTokenizerReady } from "@/hooks/use-tokenizer-ready";
import { LORE_HEALTH_DOT, summarizeLoreTokens } from "@/features/editor/lib/lore-tokens";

const OPEN_KEY = "yumina:studio:loreMeterOpen";

/** How much the card's lore costs, pinned to the board's top-right corner:
 *  per turn and in total, with the health dot; open, the same buckets as the
 *  lorebook's footer (面板 → 设定). The canvas had no number for this at all. */
export function LoreTokenMeter({ right }: { right: number }) {
  const { t } = useTranslation("editor");
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const tokenizerReady = useTokenizerReady();
  // tokenizerReady: recount once exact counts arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sum = useMemo(() => summarizeLoreTokens(entries), [entries, tokenizerReady]);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
  });
  const toggle = () => setOpen((v) => {
    try { localStorage.setItem(OPEN_KEY, v ? "0" : "1"); } catch { /* storage off */ }
    return !v;
  });
  const n = (v: number) => `~${v.toLocaleString()}`;
  const healthText = t(`entries.tokenBreakdown.health${sum.health === "healthy" ? "Healthy" : sum.health === "caution" ? "Caution" : "Heavy"}`);
  const rows: Array<{ label: string; value: number; hint: string; tone?: string; extra?: string }> = [
    { label: t("entries.tokenBreakdown.greeting"), value: sum.greeting, extra: sum.greetingCount > 1 ? `×${sum.greetingCount}` : undefined,
      hint: sum.greetingCount > 1 ? t("entries.tokenBreakdown.greetingHintMulti", { count: sum.greetingCount }) : t("entries.tokenBreakdown.greetingHint") },
    { label: t("entries.tokenBreakdown.alwaysSent"), value: sum.alwaysSent, hint: t("entries.tokenBreakdown.alwaysSentHint") },
    { label: t("entries.tokenBreakdown.keywordTriggered"), value: sum.keywordTriggered, hint: t("entries.tokenBreakdown.keywordTriggeredHint") },
    { label: t("entries.tokenBreakdown.dormant"), value: sum.dormant, hint: t("entries.tokenBreakdown.dormantHint"), tone: sum.dormant > 0 ? "text-amber-300/70" : undefined },
    { label: t("entries.tokenBreakdown.disabledLabel"), value: sum.disabled, hint: "", tone: "opacity-60" },
  ];
  return (
    <div
      data-lore-meter=""
      className="studio-pill pointer-events-auto absolute top-3 z-10 overflow-hidden rounded-xl border text-[11px] text-muted-foreground backdrop-blur-xl"
      style={{ right, width: open ? 248 : undefined }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={t("entries.tokenBreakdown.toggleHint")}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:text-foreground"
      >
        <span title={healthText} className={cn("block h-2 w-2 shrink-0 rounded-full", LORE_HEALTH_DOT[sum.health])} />
        <span className="min-w-0 flex-1 truncate tabular-nums">
          <span className="opacity-70">{t("entries.tokenBreakdown.perTurnLabel")}</span> {n(sum.perTurn)}
          <span className="mx-1.5 opacity-30">·</span>
          <span className="opacity-70">{t("entries.tokenBreakdown.totalLabel")}</span> {n(sum.total)} {t("entries.tokenBreakdown.tokUnit", "tok")}
        </span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-1 border-t border-white/[0.06] px-3 py-2">
          {rows.map((r) => (
            <div key={r.label} title={r.hint || undefined} className={cn("flex items-center justify-between gap-3", r.tone)}>
              <span className="truncate">{r.label}{r.extra && <span className="ml-1.5 opacity-50">{r.extra}</span>}</span>
              <span className="shrink-0 tabular-nums">{n(r.value)}</span>
            </div>
          ))}
          <div className="mt-1.5 flex items-center justify-between border-t border-white/[0.06] pt-1.5 font-medium text-foreground/80">
            <span>{t("entries.tokenBreakdown.totalLabel")}</span>
            <span className="tabular-nums">{n(sum.total)} {t("entries.tokenBreakdown.tokUnit", "tok")}</span>
          </div>
          {sum.health !== "healthy" && <p className="pt-1 leading-relaxed text-foreground/60">{healthText}</p>}
        </div>
      )}
    </div>
  );
}
