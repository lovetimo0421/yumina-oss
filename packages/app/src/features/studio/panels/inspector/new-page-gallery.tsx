import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { UI_PAGE_TEMPLATES, UI_TEMPLATES, getUiTemplate, type UiPageTemplateId } from "@yumina/engine";
import { useOpeningCount } from "./new-page-hooks";
import { useLearningWorkspace } from "../../learn/learning-workspace";

/**
 * 新建一页 — the page-template gallery, and the strip of pages it adds to.
 *
 * Shaped after a slide deck on purpose: pages down the left in the order the
 * player meets them, and "new page" opening a sheet of ready-made layouts to
 * pick from. What is ready-made is the FUNCTION — the variables, the buttons,
 * where the page goes next, what the AI is told — so every tile says what it
 * wires up. The look is left to the card's theme and the creator's hand.
 */

// ── Thumbnails ─────────────────────────────────────────────────────────────
//
// Real screenshots of each page, filled in and themed, so a creator sees what
// the player will see. One set in Chinese, one in English for everyone else.

function thumbSrc(id: string, lang: string): string {
  return `/create/page-templates/${id}${lang.startsWith("zh") ? "" : ".en"}.webp`;
}

// ── The sheet ──────────────────────────────────────────────────────────────

export function NewPageGallery({
  open, onClose, onPick, onPickLayout, title,
}: {
  open: boolean;
  onClose: () => void;
  /** A template id, or "blank" for an empty page. */
  onPick: (id: UiPageTemplateId | "blank") => void;
  /** A whole-screen layout (it replaces the interface; the caller asks). */
  onPickLayout?: (id: string) => void;
  /** The heading, when opened for something other than a new page. */
  title?: string;
}) {
  const { t, i18n } = useTranslation("editor");
  const openings = useOpeningCount();
  // Mid-tutorial the guide steps out of the gallery's way (it is a dialog),
  // so the gallery says its own part: what is in here, and that choosing
  // nothing is fine too.
  const { step } = useLearningWorkspace();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  if (!open) return null;

  const tile = (id: UiPageTemplateId | "blank", body: ReactNode, name: string, desc: string, wired: string | null, blocked: string | null, pick: () => void = () => onPick(id)) => (
    <button
      key={id}
      type="button"
      data-page-template={id}
      disabled={Boolean(blocked)}
      onClick={pick}
      className="group flex flex-col gap-2 rounded-xl p-2 text-left transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <div className="aspect-[16/10] w-full overflow-hidden rounded-lg border border-border/70 bg-background/60 transition-colors group-hover:border-primary/60 group-disabled:group-hover:border-border/70">
        {body}
      </div>
      <div className="flex flex-col gap-0.5 px-0.5">
        <span className="text-[13px] font-semibold text-foreground">{name}</span>
        <span className="text-[11.5px] leading-snug text-muted-foreground">{desc}</span>
        {blocked
          ? <span className="text-[11px] text-amber-400/90">{blocked}</span>
          : wired && <span className="text-[11px] text-primary/90">{wired}</span>}
      </div>
    </button>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center modal-backdrop p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div role="dialog" aria-modal="true" data-state="open" aria-label={t("studio.pageTemplates.title")} data-testid="new-page-gallery"
        className="flex max-h-[90vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start gap-4 border-b border-border/60 px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-foreground">{title ?? t("studio.pageTemplates.title")}</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">{t("studio.pageTemplates.sub")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("studio.pageTemplates.close")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {step === "interface" && (
          <div data-testid="gallery-tip" className="mx-6 mt-4 flex items-center gap-3 rounded-xl border border-[#f0c674]/40 bg-[#f0c674]/[0.07] px-3 py-2.5">
            <img src="/mushie-stand.png" alt="" draggable={false} className="h-12 w-10 shrink-0 object-contain" />
            <p className="text-[13px] leading-relaxed text-foreground/90">{t("studio.pageTemplates.tutorTip")}</p>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {/* Whole screens: the four layouts. One gallery for every template
              the card can take; they used to hide in 外观 → 版式. */}
          {onPickLayout && (
            <section className="mb-4" data-testid="gallery-layouts">
              <h3 className="px-2 pb-2 text-[12px] font-semibold text-primary">{t("studio.pageTemplates.groupWhole")}</h3>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
                {UI_TEMPLATES.map((layout) => {
                  const needs = (getUiTemplate(layout.id)?.needs ?? []).map((need) => String(t(`studio.layout.vars.${need.key}` as never)));
                  return tile(
                    `layout:${layout.id}` as UiPageTemplateId,
                    <img src={thumbSrc(`layout-${layout.id}`, i18n.language)} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />,
                    String(t(`studio.layout.preset.${layout.id}` as never)),
                    String(t(`studio.layout.presetHint.${layout.id}` as never)),
                    needs.length ? String(t("studio.layout.brings", { names: needs.join("、") })) : null,
                    null,
                    () => onPickLayout(layout.id),
                  );
                })}
              </div>
            </section>
          )}
          {([["opening", "studio.pageTemplates.groupOpening"], ["play", "studio.pageTemplates.groupPlay"]] as const).map(([group, heading]) => (
            <section key={group} className="mb-4">
              <h3 className="px-2 pb-2 text-[12px] font-semibold text-primary">{t(heading)}</h3>
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-4">
                {UI_PAGE_TEMPLATES.filter((tpl) => (tpl.place === "play") === (group === "play")).map((tpl) => {
                  const base = `studio.pageTemplates.tpl.${tpl.id}`;
                  return tile(
                    tpl.id,
                    <img src={thumbSrc(tpl.id, i18n.language)} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />,
                    String(t(`${base}.name` as never)),
                    String(t(`${base}.desc` as never)),
                    String(t("studio.pageTemplates.wired", { what: t(`${base}.wired` as never, { count: tpl.minGreetings ? Math.max(openings, 3) : openings }) })),
                    null,
                  );
                })}
                {group === "opening" && tile("blank", <div className="flex h-full items-center justify-center text-muted-foreground/50"><Plus className="h-8 w-8" strokeWidth={1.5} /></div>, t("studio.pageTemplates.blank"), t("studio.pageTemplates.blankDesc"), null, null)}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
