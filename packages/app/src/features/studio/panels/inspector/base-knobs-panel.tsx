import { useTranslation } from "react-i18next";
import { ChevronRight, X } from "lucide-react";
import type { UiKnobGroup } from "@yumina/engine";
import { KnobPanel } from "./knob-panel";

/**
 * The knobs of a decomposed (拆积木) card, inside the arranged-screen editor.
 *
 * Decomposing wraps the card's own frontend as the bottom layer of an
 * interface document, and a card with a document opens in the arranged-screen
 * editor, where only the document's parts can be picked. The knob panel lived
 * only in the raw-frontend inspector, which a decomposed card never reaches,
 * so after 拆积木 the original screen could not be clicked and its knobs had no
 * way in (2026-11-04, nikira). This is that way in: click a region of the
 * original screen, or open the list from the page panel.
 */

/** The region a click landed in: the nearest `data-knob-group` around it. */
export function knobRegionOf(el: Element | null): string | null {
  const region = el?.closest?.("[data-knob-group]");
  return region?.getAttribute("data-knob-group") ?? null;
}

/** Groups for a clicked region. The AI names regions and groups separately and
 *  they drift ("shell" on the markup, "shell-colors" / "shell-spacing" as
 *  groups), so a region matches its exact group, else every group named under
 *  it, else all of them: a click on the original screen always opens knobs. */
export function knobGroupsForRegion(groups: UiKnobGroup[], region: string | null): UiKnobGroup[] {
  if (!region) return groups;
  const exact = groups.filter((g) => g.id === region);
  if (exact.length) return exact;
  const under = groups.filter((g) => g.id.startsWith(`${region}-`) || g.id.startsWith(`${region}.`) || g.id.startsWith(`${region}_`));
  return under.length ? under : groups;
}

export function BaseKnobsPanel({
  groups,
  region,
  onSetKnob,
  onClose,
}: {
  groups: UiKnobGroup[];
  region: string | null;
  onSetKnob: (groupId: string, knobId: string, value: string | number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("editor");
  const shown = knobGroupsForRegion(groups, region);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground" title={t("studio.inspect.knobsHint")}>{t("studio.inspect.baseKnobsTitle")}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("studio.inspect.baseKnobsClose")}
          title={t("studio.inspect.baseKnobsClose")}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {shown.map((group, i) => (
          <details key={group.id} open={i === 0} className="group/knobs rounded-lg border border-border/50">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-foreground/85 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open/knobs:rotate-90" />
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground/60">{group.knobs.length}</span>
            </summary>
            <div className="px-2 pb-2">
              <KnobPanel bare group={group} onChange={(knobId, value) => onSetKnob(group.id, knobId, value)} />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

/** The door from the page panel when nothing is picked. */
export function BaseKnobsButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { t } = useTranslation("editor");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-xs text-foreground/85 transition-colors hover:bg-accent"
    >
      <span className="min-w-0 flex-1 truncate">{t("studio.inspect.baseKnobsOpen", { count })}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
