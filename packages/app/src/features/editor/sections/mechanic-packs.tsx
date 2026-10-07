import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Sparkles, TriangleAlert, Zap } from "lucide-react";
import { mechanicPack, mechanicPackSummaries, type MechanicPackId } from "@yumina/engine";
import { AppPacksSection } from "./app-packs";
import { cn } from "@/lib/utils";
import { feedback } from "@/lib/feedback";
import { useEditorStore } from "@/stores/editor";

/**
 * Mechanic packs — the path from "0 variables" to a card that actually
 * tracks something.
 *
 * A pack installs through the same `importBundle` a community bundle uses, so
 * it arrives colour-coded on the canvas, remaps ids around anything the card
 * already has, and uninstalls cleanly from the Bundles page. Nothing here is
 * a second content system.
 */
export function MechanicPacksSection({ onInstalled }: { onInstalled?: () => void } = {}) {
  const { t, i18n } = useTranslation("editor");
  const importBundle = useEditorStore((s) => s.importBundle);
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const [justInstalled, setJustInstalled] = useState<MechanicPackId | null>(null);

  // The pack is authored content in the CARD's language, not the reader's menu
  // language — a Chinese card gets Chinese keywords even when its author is
  // browsing Yumina in English. Falls back to the UI language for a card that
  // has not declared one yet.
  const packLanguage = worldDraft.language || i18n.resolvedLanguage || "en";
  const packs = useMemo(() => mechanicPackSummaries(packLanguage), [packLanguage]);
  const install = (id: MechanicPackId, name: string) => {
    const bundle = mechanicPack(id, packLanguage);
    if (!bundle) return;
    importBundle(bundle);
    setJustInstalled(id);
    feedback.notice(t("packs.installed", { defaultValue: "Added {{name}}", name }));
    onInstalled?.();
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <AppPacksSection language={packLanguage} onInstalled={onInstalled} />

      <div className="mt-3 border-t border-border pt-4">
        <h2 className="text-sm font-semibold">
          {t("packs.title", { defaultValue: "Mechanic packs" })}
        </h2>
        <p className="mt-1 max-w-[62ch] text-[11.5px] leading-relaxed text-muted-foreground">
          {t("packs.blurb", {
            defaultValue:
              "A working set of variables, behaviours and lore, added in one click. Everything it adds is ordinary card content — open it, read it, change it.",
          })}
        </p>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {packs.map((pack) => {
          const installed = justInstalled === pack.id;
          return (
            <div
              key={pack.id}
              className="flex flex-col rounded-xl border border-border bg-card p-3.5"
            >
              <div className="mb-1.5 flex items-center gap-2">
                {pack.deterministic ? (
                  <Zap className="h-4 w-4 shrink-0 text-sky-400/80" />
                ) : (
                  <Sparkles className="h-4 w-4 shrink-0 text-amber-400/80" />
                )}
                <h3 className="text-[13px] font-semibold">{pack.name}</h3>
              </div>

              <p className="mb-2.5 flex-1 text-[11.5px] leading-relaxed text-muted-foreground">
                {pack.description}
              </p>

              <div className="mb-2 flex flex-wrap gap-1.5">
                {pack.variables > 0 && (
                  <Chip className="bg-sky-500/15 text-sky-300">
                    {t("packs.countVariables", { defaultValue: "{{count}} variables", count: pack.variables })}
                  </Chip>
                )}
                {pack.behaviors > 0 && (
                  <Chip className="bg-orange-500/15 text-orange-300">
                    {t("packs.countBehaviors", { defaultValue: "{{count}} behaviours", count: pack.behaviors })}
                  </Chip>
                )}
                {pack.entries > 0 && (
                  <Chip className="bg-violet-500/15 text-violet-300">
                    {t("packs.countEntries", { defaultValue: "{{count}} entries", count: pack.entries })}
                  </Chip>
                )}
              </div>

              {/* The honest line. "The engine guarantees this" and "the model
                  usually complies" are different promises, and an author
                  choosing between two packs deserves to know which one is on
                  offer before they build a card around it. */}
              <p
                className={cn(
                  "mb-2.5 flex items-start gap-1.5 text-[10.5px] leading-relaxed",
                  pack.deterministic ? "text-emerald-400/85" : "text-amber-400/85",
                )}
              >
                {pack.deterministic ? (
                  <Check className="mt-px h-3 w-3 shrink-0" />
                ) : (
                  <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
                )}
                {pack.deterministic
                  ? t("packs.deterministic", {
                      defaultValue: "Real variables — the engine applies them, so switching model changes nothing.",
                    })
                  : t("packs.promptOnly", {
                      defaultValue: "Prompt only — the model decides whether to comply. Use variables when it has to be exact.",
                    })}
              </p>

              <button
                type="button"
                onClick={() => install(pack.id, pack.name)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors",
                  installed
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                {installed
                  ? t("packs.addedAgain", { defaultValue: "Added — add again" })
                  : t("packs.add", { defaultValue: "Add to this card" })}
              </button>
            </div>
          );
        })}
      </div>

      <p className="max-w-[62ch] text-[10.5px] leading-relaxed text-muted-foreground/75">
        {t("packs.footnote", {
          defaultValue:
            "Packs stack — affection and survival can live on the same card. Remove one from the Bundles page and everything it brought goes with it.",
        })}
      </p>
    </div>
  );
}

function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px]", className)}>
      {children}
    </span>
  );
}
