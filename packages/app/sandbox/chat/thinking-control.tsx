import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Lightbulb, LightbulbOff } from "lucide-react";
import { MODEL_THINKING, MODEL_THINKING_LEVELS, type ModelThinking } from "@yumina/shared";
import { useModelControls as useYumina } from "./model-controls-context";
import { ComposerPopover } from "./composer-popover";
import { makeChatT, type ChatStringKey } from "./i18n";

const LABEL: Record<string, ChatStringKey> = {
  none: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh",
};

/** The thinking choices worth showing for the models this turn may run on:
 *  only what changes something. A model whose low / medium / high think the
 *  same gets on / off, or nothing when it can't be switched off either. A local
 *  model never thinks; one we never measured gets levels but not "off". With a
 *  mix pool, a choice shows when any of its models honors it. */
export function thinkingSupport(models: string[]): { canThink: boolean; canOff: boolean; levels: boolean; choices: string[] } {
  const known = models.map((id) => ({ id, kind: (id.startsWith("local/") ? "never" : MODEL_THINKING[id]) as ModelThinking | undefined }));
  const thinkers = known.filter((m) => m.kind !== "never");
  const canThink = thinkers.length > 0;
  const canOff = thinkers.some((m) => m.kind === "toggle");
  const levels = thinkers.some((m) => m.kind === undefined || MODEL_THINKING_LEVELS.has(m.id));
  const choices = !canThink ? [] : levels ? [...(canOff ? ["none"] : []), "low", "medium", "high"] : canOff ? ["none", "low"] : [];
  return { canThink, canOff, levels, choices };
}

/** The composer's thinking / streaming menu, beside the model pill: the same
 *  two AI settings, without a trip to the settings page. */
export function ThinkingControl() {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!anchorRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!api.setGenerationPref) return null;
  const effort = api.reasoningEffort ?? "low";
  const streaming = api.streaming ?? true;
  const models = api.mixMode && api.modelPool.length > 1 ? api.modelPool.map((m) => m.modelId) : [api.selectedModel];
  const { canThink, canOff, levels, choices } = thinkingSupport(models);
  // "Off" on a model that must think runs at its own default: say so rather
  // than show a setting that isn't happening.
  const off = effort === "none" && canOff;
  // On a model without levels any effort is simply "on".
  const shown = !levels && effort !== "none" ? "low" : effort === "minimal" ? "low" : effort;
  const rowLabel = (choice: string) =>
    !levels && choice === "low" ? t("thinkingOn") : choice === "low" && effort === "minimal" ? t("thinkingMinimal") : t(LABEL[choice] ?? "thinkingLow");
  const label = choices.length === 0 ? null : effort === "none" && !canOff ? t("thinkingTitle") : rowLabel(shown);
  const set = (pref: { reasoningEffort?: string; streaming?: boolean }) => api.setGenerationPref?.(pref);

  return (
    <div ref={anchorRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("thinkingButton")}
        title={t("thinkingButton")}
        className="play-composer-model group flex items-center gap-[0.3em] rounded-full border border-current/[0.14] bg-current/[0.05] px-[0.55em] py-[0.375em] text-foreground/75 transition-all hover:border-current/25 hover:bg-current/[0.09] hover:text-foreground"
      >
        {off || !canThink ? <LightbulbOff className="h-3 w-3 shrink-0 opacity-70" /> : <Lightbulb className="h-3 w-3 shrink-0 opacity-70" />}
        {label && <span className="text-[11px] font-medium">{label}</span>}
      </button>
      {open && (
        <ComposerPopover
          anchorRef={anchorRef}
          popoverRef={popoverRef}
          align="left"
          gap={4}
          role="menu"
          ariaLabel={t("thinkingButton")}
          className="w-[min(17rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
        >
          {choices.length > 0 && (
            <>
              <div className="px-3 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">{t("thinkingTitle")}</div>
              {choices.map((level) => {
                const selected = shown === level;
                return (
                  <button
                    key={level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => set({ reasoningEffort: level })}
                    className="flex w-full items-start gap-2.5 rounded-md px-3 py-[0.55em] text-left text-sm text-foreground/85 transition-colors hover:bg-accent"
                  >
                    <span className="mt-[0.2em] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {selected && <Check className="h-3.5 w-3.5 text-primary" />}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span>{rowLabel(level)}</span>
                      {level === "none" && <span className="text-xs leading-snug text-muted-foreground">{t("thinkingOffHint")}</span>}
                    </span>
                  </button>
                );
              })}
              {!canOff && <p className="px-3 pb-1.5 pt-1 text-xs leading-snug text-muted-foreground">{t("thinkingAlways")}</p>}
              <div className="my-1 h-px bg-border" />
            </>
          )}
          {choices.length === 0 && (
            <p className="px-3 pb-1.5 pt-1.5 text-xs leading-snug text-muted-foreground">{t(canThink ? "thinkingAuto" : "thinkingNever")}</p>
          )}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={streaming}
            onClick={() => set({ streaming: !streaming })}
            className="flex w-full items-center gap-3 rounded-md px-3 py-[0.55em] text-left transition-colors hover:bg-accent"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-foreground/85">{t("streamingLabel")}</span>
              <span className="text-xs leading-snug text-muted-foreground">{t("streamingHint")}</span>
            </span>
            <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${streaming ? "bg-primary" : "bg-muted"}`} aria-hidden="true">
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-background shadow transition-all ${streaming ? "left-[1.125rem]" : "left-0.5"}`} />
            </span>
          </button>
        </ComposerPopover>
      )}
    </div>
  );
}
