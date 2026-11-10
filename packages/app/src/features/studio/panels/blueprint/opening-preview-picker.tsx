import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { WorldEntry } from "@yumina/engine";
import { orderedOpenings, resolvePreviewOpening } from "@/features/editor/components/preview/preview-opening";

// The pure part moved next to the renderer that needs it; the picker is the
// canvas's own control and stays here.
export { resolvePreviewOpening };

export function OpeningPreviewPicker({ entries, selectedId, onSelect }: {
  entries: WorldEntry[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("editor");
  const id = useId();
  const openings = orderedOpenings(entries);
  return <div className="nodrag nowheel nokey flex h-8 min-w-0 items-center gap-2 border-b border-white/[0.07] bg-[#17161d] px-2.5 text-[11px]" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <label htmlFor={id} className="shrink-0 text-zinc-400">{t("blueprint.writing.previewOpening")}</label>
    <select id={id} data-canvas-preview-opening value={selectedId ?? ""} disabled={!openings.length} onChange={event => onSelect(event.target.value)} className="h-7 min-w-0 flex-1 rounded border border-white/10 bg-[#111015] px-1.5 text-zinc-200 outline-none focus-visible:border-amber-400/70 disabled:border-transparent disabled:text-zinc-500">
      {!openings.length && <option value="">{t("blueprint.writing.previewNoOpening")}</option>}
      {openings.map(entry => <option key={entry.id} value={entry.id}>{entry.name || t("blueprint.starter.openingTitle")}{entry.enabled ? "" : ` · ${t("blueprint.writing.disabled")}`}</option>)}
    </select>
  </div>;
}
