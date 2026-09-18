import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ArrowRightLeft, ChevronDown, Loader2 } from "lucide-react";
import { PLAY_MODELS, PLAN_HIERARCHY, formatModelId, modelFallbackText, type ModelFallbackNotice } from "@yumina/shared";
import { useYumina } from "../sandbox-context";
import { SandboxPlatformOverlay } from "../platform-overlay-portal";
import { ModelPickerModal } from "./model-picker-modal";

export function ModelFallbackCard({ notice }: { notice: ModelFallbackNotice }) {
  const api = useYumina();
  const [model, setModel] = useState(notice.suggestedModel);
  const [remember, setRemember] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState(false);
  const t = (key: Parameters<typeof modelFallbackText>[1], values?: Record<string, string | number>) => modelFallbackText(api.language, key, values);
  const switching = notice.status === "switching";
  const privateMode = notice.provider === "private";
  const info = privateMode ? undefined : PLAY_MODELS.find((m) => m.id === model);
  const allowed = privateMode || (!!info && PLAN_HIERARCHY.indexOf(api.userPlan as typeof PLAN_HIERARCHY[number]) >= PLAN_HIERARCHY.indexOf(info.minPlan as typeof PLAN_HIERARCHY[number]));
  const canUseBackup = !!model && model !== notice.requestedModel && allowed;
  const chosenName = formatModelId(switching ? notice.suggestedModel : model);
  const busy = submitting || api.readOnly || api.isStreaming;
  const button = "min-h-8 rounded-md px-2 py-1 text-xs transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40";

  const submit = async (selected: string, persist: boolean) => {
    if (submitting) return;
    setSubmitting(true); setActionError(false);
    try { await api.resolveModelFallback(notice.id, selected, persist); }
    catch { setSubmitting(false); setActionError(true); }
  };

  return (
    <section aria-label={t("backup")} aria-live="polite" className="play-model-fallback my-2 min-w-0 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {switching ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" /> : <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-60" />}
        <span className="min-w-0 break-words">{switching ? t("switching", { model: chosenName }) : notice.status === "failed" ? t("failed") : notice.status === "stopped" ? t("stopped") : t("title", { model: formatModelId(notice.failedModel) })}</span>
        {switching ? <button type="button" className={button} onClick={() => api.stopGeneration()}>{t("stop")}</button> : <>
          <button type="button" disabled={busy} onClick={() => void submit(notice.requestedModel, false)} className={button}>{t("compactRetry")}</button>
          <button type="button" disabled={busy} onClick={() => { void api.cancelModelFallback(notice.id).catch(() => setActionError(true)); }} className={`${button} opacity-60`}>{t("compactCancel")}</button>
        </>}
      </div>
      {!switching && <div className="ml-5 mt-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" disabled={busy} onClick={() => setPickerOpen(true)} aria-label={t("choose")} aria-haspopup="dialog" className={`${button} inline-flex max-w-full items-center gap-1.5 border border-border/60 text-foreground/80`}>
            <span className="min-w-0 truncate">{model ? chosenName : t("empty")}</span><ChevronDown className="h-3 w-3 shrink-0 opacity-50" aria-hidden="true" />
          </button>
          <button type="button" disabled={busy || !canUseBackup} onClick={() => void submit(model, remember)} className={`${button} bg-primary/10 text-primary hover:bg-primary/20`}>
            {submitting ? <Loader2 aria-label={t("switching", { model: chosenName })} className="h-3.5 w-3.5 motion-safe:animate-spin" /> : t(remember ? "compactSave" : "compactUse")}
          </button>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-muted-foreground/65">
          <span>{t("compactBilling")}</span>
          <details className="group min-w-0 basis-auto open:basis-full">
            <summary className="w-fit cursor-pointer py-1 hover:text-muted-foreground">{t("compactOptions")}</summary>
            <div className="mt-1 space-y-2 border-l border-border/50 pl-3 text-muted-foreground">
              <label className="flex min-h-8 cursor-pointer items-center gap-2">
                <input type="checkbox" checked={remember} disabled={busy || !canUseBackup} onChange={(e) => setRemember(e.target.checked)} className="h-3.5 w-3.5 shrink-0 accent-primary" />
                <span>{t("remember")}</span>
              </label>
              <p>{t("rememberHint")}</p>
              <p>{t(privateMode ? "privateBilling" : "billing")}</p>
              {[{ label: "original" as const, id: notice.requestedModel }, { label: "current" as const, id: model }].map(({ label, id }) => {
                const price = privateMode ? undefined : PLAY_MODELS.find((m) => m.id === id)?.avgCostMushies;
                return <p key={label}>{t(label)} · {formatModelId(id)} — {typeof price === "number" ? t("average", { cost: price }) : t("priceUnknown")}</p>;
              })}
              {!privateMode && <p>{t("averageNote")}</p>}
              <p>{t(remember ? "autoNote" : "onlyTurn")}</p>
            </div>
          </details>
        </div>
        {model === notice.requestedModel && <p className="mt-1 text-[11px]">{t("sameModel")}</p>}
        {actionError && <p role="alert" className="mt-1 text-xs text-destructive">{t("stopped")}</p>}
        <ModelPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} selectedModel={model} onSelectModel={(id) => { setModel(id); setRemember(false); setPickerOpen(false); }} providerOverride={notice.provider} title={t("backup")} subtitle={t("onlyTurn")} />
      </div>}
    </section>
  );
}

/** Prefer the transcript slot. Creator UIs that replace the transcript still
 * receive an actionable platform panel instead of an invisible consent gate. */
export function ModelFallbackHost() {
  const api = useYumina();
  const notice = api.modelFallback;
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!notice) { setSlot(null); return; }
    const root = document.querySelector('[data-yumina-world-root="true"]');
    if (!root) return;
    let selected: HTMLElement | null = null;
    const locate = () => {
      const next = root.querySelector<HTMLElement>('[data-yumina-model-fallback-slot="true"]');
      if (next !== selected) { selected = next; setSlot(next); }
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [notice?.id]);
  if (!notice || api.readOnly) return null;
  const card = <ModelFallbackCard key={notice.id} notice={notice} />;
  if (slot?.isConnected) return createPortal(card, slot);
  return <SandboxPlatformOverlay><div className="fixed inset-x-0 bottom-0 z-[9000] mx-auto max-h-[80dvh] max-w-xl overflow-y-auto rounded-t-lg border border-border/60 bg-background/95 px-4 py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{card}</div></SandboxPlatformOverlay>;
}

export function ModelFallbackBadge({ record }: { record: import("@yumina/shared").ModelFallbackRecord }) {
  const { language } = useYumina();
  return <details className="mt-1 text-[11px] text-muted-foreground/60"><summary className="flex min-h-6 w-fit cursor-pointer items-center gap-1 py-0.5 hover:text-muted-foreground"><ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />{modelFallbackText(language, "badge")}</summary><p className="pb-1">{modelFallbackText(language, record.automatic ? "autoRecord" : "record", { model: formatModelId(record.requestedModel) })}</p></details>;
}
