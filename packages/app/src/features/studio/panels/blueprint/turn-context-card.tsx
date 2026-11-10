import { useTranslation } from "react-i18next";
import { Activity, ArrowDownLeft, CircleSlash, Layers, MessageSquare, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTokens } from "@/features/editor/lib/context-budget";
import type { TurnContextView } from "./turn-context";

/** A state-aware estimate; actual per-turn results live in the playtest log. */
export function TurnContextCard({ view, onClose }: { view: TurnContextView; onClose: () => void }) {
  const { t } = useTranslation("editor");
  return (
    <div className="studio-pill w-[290px] overflow-hidden rounded-xl border">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-foreground">
          {t("blueprint.turnCtx.estimateTitle", { defaultValue: "上下文估计" })}
        </span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold",
            view.live ? "bg-emerald-500/20 text-emerald-300" : "bg-zinc-700/50 text-zinc-400",
          )}
        >
          {view.live
            ? t("blueprint.turnCtx.currentEstimate", { defaultValue: "当前状态" })
            : t("blueprint.turnCtx.initialEstimate", { defaultValue: "初始配置" })}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common:close", { defaultValue: "关闭" })}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-[52vh] space-y-2.5 overflow-y-auto px-3 py-2.5">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {!view.live && t("blueprint.turnCtx.beforeOpening", { defaultValue: "初始配置尚未应用具体开场。" })}
        </p>
        <div className="flex items-start gap-2">
          <Activity className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
          <span className="text-[11px] leading-snug text-foreground/90">
            {view.narrator
              ? t("blueprint.turnCtx.narrator", { name: view.narrator.name })
              : t("blueprint.turnCtx.noNarrator")}
          </span>
        </div>
        <div className="flex items-start gap-2">
          <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-sky-400" />
          <span className="text-[11px] leading-snug text-foreground/90">
            {view.history
              ? t(view.history.source === "module" ? "blueprint.turnCtx.historyLimitModule" : "blueprint.turnCtx.historyLimitCard", { count: view.history.limit })
              : t("blueprint.turnCtx.historyAll")}
          </span>
        </div>

        <div className="space-y-1">
          <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground/60">
            {t("blueprint.turnCtx.on")}
          </div>
          {view.on.map((s) => (
            <div key={s.id ?? "core"} className="space-y-0.5 py-1">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/85">{s.id === null ? t("blueprint.ctx.core") : s.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">~{formatTokens(s.alwaysTokens + s.varTokens)}</span>
              </div>
              <p className="text-[10px] text-muted-foreground">{t("blueprint.turnCtx.contentCounts", { entries: s.alwaysEntries, variables: s.vars })}</p>
            </div>
          ))}
          {view.standby > 0 && (
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {t("blueprint.turnCtx.conditionalCount", { count: view.standby, defaultValue: "{{count}} 条设定由关键词、条件或前端触发，未计入此估计。" })}
            </p>
          )}
        </div>

        {view.imports.length > 0 && (
          <div className="space-y-1">
            <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground/60">
              {t("blueprint.ctx.history")}
            </div>
            {view.imports.map((im, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <ArrowDownLeft className="mt-0.5 h-3 w-3 shrink-0 text-sky-400" />
                <span className={cn("text-[10px] leading-snug", im.missing ? "text-rose-400" : "text-foreground/75")}>
                  {t("blueprint.turnCtx.carried", {
                    name: im.fromName,
                    what: t(`blueprint.station.inputKind.${im.kind}` as never),
                    as: t(im.as === "lore" ? "blueprint.station.asLore" : "blueprint.station.asHistory"),
                  })}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Absence does not render, so it is spelled out. This list is the
            thing that makes modules legible: the dungeon you left took its
            lore with it. */}
        {view.off.length > 0 && (
          <div className="space-y-1 border-t border-white/[0.06] pt-2">
            <div className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground/60">
              <CircleSlash className="h-3 w-3" />
              {t("blueprint.turnCtx.off", { count: view.off.length })}
            </div>
            <p className="text-[10px] leading-relaxed text-muted-foreground/70">
              {view.off.slice(0, 8).map((m) => m.name).join(" · ")}
              {view.off.length > 8 ? ` …` : ""}
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-white/[0.07] px-3 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Layers className="h-3 w-3" />
            {t("blueprint.turnCtx.baselineEstimate", { defaultValue: "常驻内容估计" })}
          </span>
          <span className="shrink-0 text-[11px] font-bold tabular-nums text-amber-400/90">
            ~{formatTokens(view.total)}
          </span>
        </div>
        <BudgetBar view={view} />
      </div>
    </div>
  );
}

/** The total, split the way the board is split.
 *
 *  Each segment wears its block's own colour (lore violet, variables sky, the
 *  narrative presets neutral), so the bar reads without a legend: a creator
 *  who sees a wide violet band knows to go and open the lore block. The
 *  heaviest single entry is named underneath, because "your context is heavy"
 *  is not something an author can act on and "『世界观』is 320 of it" is. */
function BudgetBar({ view }: { view: TurnContextView }) {
  const { t } = useTranslation("editor");
  const total = Math.max(1, view.byKind.presets + view.byKind.lore + view.byKind.variables);
  const segments = [
    { key: "lore", value: view.byKind.lore, color: "#8b5cf6" },
    { key: "variables", value: view.byKind.variables, color: "#38bdf8" },
    { key: "presets", value: view.byKind.presets, color: "#a1a1aa" },
  ].filter((segment) => segment.value > 0);

  if (segments.length === 0) return null;

  return (
    <>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        {segments.map((segment) => (
          <span
            key={segment.key}
            title={`${t(("blueprint.turnCtx.kind." + segment.key) as never)} · ~${formatTokens(segment.value)}`}
            style={{ width: `${(segment.value / total) * 100}%`, background: segment.color }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1">
        {segments.map((segment) => (
          <span key={segment.key} className="flex items-center gap-1 text-[9px] text-muted-foreground/75">
            <span className="h-1.5 w-1.5 shrink-0 rounded-[2px]" style={{ background: segment.color }} />
            {t(("blueprint.turnCtx.kind." + segment.key) as never)} {formatTokens(segment.value)}
          </span>
        ))}
      </div>
      {view.heaviest && view.heaviest.tokens > 120 && (
        <p className="mt-1.5 text-[9.5px] leading-relaxed text-amber-400/80">
          {t("blueprint.turnCtx.heaviest", {
            defaultValue: "{{name}} alone is {{tokens}}",
            name: view.heaviest.name,
            tokens: formatTokens(view.heaviest.tokens),
          })}
        </p>
      )}
    </>
  );
}
