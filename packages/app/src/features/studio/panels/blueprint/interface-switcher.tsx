import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Store, X } from "lucide-react";
import { UI_TEMPLATES, detectUiTemplate, type WorldDefinition } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { feedback } from "@/lib/feedback";
import { captureHubEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { layoutChoiceArgs } from "./look-actions";
import { isDefaultChatInterface } from "./starter-state";
import { thumbSrc } from "../inspector/new-page-gallery";
import { HAS_PACK_MARKET, MarketInterfaceTiles } from "@/edition/slots";

/** Opens 「换界面」 from anywhere on the board (the interface block's button). */
export const INTERFACE_SWITCHER_EVENT = "yumina:studio-switch-interface";

/** "chat" is the platform's own chat; "custom" an interface no layout made. */
type Look = string;

function lookOf(world: Pick<WorldDefinition, "uiDoc" | "rootComponent">): Look {
  if (world.uiDoc) {
    const layout = detectUiTemplate(world.uiDoc);
    if (layout) return layout;
    return (world.uiDoc.pages ?? []).some((page) => page.elements.length > 0) ? "custom" : "chat";
  }
  return isDefaultChatInterface(world) ? "chat" : "custom";
}

/**
 * 「换界面」 — the card's interface, chosen the way a slide's design is in
 * PowerPoint: a column of looks beside the board, and a click puts one on.
 * The interface block on the board is the preview (the card's own name,
 * opening and character, running), so there is no confirm dialog and no
 * gallery to understand first; 撤回 puts back what was there when the column
 * opened, 用这个 keeps what is on.
 *
 * Every try starts from that original, so trying five looks does not leave
 * the variables of four of them behind. A try and its way back are one undo
 * step each.
 */
export function InterfaceSwitcher({ onClose, onMarket }: { onClose: () => void; onMarket: () => void }) {
  const { t, i18n } = useTranslation("editor");
  const [original] = useState<Look>(() => lookOf(useEditorStore.getState().worldDraft));
  const [trying, setTrying] = useState<Look | null>(null);
  const before = useRef<{ snapshot: Pick<WorldDefinition, "uiDoc" | "rootComponent">; created: string[] } | null>(null);
  const translate = (key: string, options?: Record<string, unknown>) => String(t(key as never, options as never));

  const put = (look: Look) => {
    const store = useEditorStore.getState();
    if (store.readOnlyInspect) return;
    if (look === (trying ?? original)) return;
    store.beginBatch();
    try {
      if (before.current) useEditorStore.getState().restoreInterface(before.current.snapshot, before.current.created);
      else {
        const world = store.worldDraft;
        before.current = { snapshot: { uiDoc: world.uiDoc, rootComponent: world.rootComponent }, created: [] };
      }
      before.current.created = [];
      if (look === original) {
        before.current = null;
        setTrying(null);
        return;
      }
      const layout = look === "chat" ? null : look;
      const had = new Set(useEditorStore.getState().worldDraft.variables.map((v) => v.id));
      const { strings, names, defaults } = layoutChoiceArgs(layout, translate, useEditorStore.getState().worldDraft.name);
      useEditorStore.getState().applyUiTemplate(layout, strings, names, defaults);
      before.current.created = useEditorStore.getState().worldDraft.variables.filter((v) => !had.has(v.id)).map((v) => v.id);
      setTrying(look);
    } finally {
      useEditorStore.getState().commitBatch();
    }
  };

  const revert = () => {
    if (!before.current) return;
    useEditorStore.getState().restoreInterface(before.current.snapshot, before.current.created);
    before.current = null;
    setTrying(null);
  };

  const keep = () => {
    if (trying) {
      const store = useEditorStore.getState();
      captureHubEvent("studio_look_applied", { world_id: store.serverWorldId ?? "", kind: "layout", id: trying === "chat" ? "none" : trying });
      // What the look it replaced made and nothing else uses: offered, as
      // the full editor's picker does, never removed for the creator.
      const leftovers = store.templateLeftovers;
      if (leftovers && leftovers.variableIds.length > 0) {
        feedback.persistent(
          t("studio.layout.leftovers", { count: leftovers.variableIds.length }),
          { label: t("studio.layout.leftoversDiscard"), onClick: () => useEditorStore.getState().discardTemplateLeftovers() },
        );
      }
    }
    before.current = null;
    setTrying(null);
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); keep(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const grid = useRef<HTMLDivElement>(null);
  const on = trying ?? original;
  const tile = (look: Look, name: string, body: React.ReactNode) => (
    <button
      key={look}
      type="button"
      data-switch-look={look}
      aria-pressed={on === look}
      onClick={() => put(look)}
      className={cn(
        "group flex flex-col gap-1 rounded-lg border p-1 text-left transition-colors",
        on === look ? "border-[#f0c674] bg-[#f0c674]/[0.06]" : "border-white/[0.07] hover:border-white/25",
      )}
    >
      <div className="aspect-[16/10] w-full overflow-hidden rounded-md bg-black/40">{body}</div>
      <span className="flex items-center gap-1 px-0.5 text-[11px] font-semibold text-foreground">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {look === original && <span className="shrink-0 text-[10px] font-medium text-muted-foreground">{t("blueprint.look.current")}</span>}
      </span>
    </button>
  );

  return (
    <div className="studio-pill flex max-h-[calc(100vh-190px)] w-[340px] flex-col overflow-hidden rounded-xl border" data-interface-switcher="">
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-foreground">{t("blueprint.look.switch")}</span>
        {HAS_PACK_MARKET && (
          // The market is further down the same list; this is the way there.
          <button
            type="button"
            data-switch-to-market=""
            onClick={() => grid.current?.querySelector("[data-switch-market]")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 text-[11px] font-semibold text-foreground/80 transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            <Store className="h-3 w-3" />{t("blueprint.look.market")}
          </button>
        )}
        <button
          type="button"
          onClick={keep}
          aria-label={t("common:close", { defaultValue: "Close" })}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={grid} className="grid min-h-0 grid-cols-2 gap-2 overflow-y-auto p-2.5">
        {original === "custom" && tile("custom", t("blueprint.look.custom"), (
          <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">{t("blueprint.look.custom")}</div>
        ))}
        {tile("chat", t("studio.layout.none"), (
          // The platform's chat has no screenshot: a sketch of one.
          <div className="flex h-full flex-col justify-center gap-1.5 bg-[#101119] px-3">
            <span className="h-2 w-3/5 rounded-full bg-white/15" />
            <span className="ml-auto h-2 w-2/5 rounded-full bg-[#f0c674]/40" />
            <span className="h-2 w-1/2 rounded-full bg-white/15" />
          </div>
        ))}
        {UI_TEMPLATES.map((layout) => tile(
          layout.id,
          t(`studio.layout.preset.${layout.id}` as never),
          <img src={thumbSrc(`layout-${layout.id}`, i18n.language)} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />,
        ))}
        {/* Scrolling on past the built-in looks runs into the market's. */}
        <MarketInterfaceTiles onPicked={keep} onAll={() => { keep(); onMarket(); }} />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-white/[0.07] px-3 py-2">
        <button
          type="button"
          data-switch-revert=""
          disabled={!trying}
          onClick={revert}
          className="shrink-0 rounded-md border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-foreground transition-colors hover:bg-white/[0.06] disabled:opacity-40"
        >
          {t("blueprint.look.revert")}
        </button>
        <button
          type="button"
          data-switch-keep=""
          disabled={!trying}
          onClick={keep}
          className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          <Check className="h-3 w-3" />{t("blueprint.look.keep")}
        </button>
      </div>
    </div>
  );
}
