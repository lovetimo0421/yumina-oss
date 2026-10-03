import { useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { feedback } from "@/lib/feedback";

interface ShareLinkDialogProps {
  title: string;
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  copiedLabel: string;
  failedLabel: string;
}

/** A visible link and copy action remain available if the OS share sheet fails or closes. */
export function ShareLinkDialog({ title, url, open, onOpenChange, copiedLabel, failedLabel }: ShareLinkDialogProps) {
  const { t } = useTranslation("common");
  const { copied, copy } = useCopyFeedback();
  const [sharing, setSharing] = useState(false);
  const canShareNatively = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function handleCopy() {
    if (!url) return;
    if (!(await copy(url))) feedback.error(failedLabel);
  }

  async function handleNativeShare() {
    if (!url || !navigator.share) return;
    setSharing(true);
    try {
      await navigator.share({ title, url });
      onOpenChange(false);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) feedback.error(failedLabel);
    } finally {
      setSharing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[101] max-w-md" overlayClassName="z-[100]">
        <DialogHeader>
          <DialogTitle>{t("action.share")}</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <input
          aria-label={t("action.copy")}
          className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={url}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            <span aria-live="polite">{copied ? copiedLabel : t("action.copy")}</span>
          </button>
          {canShareNatively && (
            <button
              type="button"
              onClick={() => void handleNativeShare()}
              disabled={sharing}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
              {t("action.share")}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
