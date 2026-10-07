import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { UNPLACED_WORLDBOOK_ID, isContinuityOwned, resolveStation, type Variable, type WorldDefinition, type WorldEntry, type Worldbook } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { aiRoster, stationName, workerReaders, type RosterAi } from "./ai-roster";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** How one AI stands toward one thing on the card. */
type Tone = "yes" | "cond" | "own" | "no";
interface Cell { text: string; tone: Tone }
interface Row { id: string; label: string; where: string; cells: Cell[] }
interface Section { key: string; title: string; rows: Row[] }

const speaks = (ai: RosterAi) => ai.kind === "card" || ai.kind === "narrator";

/**
 * Every setting and value on the card against every AI: who knows it, who
 * only knows it somewhere, and who never sees it. Built from the same rules
 * the turn is built from, so a secret leaking to the wrong AI shows here.
 */
export function aiTableSections(world: WorldDefinition, t: Translate): { ais: RosterAi[]; sections: Section[] } {
  const ais = aiRoster(world, t).filter((ai) => ai.kind !== "judge");
  const books = (world.worldbooks ?? []).filter((b) => b.id !== UNPLACED_WORLDBOOK_ID);
  const byId = new Map(books.map((b) => [b.id, b]));
  const card = String(t("blueprint.aiTable.card"));
  const cell = (text: string, tone: Tone): Cell => ({ text: String(text), tone });
  const no = () => cell(t("blueprint.aiTable.no"), "no");

  // Unplaced things are in play nowhere, so no AI is asked about them.
  const placed = (bookId?: string) => bookId !== UNPLACED_WORLDBOOK_ID;
  const entries = (world.entries ?? []).filter((e) => e.enabled !== false && e.role !== "greeting" && !e.presetId && placed(e.worldbookId));
  const entryCells = (e: WorldEntry): Cell[] => {
    const home = e.worldbookId ? byId.get(e.worldbookId) : undefined;
    return ais.map((ai) => {
      if (!home) {
        if (speaks(ai)) return e.alwaysSend ? cell(t("blueprint.aiTable.knows"), "yes") : cell(t("blueprint.aiTable.keyword"), "cond");
        if (ai.kind === "quiet" && e.alwaysSend) return cell(t("blueprint.aiTable.knows"), "yes");
        return no();
      }
      if (resolveStation(home)) return ai.bookId === home.id ? cell(t("blueprint.aiTable.only"), "own") : no();
      return speaks(ai) ? cell(t("blueprint.aiTable.whenThere", { place: home.name }), "cond") : no();
    });
  };

  const vars = (world.variables ?? []).filter((v) => !v.internal && v.aiAccess !== "none" && placed(v.worldbookId));
  const varCells = (v: Variable): Cell[] => {
    const home = v.worldbookId ? byId.get(v.worldbookId) : undefined;
    const homeStation = home ? resolveStation(home) : null;
    // A value is shown to whichever AI replies while its frame is in. A
    // frame behind the scenes is in on its own (by default always), so its
    // values reach the AI that talks, the way a place's do.
    const whenIn = () => (home!.activation.mode === "always" ? null : cell(t("blueprint.aiTable.whenThere", { place: home!.name }), "cond"));
    const reach = (ai: RosterAi) => {
      if ((v.aiAccess ?? "write") !== "write") return cell(t("blueprint.aiTable.sees"), "yes");
      if (isContinuityOwned(world, v)) return cell(t("blueprint.aiTable.tracked"), "yes");
      return cell(t("blueprint.aiTable.changes"), ai.bookId && home?.id === ai.bookId ? "own" : "yes");
    };
    return ais.map((ai) => {
      if (ai.kind === "worker") {
        // Behind the scenes it sees values only through a wire for them.
        const book = ai.bookId ? byId.get(ai.bookId) : undefined;
        const wired = (book ? resolveStation(book)?.inputs ?? [] : []).some((i) => i.kind === "variables" && i.from === (home?.id ?? "core"));
        return wired ? cell(t("blueprint.aiTable.sees"), "yes") : no();
      }
      if (!home) return reach(ai);
      if (homeStation?.kind === "narrator") return ai.bookId === home.id ? reach(ai) : no();
      if (homeStation) return speaks(ai) ? whenIn() ?? reach(ai) : no();
      return speaks(ai) ? cell(t("blueprint.aiTable.whenThere", { place: home.name }), "cond") : no();
    });
  };

  const whereOf = (bookId?: string) => (bookId ? byId.get(bookId)?.name ?? card : card);
  const orderOf = (bookId?: string) => (bookId ? books.findIndex((b) => b.id === bookId) + 1 : 0);
  const sortByHome = <T extends { worldbookId?: string }>(list: T[]) => [...list].sort((a, b) => orderOf(a.worldbookId) - orderOf(b.worldbookId));

  const workers = books.filter((b) => resolveStation(b)?.kind === "worker");
  const writings: Row[] = workers.map((w: Worldbook) => {
    const readers = new Set(workerReaders(books, w.id).map((b) => b.id));
    return {
      id: `module:${w.id}`,
      label: String(t("blueprint.aiTable.writing", { name: stationName(w) })),
      where: stationName(w),
      cells: ais.map((ai) =>
        ai.bookId === w.id ? cell(t("blueprint.aiTable.writer"), "own")
        : ai.bookId && readers.has(ai.bookId) ? cell(t("blueprint.aiTable.gets"), "own")
        : no()),
    };
  });

  const sections: Section[] = [
    { key: "lore", title: String(t("blueprint.aiTable.lore")), rows: sortByHome(entries).map((e) => ({ id: `entry:${e.id}`, label: e.name || String(t("blueprint.aiTable.unnamed")), where: whereOf(e.worldbookId), cells: entryCells(e) })) },
    { key: "vars", title: String(t("blueprint.aiTable.vars")), rows: sortByHome(vars).map((v) => ({ id: `var:${v.id}`, label: v.name, where: whereOf(v.worldbookId), cells: varCells(v) })) },
    { key: "writing", title: String(t("blueprint.aiTable.writings")), rows: writings },
  ].filter((s) => s.rows.length > 0);
  return { ais, sections };
}

const TONE: Record<Tone, string> = {
  yes: "text-zinc-100",
  cond: "text-amber-200/90",
  own: "font-semibold text-pink-200",
  no: "text-zinc-600",
};

/** 「AI 分工表」, opened from 视图 on a card with more than one AI. */
export function AiTable({ world, onJump, onClose }: { world: WorldDefinition; onJump: (objectId: string) => void; onClose: () => void }) {
  const { t } = useTranslation("editor");
  const { ais, sections } = useMemo(() => aiTableSections(world, t as Translate), [world, t]);
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/45 p-6 pt-16" onClick={onClose} data-ai-table>
      <div
        className="studio-pill flex max-h-full w-full max-w-[920px] flex-col overflow-hidden rounded-2xl border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      >
        <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3">
          <span className="text-sm font-bold">{t("blueprint.aiTable.title")}</span>
          <span className="flex-1" />
          <button type="button" onClick={onClose} aria-label={t("blueprint.aiTable.close")} className="rounded-md p-1 text-muted-foreground hover:bg-white/10 hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-[12.5px]">
            <thead className="sticky top-0 z-10 bg-[#141218]">
              <tr>
                <th className="border-b border-white/[0.07] px-4 py-2 text-left font-semibold text-muted-foreground">{t("blueprint.aiTable.thing")}</th>
                <th className="border-b border-white/[0.07] px-3 py-2 text-left font-semibold text-muted-foreground">{t("blueprint.aiTable.where")}</th>
                {ais.map((ai) => <th key={ai.key} className="whitespace-nowrap border-b border-white/[0.07] px-3 py-2 text-left font-semibold text-pink-200">{ai.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {sections.map((section) => [
                <tr key={section.key}><td colSpan={ais.length + 2} className="bg-white/[0.02] px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground">{section.title}</td></tr>,
                ...section.rows.map((row) => (
                  <tr key={row.id} className="hover:bg-white/[0.03]">
                    <td className="max-w-[260px] border-b border-white/[0.04] px-4 py-1.5">
                      <button type="button" onClick={() => onJump(row.id)} className="block max-w-full truncate text-left text-zinc-200 hover:text-white hover:underline">{row.label}</button>
                    </td>
                    <td className="max-w-[140px] truncate border-b border-white/[0.04] px-3 py-1.5 text-zinc-400">{row.where}</td>
                    {row.cells.map((c, i) => <td key={ais[i]!.key} className={cn("whitespace-nowrap border-b border-white/[0.04] px-3 py-1.5", TONE[c.tone])}>{c.text}</td>)}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-4 border-t border-white/[0.07] px-4 py-2.5 text-[11.5px] text-muted-foreground">
          <span><span className={TONE.own}>{t("blueprint.aiTable.legendOwn")}</span></span>
          <span><span className={TONE.cond}>{t("blueprint.aiTable.legendCond")}</span></span>
          <span><span className={TONE.no}>{t("blueprint.aiTable.legendNo")}</span></span>
        </div>
      </div>
    </div>
  );
}
