import { useEffect, useRef, useState } from "react";
import type { makeChatT } from "./i18n";
import type { TurnImageSettings } from "./turn-images";

type T = ReturnType<typeof makeChatT>;

/** Longest picture description the server takes (packages/server per-turn-image/passage.ts). */
export const OWN_PROMPT_MAX = 1000;
/** Longest passage of a reply the player can pick to be drawn. */
export const PASSAGE_MAX = 1200;

/** "free · 3 left" / "12 mushies" / nothing for unlimited players. */
export function turnImageCost(settings: TurnImageSettings | null, t: T): string {
  return settings?.unlimited ? "" : settings?.freeLeft ? t("turnImageCostFree", { count: settings.freeLeft })
    : settings?.price ? t("turnImageCostPrice", { price: settings.price }) : "";
}

/** The player writes the whole picture themselves. Same look as the redraw note. */
export function OwnPromptForm({ t, cost, label, onSubmit }: { t: T; cost: string; label: string; onSubmit: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const submit = () => { if (prompt.trim()) onSubmit(prompt.trim()); };
  return (
    <div className="grid gap-2 px-1.5 pb-2 pt-1">
      <textarea ref={ref} value={prompt} maxLength={OWN_PROMPT_MAX} rows={4} onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && prompt.trim()) { e.preventDefault(); submit(); } }}
        placeholder={t("turnImageOwnPromptPlaceholder")} aria-label={t("turnImageOwnPrompt")}
        className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] leading-snug text-foreground focus:border-primary focus:outline-none" />
      <button type="button" disabled={!prompt.trim()} onClick={submit}
        className="justify-self-end rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40">
        {cost ? `${label} · ${cost}` : label}
      </button>
    </div>
  );
}
