import { useTranslation } from "react-i18next";
import { Check, Circle } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { isLessonHello, isPlaceholderCardName } from "@/lib/world-templates";
import { cn } from "@/lib/utils";
import { LEARNING_PANEL_EVENT } from "./learn/learning-catalog";
import { hasPlaytested } from "./lib/playtested";

/**
 * What a card needs before it goes out, as four lines under 发布上线. It
 * does not stop anyone publishing: it says what is left, and each line not
 * done yet goes to where it is done. A card could go out with a template's
 * name, no cover, an empty opening and no playtest, and nothing said so.
 */
export function PublishChecklist({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation("editor");
  const name = useEditorStore((s) => s.worldDraft.name);
  const cover = useEditorStore((s) => s.worldDraft.avatar);
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const worldId = useEditorStore((s) => s.serverWorldId);
  const opening = entries.find((e) => e.role === "greeting");
  const items = [
    {
      key: "name", ok: !isPlaceholderCardName(name),
      go: () => document.querySelector<HTMLInputElement>('[data-onboarding="name"]')?.focus(),
    },
    {
      key: "cover", ok: Boolean(cover),
      go: () => window.dispatchEvent(new CustomEvent(LEARNING_PANEL_EVENT, { detail: { panelId: "overview" } })),
    },
    {
      key: "opening", ok: entries.some((e) => e.role === "greeting" && e.content.trim() && !isLessonHello(e.content)),
      go: () => { if (opening) window.dispatchEvent(new CustomEvent("yumina:studio-canvas-focus", { detail: { objId: `greeting:${opening.id}` } })); },
    },
    {
      key: "playtest", ok: hasPlaytested(worldId),
      go: () => window.dispatchEvent(new CustomEvent(LEARNING_PANEL_EVENT, { detail: { panelId: "playtest" } })),
    },
  ] as const;
  return (
    <ul className="mt-3 flex flex-col gap-0.5" data-publish-checklist>
      {items.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            disabled={item.ok}
            onClick={() => { onDone(); window.setTimeout(item.go, 0); }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors",
              item.ok ? "cursor-default text-muted-foreground" : "text-foreground hover:bg-white/[0.06]",
            )}
          >
            {item.ok
              ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              : <Circle className="h-3.5 w-3.5 shrink-0 text-amber-300/80" />}
            <span className={cn(item.ok && "line-through decoration-muted-foreground/40")}>{t(`studio.publishCheck.${item.key}`)}</span>
            {!item.ok && <span className="ml-auto text-[11px] text-amber-200/70">{t("studio.publishCheck.go")}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
