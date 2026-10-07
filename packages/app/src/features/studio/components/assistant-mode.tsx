import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import { useStudioStore } from "@/stores/studio";
import { cn } from "@/lib/utils";

const MODES = ["advise", "build"] as const;

/**
 * 构思 or 搭建, from the composer's corner: the current one shows, a click
 * opens the other. 构思 carries what Yumina can do and an outline of the card
 * instead of the building manuals, changes nothing on the card, and ends in a
 * one-page brief that 搭建 reads.
 */
export function AssistantModeSwitch({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation("editor");
  const mode = useStudioStore((s) => s.assistantMode);
  const setMode = useStudioStore((s) => s.setAssistantMode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0" data-testid="assistant-mode">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("studio.aiChat.mode.label")}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 rounded-md bg-primary/15 py-0.5 pl-2 pr-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25 disabled:opacity-50"
      >
        {t(`studio.aiChat.mode.${mode}` as never)}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-[calc(100%+6px)] left-0 z-50 min-w-[96px] rounded-lg border border-border bg-popover p-1 shadow-xl">
          {MODES.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={mode === value}
              onClick={() => { setMode(value); setOpen(false); }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                mode === value ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="flex-1">{t(`studio.aiChat.mode.${value}` as never)}</span>
              {mode === value && <Check className="h-3 w-3 text-primary" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
