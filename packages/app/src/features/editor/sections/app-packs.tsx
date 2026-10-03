import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plus } from "lucide-react";
import {
  appPack,
  appPackSample,
  appPackSets,
  appPackSource,
  appPackSummaries,
  appPackVariableId,
  type AppPackId,
} from "@yumina/engine";
import { cn } from "@/lib/utils";
import { feedback } from "@/lib/feedback";
import { bundleAndCompile } from "@/features/studio/lib/tsx-bundler";
import { useEditorStore } from "@/stores/editor";

/**
 * In-story apps — the picker.
 *
 * Every card shows the app itself, rendered live from its real source with
 * sample data, because "a phone the characters text you on" is understood the
 * moment you see it and never from a paragraph. Installing goes through the
 * same importBundle as any bundle; the app then sits in the dock beside the
 * chat, and the AI fills it as the story goes.
 */

const PREVIEW_WIDTH = 410;

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function AppPackPreview({ id, language }: { id: AppPackId; language: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / PREVIEW_WIDTH));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const Preview = useMemo(() => {
    const variables = { [appPackVariableId(id)]: appPackSample(id, language) };
    const api = () => ({
      variables,
      language,
      sendMessage: () => {},
      setVariable: () => {},
      patchVariables: () => Promise.resolve(),
      setComposerDraft: () => {},
    });
    const result = bundleAndCompile({ files: { "index.tsx": appPackSource(id, language) }, entryFile: "index.tsx" }, api);
    return result.Component;
  }, [id, language]);

  return (
    <div ref={frameRef} className="relative h-[200px] overflow-hidden rounded-t-xl bg-[#f4f5f9]" aria-hidden="true">
      <div style={{ width: PREVIEW_WIDTH, transform: `scale(${scale})`, transformOrigin: "top left", pointerEvents: "none" }}>
        {Preview ? (
          <PreviewBoundary>
            <Preview />
          </PreviewBoundary>
        ) : null}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#f4f5f9] to-transparent" />
    </div>
  );
}

export function AppPacksSection({ language, onInstalled }: { language: string; onInstalled?: () => void }) {
  const { t } = useTranslation("editor");
  const importBundle = useEditorStore((s) => s.importBundle);
  const installedBundles = useEditorStore((s) => s.worldDraft.installedBundles);
  const apps = useMemo(() => appPackSummaries(language), [language]);
  const sets = useMemo(() => appPackSets(language), [language]);

  // An app already on the card shows as added: installing it twice would only
  // add a second copy of the same dock button.
  const installed = useMemo(() => {
    const vars = new Set((installedBundles ?? []).flatMap((b) => b.variableIds));
    return new Set(apps.filter((a) => vars.has(appPackVariableId(a.id))).map((a) => a.id));
  }, [installedBundles, apps]);

  const add = (ids: AppPackId[]) => {
    const fresh = ids.filter((id) => !installed.has(id));
    for (const id of fresh) importBundle(appPack(id, language));
    if (fresh.length === 0) return;
    const names = fresh.map((id) => apps.find((a) => a.id === id)?.name ?? id).join(" · ");
    feedback.notice(t("appPacks.installed", { defaultValue: "Added {{name}}", name: names }));
    onInstalled?.();
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{t("appPacks.title", { defaultValue: "In-story apps" })}</h2>
        <p className="mt-1 max-w-[66ch] text-[11.5px] leading-relaxed text-muted-foreground">
          {t("appPacks.blurb", {
            defaultValue:
              "Apps the player opens from a dock at the side of the chat. Each one keeps its own data in one variable, and the AI fills it in as the story goes — you don't write the app yourself.",
          })}
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 text-[11.5px] font-semibold text-muted-foreground">
          {t("appPacks.sets", { defaultValue: "Starter sets — what most cards of each kind track" })}
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {sets.map((set) => {
            const done = set.packs.every((id) => installed.has(id));
            return (
              <button
                key={set.id}
                type="button"
                disabled={done}
                onClick={() => add(set.packs)}
                className={cn(
                  "flex flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  done ? "border-emerald-500/30 bg-emerald-500/10" : "border-border hover:border-primary/60 hover:bg-primary/5",
                )}
              >
                <span className="text-[12.5px] font-semibold">{set.name}</span>
                <span className="text-[16px] leading-none tracking-[2px]">
                  {set.packs.map((id) => apps.find((a) => a.id === id)?.icon).join("")}
                </span>
                <span className={cn("text-[11px]", done ? "text-emerald-400" : "text-primary")}>
                  {done
                    ? t("appPacks.setAdded", { defaultValue: "All added" })
                    : t("appPacks.addSet", { defaultValue: "Add all four" })}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {apps.map((a) => {
          const added = installed.has(a.id);
          return (
            <div key={a.id} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
              <AppPackPreview id={a.id} language={language} />
              <div className="flex flex-1 flex-col p-3.5">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-lg leading-none" aria-hidden="true">{a.icon}</span>
                  <h3 className="text-[13px] font-semibold">{a.name}</h3>
                </div>
                <p className="mb-3 flex-1 text-[11.5px] leading-relaxed text-muted-foreground">{a.description}</p>
                <button
                  type="button"
                  disabled={added}
                  onClick={() => add([a.id])}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors",
                    added ? "bg-emerald-500/15 text-emerald-300" : "bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                >
                  {added ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  {added
                    ? t("appPacks.added", { defaultValue: "Added — in the dock" })
                    : t("appPacks.add", { defaultValue: "Add app" })}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="max-w-[66ch] text-[10.5px] leading-relaxed text-muted-foreground/75">
        {t("appPacks.footnote", {
          defaultValue:
            "The app's words follow the card's language (Chinese, English or Spanish). Remove it from the Bundles page and its button, data and rules go with it.",
        })}
      </p>
    </div>
  );
}

/** The editor-shell section: packs are authored content in the CARD's
 *  language, not the reader's menu language — a Chinese card gets a Chinese
 *  phone even when its author browses Yumina in English. Falls back to the UI
 *  language for a card that hasn't set one. */
export function AppPacksEditorSection() {
  const { i18n } = useTranslation("editor");
  const cardLanguage = useEditorStore((s) => s.worldDraft.language);
  return <AppPacksSection language={cardLanguage || i18n.resolvedLanguage || "en"} />;
}
