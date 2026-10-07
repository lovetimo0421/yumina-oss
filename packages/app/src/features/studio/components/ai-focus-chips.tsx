import { useTranslation } from "react-i18next";
import { BookOpen, Boxes, LayoutGrid, MessageCircle, Music, Smartphone, Sparkles, Variable, X, Zap, type LucideIcon } from "lucide-react";
import { useAiFocus, type AiFocusKind } from "../lib/ai-focus";
import { focusKind, toneChip, toneText } from "../lib/kind-tone";
import { cn } from "@/lib/utils";

const FOCUS_ICON: Record<AiFocusKind, LucideIcon> = {
  entry: BookOpen,
  greeting: MessageCircle,
  variable: Variable,
  rule: Zap,
  audio: Music,
  module: Boxes,
  world: Sparkles,
  block: LayoutGrid,
  frontend: Smartphone,
};

/**
 * Above the composer: what the assistant is pointed at. Picked on the canvas,
 * taken away here; nothing shows until something is picked.
 */

export function AiFocusChips() {
  const { t } = useTranslation("editor");
  const items = useAiFocus((s) => s.items);
  const remove = useAiFocus((s) => s.remove);
  const clear = useAiFocus((s) => s.clear);
  if (items.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1 px-1" data-ai-focus-chips>
      {items.map((item) => {
        const Icon = FOCUS_ICON[item.kind];
        const kind = focusKind(item.kind);
        return (
          <span key={item.id} className={cn("inline-flex max-w-[180px] items-center gap-1 rounded-md border py-0.5 pl-1.5 pr-0.5 text-[11px]", toneChip(kind))}>
            <Icon className={cn("h-3 w-3 shrink-0", toneText(kind))} aria-hidden="true" />
            <span className="min-w-0 truncate">{item.title}</span>
            <button type="button" onClick={() => remove(item.id)} title={t("studio.focus.remove")} aria-label={t("studio.focus.remove")}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground">
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        );
      })}
      {items.length > 1 && (
        <button type="button" onClick={clear} className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
          {t("studio.focus.clear")}
        </button>
      )}
    </div>
  );
}
