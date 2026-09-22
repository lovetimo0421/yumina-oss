import { useState } from "react";
import { Check, ImagePlus, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SMART_IMAGE_MODELS, SMART_IMAGE_4K_COST_FACTOR, getSmartImageCapabilities, getSmartImageModel,
  resolveSmartImageAspect, resolveSmartImageResolution } from "@yumina/shared";
import type { ImageBatchItem, ImageBatchProposalItem } from "@yumina/shared";
import { cn } from "@/lib/utils";
import { resolveImageUrl } from "@/lib/asset-url";
import type { StudioImageBatchEdits, StudioImageBatchProposal } from "../lib/types";
import { defaultImageBatchSelection, imageBatchRetryIds, selectedImageBatchItems } from "../lib/image-batch-state";
import { useImageBatch } from "../lib/use-image-batch";

interface Props {
  proposal: StudioImageBatchProposal;
  interactive: boolean;
  worldId: string;
  conversationId: string | null;
  onUpdate: (proposal: StudioImageBatchProposal) => void;
}

export function ImageBatchProposalCard(props: Props) {
  const task = useImageBatch(props);
  return <ImageBatchProposalView proposal={props.proposal} interactive={props.interactive && !!task.owner}
    busy={task.busy || task.restoring} error={task.error} estimates={task.estimates}
    onConfirm={task.confirm} onDecline={task.decline} onRetry={task.retry} onResume={task.resume} onRefresh={task.refresh} />;
}

/** Each row is one independent prompt and one image. The approved inline card
 * keeps selection, editing, price and persistent delivery in the same place. */
export function ImageBatchProposalView({ proposal, interactive, busy, error, estimates, onConfirm, onDecline, onRetry, onResume, onRefresh }: {
  proposal: StudioImageBatchProposal;
  interactive: boolean;
  busy: boolean;
  error: string;
  estimates: Record<string, number>;
  onConfirm: (edits: StudioImageBatchEdits) => void;
  onDecline: () => void;
  onRetry: () => void;
  onResume: () => void;
  onRefresh: () => void;
}) {
  const { t, i18n } = useTranslation("editor");
  const [selected, setSelected] = useState(() => defaultImageBatchSelection(proposal.items));
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [modelId, setModelId] = useState(proposal.model);
  const [aspectRatio, setAspectRatio] = useState(proposal.aspectRatio);
  const [resolution, setResolution] = useState(proposal.resolution);
  const pending = proposal.status === "pending";
  const editable = pending && interactive && !busy;
  const batch = proposal.batch;
  const items: Array<ImageBatchProposalItem & Partial<Pick<ImageBatchItem, "status" | "assetId">>> = batch?.items ?? proposal.items;
  const chosen = selectedImageBatchItems(proposal.items, selected, prompts);
  const selectable = defaultImageBatchSelection(proposal.items);
  const capabilities = getSmartImageCapabilities(modelId);
  const factor = resolution === "4K" ? SMART_IMAGE_4K_COST_FACTOR : 1;
  const baseEstimate = estimates[modelId];
  const unitEstimate = baseEstimate !== undefined ? Math.ceil(baseEstimate * factor * 10) / 10
    : modelId === proposal.model && resolution === proposal.resolution && proposal.unitMushies > 0 ? proposal.unitMushies : undefined;
  const estimate = unitEstimate !== undefined ? Math.ceil(unitEstimate * chosen.length * 10) / 10 : undefined;
  const canConfirm = editable && chosen.length > 0 && chosen.every(item => item.prompt.length > 0) && estimate !== undefined;
  const done = batch?.items.filter(item => item.status === "succeeded").length ?? 0;
  const total = batch?.items.filter(item => item.status !== "skipped").length ?? 0;
  const retries = batch ? imageBatchRetryIds(batch) : [];
  const bindingOnly = !!batch && retries.length > 0 && batch.items.filter(item => retries.includes(item.id)).every(item => item.status === "binding_failed");
  const format = (value: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value);
  const buttonClass = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11";
  const selectClass = "min-h-8 max-w-full rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:opacity-60";
  const title = proposal.status === "declined" ? t("studio.aiChat.imageBatch.declined") : batch
    ? t(`studio.aiChat.imageBatch.phase.${batch.status}`) : t("studio.aiChat.imageBatch.title");

  return <section className={cn("mt-2 min-w-0 rounded-xl border border-primary/25 bg-primary/5 p-3 text-xs",
    batch?.status === "completed" && "border-emerald-500/20 bg-emerald-500/5")}
    data-image-batch-run={proposal.runId}>
    <div className="flex items-center gap-2 font-medium text-foreground" role="status" aria-live="polite">
      {batch?.status === "running" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
        : <ImagePlus className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
      <span>{title}</span>
      {batch && <span className="ml-auto tabular-nums text-muted-foreground">{done}/{total}</span>}
    </div>
    {proposal.purpose && <p className="mt-1 break-words text-muted-foreground">{proposal.purpose}</p>}
    {pending && <label className="mt-3 flex min-h-8 items-center gap-2 text-muted-foreground">
      <input type="checkbox" checked={chosen.length === selectable.size && selectable.size > 0} disabled={!editable || !selectable.size}
        onChange={event => setSelected(event.target.checked ? selectable : new Set())} className="h-4 w-4 accent-primary" />
      {t("studio.aiChat.imageBatch.selectAll", { count: chosen.length })}
    </label>}
    <div className="mt-2 max-h-96 space-y-1.5 overflow-y-auto overscroll-contain">
      {items.map(item => {
        const status = item.status;
        const assetId = item.assetId ?? item.existingAssetId;
        const source = !item.target ? t("studio.aiChat.imageBatch.library")
          : item.target.kind === "entry_portrait" ? t("studio.aiChat.imageBatch.portrait")
            : t("studio.aiChat.imageBatch.component", { key: item.target.key });
        return <div key={item.id} className="rounded-lg border border-border/70 bg-background/60 p-2" data-batch-item={item.id}>
          <div className="flex items-center gap-2">
            {pending && <input type="checkbox" aria-label={item.label} checked={selected.has(item.id) && !item.existingAssetId}
              disabled={!editable || !!item.existingAssetId} className="h-4 w-4 shrink-0 accent-primary"
              onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />}
            {assetId && <a href={resolveImageUrl(assetId)} target="_blank" rel="noopener noreferrer" aria-label={item.label}
              className="h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border">
              <img src={resolveImageUrl(assetId)} alt={item.label} loading="lazy" className="h-full w-full object-cover" />
            </a>}
            <span className="min-w-0 flex-1"><span className="block break-words font-medium text-foreground">{item.label}</span>
              <span className="block break-words text-[10px] text-muted-foreground">{source}</span></span>
            {status ? <span className={cn("max-w-28 text-right text-[10px]", status === "failed" || status === "binding_failed" ? "text-destructive" : "text-muted-foreground")}>
              {status === "succeeded" && <Check className="mr-1 inline h-3 w-3 text-emerald-500" aria-hidden="true" />}
              {t(`studio.aiChat.imageBatch.item.${status}`)}
            </span> : item.existingAssetId && <span className="text-right text-[10px] text-muted-foreground">{t("studio.aiChat.imageBatch.existing")}</span>}
          </div>
          {(!item.existingAssetId || status) && <details className="mt-1.5 text-muted-foreground">
            <summary className="cursor-pointer py-1 text-[10px]">{t("studio.aiChat.imageProposal.promptLabel")}</summary>
            {pending ? <textarea aria-label={`${t("studio.aiChat.imageProposal.promptLabel")} · ${item.label}`}
              value={prompts[item.id] ?? item.prompt} disabled={!editable} rows={3}
              onChange={event => setPrompts(previous => ({ ...previous, [item.id]: event.target.value }))}
              className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60" />
              : <p className="whitespace-pre-wrap break-words py-1 text-[11px]">{item.prompt}</p>}
          </details>}
          {status === "binding_failed" && <p className="mt-1 text-[10px] text-muted-foreground">{t("studio.aiChat.imageBatch.bindingNote")}</p>}
        </div>;
      })}
    </div>
    {pending && <>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
          {t("studio.aiChat.imageBatch.model")}
          <select value={modelId} disabled={!editable} className={selectClass} onChange={event => {
            const id = event.target.value; setModelId(id); setAspectRatio(resolveSmartImageAspect(id, aspectRatio)); setResolution(resolveSmartImageResolution(id, resolution));
          }}>{SMART_IMAGE_MODELS.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">{t("studio.aiChat.imageProposal.aspect")}
          <select value={aspectRatio} disabled={!editable} className={selectClass} onChange={event => setAspectRatio(event.target.value)}>
            {capabilities.aspectRatios.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}
          </select>
        </label>
      </div>
      {proposal.modelReason && modelId === proposal.model && <p className="mt-2 break-words text-[11px] text-muted-foreground">{proposal.modelReason}</p>}
      <p className="mt-3 font-medium tabular-nums text-foreground">{estimate === undefined ? t("studio.aiChat.imageBatch.estimateUnavailable")
        : t("studio.aiChat.imageProposal.estimate", { amount: format(estimate) })}</p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t("studio.aiChat.imageBatch.billingNote")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={!canConfirm} onClick={() => onConfirm({ items: chosen, model: modelId, aspectRatio, resolution })}
          className={cn(buttonClass, "border-transparent bg-primary text-primary-foreground hover:brightness-110")}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
          {t("studio.aiChat.imageBatch.confirm", { count: chosen.length })}
        </button>
        <button type="button" disabled={!editable} onClick={onDecline} className={cn(buttonClass, "border-border bg-background text-foreground hover:bg-muted")}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />{t("studio.aiChat.imageProposal.decline")}
        </button>
      </div>
    </>}
    {batch && <>
      <p className="mt-3 text-[11px] tabular-nums text-muted-foreground">
        {getSmartImageModel(batch.model)?.name ?? batch.model} · {batch.aspectRatio}{batch.resolution ? ` · ${batch.resolution}` : ""}
        {" · "}{t("studio.aiChat.imageProposal.charged", { amount: format(batch.costMushies) })}
      </p>
      {batch.status === "running" && <p className="mt-1 text-[10px] text-muted-foreground">{t("studio.aiChat.imageBatch.background")}</p>}
      {batch.status === "paused" && <div className="mt-2">
        <p className="text-[11px] text-muted-foreground">{batch.pauseReason === "STORAGE_LIMIT" ? t("studio.aiChat.imageBatch.pausedStorageNote")
          : batch.pauseReason === "BATCH_UNAVAILABLE" ? t("studio.aiChat.imageBatch.pausedUnavailableNote")
            : batch.pauseReason === "INSUFFICIENT_CREDITS" || batch.pauseReason === "NO_CREDITS" ? t("studio.aiChat.imageBatch.pausedNote")
              : t("studio.aiChat.imageBatch.pausedGenericNote")}</p>
        <button type="button" disabled={busy} onClick={onResume} className={cn(buttonClass, "mt-2 border-border bg-background hover:bg-muted")}>
          {t("studio.aiChat.imageBatch.resume")}
        </button>
      </div>}
      {retries.length > 0 && batch.status !== "running" && <button type="button" disabled={busy} onClick={onRetry}
        className={cn(buttonClass, "mt-2 border-border bg-background hover:bg-muted")}>
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        {bindingOnly ? t("studio.aiChat.imageBatch.retryBinding") : t("studio.aiChat.imageBatch.retry", { count: retries.length })}
      </button>}
    </>}
    {error && <div className="mt-2 text-[11px] text-destructive" role="alert">
      <p>{error === "SYNC_FAILED" ? t("studio.aiChat.imageBatch.syncFailed")
        : error === "INSUFFICIENT_CREDITS" || error === "NO_CREDITS" ? t("studio.aiChat.imageBatch.pausedNote") : t("studio.aiChat.imageBatch.requestFailed")}</p>
      <button type="button" onClick={onRefresh} disabled={busy} className="mt-1 underline underline-offset-2">{t("studio.aiChat.imageBatch.refresh")}</button>
    </div>}
  </section>;
}
