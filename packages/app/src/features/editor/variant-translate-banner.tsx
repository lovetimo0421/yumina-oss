import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages, Sparkles, X } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { LANGUAGE_LABELS, variantNeedsTranslation } from "@/lib/languages";
import { STUDIO_ASK_EVENT, type StudioAskDetail } from "@/features/studio/lib/block-ask";

const DISMISS_KEY = (id: string) => `yumina-variant-translate-dismissed:${id}`;

/**
 * A new language version starts as a copy of the card it came from, so the
 * 「English」 version of a Chinese card is, at first, the Chinese card. There
 * is no automatic translation of a whole card in the product (the community
 * translation stack translates posts and reviews, and the card i18n pipelines
 * are offline scripts), so the version says so plainly and offers the one
 * tool that can do it: the assistant, with the request already written.
 *
 * Shown while the version is tagged with a language its text is not written
 * in, until it is translated or dismissed.
 */
export function VariantTranslateBanner({ canAsk = true }: { canAsk?: boolean }) {
  // Keyed by the version, so switching to a sibling re-reads its own dismissal.
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  return <Banner key={serverWorldId ?? "none"} canAsk={canAsk} />;
}

function Banner({ canAsk }: { canAsk: boolean }) {
  const { t } = useTranslation("editor");
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const language = useEditorStore((s) => s.language);
  const variantCount = useEditorStore((s) => s.variants.length);
  const name = useEditorStore((s) => s.worldDraft.name);
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const readOnly = useEditorStore((s) => s.readOnlyInspect || s.guestMode);
  const [dismissed, setDismissed] = useState(() => {
    try { return !!serverWorldId && localStorage.getItem(DISMISS_KEY(serverWorldId)) === "1"; } catch { return false; }
  });

  const needs = useMemo(() => {
    if (variantCount < 2 || !language) return false;
    const text = [name, ...entries.slice(0, 40).map((e) => `${e.name}\n${e.content ?? ""}`)].join("\n");
    return variantNeedsTranslation(language, text);
  }, [variantCount, language, name, entries]);

  if (!needs || dismissed || readOnly || !serverWorldId) return null;
  const languageName = LANGUAGE_LABELS[language!] ?? language!;

  const ask = () => {
    const detail: StudioAskDetail = { prompt: t("variantTranslate.prompt", { language: languageName }) };
    window.dispatchEvent(new CustomEvent(STUDIO_ASK_EVENT, { detail }));
  };
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY(serverWorldId), "1"); } catch { /* per-tab only */ }
  };

  return (
    <div data-variant-translate-banner className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-primary/25 bg-primary/[0.07] px-4 py-2 text-xs text-foreground" role="status">
      <Languages className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 leading-relaxed">{t("variantTranslate.banner", { language: languageName })}</span>
      {canAsk && (
        <button
          type="button"
          onClick={ask}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t("variantTranslate.ask", { language: languageName })}
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        className="hover-surface inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground"
        aria-label={t("variantTranslate.dismiss")}
        title={t("variantTranslate.dismiss")}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
