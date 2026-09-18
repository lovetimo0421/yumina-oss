import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Loader2, X, Share2 } from "lucide-react";
import { MAX_PLAYTHROUGH_TITLE, MAX_PLAYTHROUGH_NOTE } from "@yumina/shared";
import { createPlaythrough } from "@/lib/playthroughs";
import { feedback } from "@/lib/feedback";
import { FieldError } from "@/components/ui/field-error";

interface SharePlaythroughModalProps {
  open: boolean;
  worldId: string;
  sessionId: string;
  defaultTitle?: string;
  /** "unlisted" = private friend-only DM share (not listed on Discover);
   *  "public" (default) = listed on the card's hub page. */
  visibility?: "public" | "unlisted";
  onClose: () => void;
  onShared?: (id: string) => void;
}

export function SharePlaythroughModal({
  open,
  worldId,
  sessionId,
  defaultTitle = "",
  visibility = "public",
  onClose,
  onShared,
}: SharePlaythroughModalProps) {
  const { t } = useTranslation("chat");
  const [title, setTitle] = useState(defaultTitle);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  if (!open) return null;

  const handleShare = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      // R4: validation sits next to the field it is about.
      setTitleError(t("share.titleRequired"));
      return;
    }
    setTitleError(null);
    setFormError(null);
    setSubmitting(true);
    try {
      const { id } = await createPlaythrough(worldId, {
        sessionId,
        title: trimmed,
        note: note.trim() || undefined,
        visibility,
      });
      // The snapshot itself lands out of view (the card's page, or a DM), so a
      // plain neutral pill is the only trace the share happened.
      feedback.notice(t("share.shared"));
      onShared?.(id);
      onClose();
    } catch (e) {
      // The form is still open — the error belongs inside it, not in a pill.
      setFormError(e instanceof Error ? e.message : t("share.failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/78 animate-in fade-in duration-150" onClick={onClose} />
      <div className="relative z-10 mx-4 w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.07] bg-[#1B1C22] shadow-[0_24px_70px_rgba(0,0,0,0.5)] animate-in fade-in zoom-in-95 duration-200">
        {/* gold top accent — same motif as the card-page Author's Note */}
        <div className="h-1 w-full bg-gradient-to-r from-primary/60 via-amber-400/70 to-transparent" />

        <div className="p-5">
          <div className="mb-4 flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/20">
              <Share2 className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <h2 className="text-[0.95rem] font-semibold text-foreground">
                {visibility === "unlisted" ? t("share.titlePrivate") : t("share.title")}
              </h2>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/55">
                {visibility === "unlisted" ? t("share.subtitlePrivate") : t("share.subtitle")}
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label={t("share.close")}
              className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-muted-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mb-1 flex items-baseline justify-between">
            <label className="text-xs font-medium text-muted-foreground/70">{t("share.titleLabel")}</label>
            <span className="text-[10px] tabular-nums text-muted-foreground/30">
              {title.length}/{MAX_PLAYTHROUGH_TITLE}
            </span>
          </div>
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (titleError) setTitleError(null);
            }}
            maxLength={MAX_PLAYTHROUGH_TITLE}
            autoFocus
            aria-invalid={!!titleError}
            aria-describedby={titleError ? "playthrough-title-error" : undefined}
            className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/30 focus:border-primary/45 focus:bg-black/40"
          />
          <div className="mb-4">
            <FieldError id="playthrough-title-error" message={titleError} />
          </div>

          <div className="mb-1 flex items-baseline justify-between">
            <label className="text-xs font-medium text-muted-foreground/70">{t("share.noteLabel")}</label>
            <span className="text-[10px] tabular-nums text-muted-foreground/30">
              {note.length}/{MAX_PLAYTHROUGH_NOTE}
            </span>
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={MAX_PLAYTHROUGH_NOTE}
            placeholder={t("share.notePlaceholder")}
            rows={3}
            className="mb-5 w-full resize-none rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/30 focus:border-primary/45 focus:bg-black/40"
          />

          {formError && (
            <div className="mb-3 -mt-2">
              <FieldError message={formError} />
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-white/10 px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              {t("share.cancel")}
            </button>
            <button
              onClick={() => void handleShare()}
              disabled={submitting || !title.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_0_18px_rgba(201,162,94,0.18)] transition-all hover:bg-primary/90 hover:shadow-[0_0_26px_rgba(201,162,94,0.3)] disabled:opacity-40 disabled:shadow-none"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              {t("share.confirm")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
