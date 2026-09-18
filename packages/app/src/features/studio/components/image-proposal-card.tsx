import { useEffect, useState } from "react";
import { ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { resolveImageUrl } from "@/lib/asset-url";
import type { StudioImageProposal } from "../lib/types";

const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"] as const;

interface ImageProposalCardProps {
  proposal: StudioImageProposal;
  /** Only the newest pending card gets buttons; older ones are records. */
  interactive: boolean;
  onConfirm: (edits: { prompt: string; aspectRatio: string; batchSize: number }) => void;
  onDecline: () => void;
}

/** The assistant asked for a picture. Money moves only when the creator presses
 * Generate here, and what they press Generate on is what gets drawn. */
export function ImageProposalCard({ proposal, interactive, onConfirm, onDecline }: ImageProposalCardProps) {
  const { t, i18n } = useTranslation("editor");
  const [prompt, setPrompt] = useState(proposal.prompt);
  const [aspectRatio, setAspectRatio] = useState(proposal.aspectRatio);
  const [batchSize, setBatchSize] = useState(proposal.batchSize);
  useEffect(() => { setPrompt(proposal.prompt); setAspectRatio(proposal.aspectRatio); setBatchSize(proposal.batchSize); }, [proposal.prompt, proposal.aspectRatio, proposal.batchSize]);
  const format = (value: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value);
  const estimate = Math.ceil(proposal.unitMushies * batchSize * 10) / 10;
  const pending = proposal.status === "pending";
  const canConfirm = interactive && pending && prompt.trim().length > 0;
  const buttonClass = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11";
  const title = proposal.status === "generating" ? t("studio.aiChat.imageProposal.generating")
    : proposal.status === "done" ? t("studio.aiChat.imageProposal.done", { count: proposal.assetIds?.length ?? 0 })
      : proposal.status === "failed" ? t("studio.aiChat.imageProposal.failed")
        : proposal.status === "declined" ? t("studio.aiChat.imageProposal.declined")
          : proposal.status === "stillGenerating" ? t("studio.aiChat.imageProposal.stillGenerating")
            : t("studio.aiChat.imageProposal.title");

  return (
    <section
      className={cn("mt-2 min-w-0 rounded-xl border border-primary/25 bg-primary/5 p-3 text-xs", proposal.status === "done" && "border-emerald-500/20 bg-emerald-500/5", proposal.status === "failed" && "border-destructive/30 bg-destructive/5")}
      aria-live="polite"
      data-image-proposal-run={proposal.runId}
    >
      <div className="flex items-center gap-2 font-medium text-foreground" role="status">
        {proposal.status === "generating" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          : <ImagePlus className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
        <span>{title}</span>
      </div>
      {proposal.purpose && <p className="mt-1 break-words text-muted-foreground">{proposal.purpose}</p>}

      {pending ? (
        <>
          <label className="mt-3 block text-[11px] font-medium text-muted-foreground" htmlFor={`image-proposal-prompt-${proposal.toolCallId}`}>
            {t("studio.aiChat.imageProposal.promptLabel")}
          </label>
          <textarea
            id={`image-proposal-prompt-${proposal.toolCallId}`}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={!interactive}
            rows={3}
            className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
          />
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              {t("studio.aiChat.imageProposal.aspect")}
              <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} disabled={!interactive}
                className="min-h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground">
                {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              {t("studio.aiChat.imageProposal.count")}
              <select value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))} disabled={!interactive}
                className="min-h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground">
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span className="ml-auto tabular-nums text-foreground">
              {t("studio.aiChat.imageProposal.estimate", { amount: format(estimate) })}
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">{t("studio.aiChat.imageProposal.estimateNote")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={!canConfirm} onClick={() => onConfirm({ prompt: prompt.trim(), aspectRatio, batchSize })}
              className={cn(buttonClass, "border-transparent bg-primary text-primary-foreground hover:brightness-110")}>
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {t("studio.aiChat.imageProposal.confirm")}
            </button>
            <button type="button" disabled={!interactive} onClick={onDecline}
              className={cn(buttonClass, "border-border bg-background text-foreground hover:bg-muted")}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t("studio.aiChat.imageProposal.decline")}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 break-words text-muted-foreground">{proposal.prompt}</p>
      )}

      {proposal.status === "generating" && (
        <p className="mt-2 text-muted-foreground">
          {t("studio.aiChat.imageProposal.generatingDetail", { seconds: proposal.elapsed ?? 0 })}
        </p>
      )}
      {proposal.status === "done" && proposal.assetIds && proposal.assetIds.length > 0 && (
        <>
          <div className={cn("mt-3 grid gap-2", proposal.assetIds.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
            {proposal.assetIds.map((assetId) => (
              <a key={assetId} href={resolveImageUrl(assetId)} target="_blank" rel="noopener noreferrer"
                className="block overflow-hidden rounded-lg border border-border/60 bg-background">
                {/* The plain /cdn path: the creator is inspecting the delivery, and it
                    works without the edge resizer (local dev, transform switched off). */}
                <img src={resolveImageUrl(assetId)} alt="" loading="lazy" decoding="async" className="block w-full object-cover" />
              </a>
            ))}
          </div>
          <p className="mt-2 tabular-nums text-muted-foreground">
            {typeof proposal.costMushies === "number"
              ? t("studio.aiChat.imageProposal.charged", { amount: format(proposal.costMushies) })
              : t("studio.aiChat.imageProposal.savedNote")}
          </p>
        </>
      )}
      {proposal.status === "failed" && (
        <p className="mt-2 break-words text-destructive" role="alert">
          {t("studio.aiChat.imageProposal.failedDetail", { code: proposal.error ?? "" })}
        </p>
      )}
      {proposal.status === "stillGenerating" && (
        <p className="mt-2 text-muted-foreground">{t("studio.aiChat.imageProposal.stillGeneratingDetail")}</p>
      )}
    </section>
  );
}
