import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronRight, FileCode2, X } from "lucide-react";
import type { WorldDefinition } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { aiCallRows, type AiCallRow, type AiCallSetting } from "./ai-calls";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Asked from a form (the story AI's settings) to open the table; the board
 *  listens, since the table is drawn over it. */
export const OPEN_AI_CALLS_EVENT = "yumina:studio-open-ai-calls";
export const requestOpenAiCalls = () => window.dispatchEvent(new Event(OPEN_AI_CALLS_EVENT));

const MODE_TONE: Record<AiCallSetting["mode"], string> = {
  player: "text-zinc-300",
  default: "text-zinc-300",
  author: "font-semibold text-pink-200",
  code: "text-violet-200",
};

function SettingCell({ setting }: { setting: AiCallSetting }) {
  return (
    <td className="border-b border-white/[0.04] px-3 py-2 align-top">
      <div className={cn("max-w-[220px] break-words", MODE_TONE[setting.mode])}>{setting.text}</div>
      {setting.note && <div className="mt-0.5 max-w-[220px] text-[11px] leading-snug text-zinc-500">{setting.note}</div>}
      {setting.warn && (
        <div className="mt-1 inline-flex max-w-[220px] items-start gap-1 rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] leading-snug text-amber-200" data-ai-call-warn>
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span>{setting.warn}</span>
        </div>
      )}
    </td>
  );
}

/**
 * 「这张卡的 AI」, opened from 视图: every AI call the card makes, one row
 * each — the story AI, every AI the card places, every call its code makes —
 * with when it runs, who pays, and the model and settings it really runs
 * on. A row opens where that call is edited.
 */
export function AiCallsTable({ world, onOpen, onClose }: { world: WorldDefinition; onOpen: (row: AiCallRow) => void; onClose: () => void }) {
  const { t } = useTranslation(["editor", "common"]);
  const rows = useMemo(() => aiCallRows(world, t as Translate), [world, t]);
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/45 p-6 pt-16" onClick={onClose} data-ai-calls>
      <div
        className="studio-pill flex max-h-full w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
          <span className="text-sm font-bold">{t("blueprint.aiCalls.title")}</span>
          <span className="text-[11.5px] text-muted-foreground">{t("blueprint.aiCalls.count", { count: rows.length })}</span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label={t("blueprint.aiTable.close")} className="rounded-md p-1 text-muted-foreground hover:bg-white/10 hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-[12.5px]">
            <thead className="sticky top-0 z-10 bg-[#141218]">
              <tr>
                {(["name", "when", "payer", "model", "params"] as const).map((col) => (
                  <th key={col} className="whitespace-nowrap border-b border-white/[0.07] px-3 py-2 text-left font-semibold text-muted-foreground first:pl-4">{t(`blueprint.aiCalls.col.${col}`)}</th>
                ))}
                <th className="border-b border-white/[0.07] px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className={cn("hover:bg-white/[0.03]", row.off && "opacity-50")} data-ai-call-row={row.key}>
                  <td className="border-b border-white/[0.04] py-2 pl-4 pr-3 align-top">
                    <div className="flex items-baseline gap-1.5">
                      <span className="max-w-[220px] truncate font-medium text-zinc-100" title={row.name}>{row.name}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-zinc-500">
                      {[t(`blueprint.aiCalls.kind.${row.kind}`), row.where, row.off ? t("blueprint.aiCalls.off") : ""].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  <td className="max-w-[200px] border-b border-white/[0.04] px-3 py-2 align-top text-zinc-300">{row.when}</td>
                  <td className="whitespace-nowrap border-b border-white/[0.04] px-3 py-2 align-top text-zinc-400">{t("blueprint.aiCalls.payerPlayer")}</td>
                  <SettingCell setting={row.model} />
                  <SettingCell setting={row.params} />
                  <td className="border-b border-white/[0.04] px-3 py-2 align-top">
                    <button
                      type="button"
                      onClick={() => onOpen(row)}
                      data-ai-call-open
                      className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-white/10 px-2 py-1 text-[11px] text-foreground/80 hover:border-white/25 hover:text-foreground"
                    >
                      {row.open.kind === "code" ? <FileCode2 className="h-3.5 w-3.5" /> : null}
                      {t(row.open.kind === "code" ? "blueprint.aiCalls.openCode" : "blueprint.aiCalls.openAi")}
                      {row.open.kind === "ai" ? <ChevronRight className="h-3.5 w-3.5" /> : null}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="space-y-1 border-t border-white/[0.07] px-4 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          <p>{t("blueprint.aiCalls.footRules")}</p>
          <p><span className={MODE_TONE.author}>{t("blueprint.aiCalls.legendAuthor")}</span> · {t("blueprint.aiCalls.footClamp")}</p>
        </div>
      </div>
    </div>
  );
}
