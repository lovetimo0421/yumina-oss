import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { GitFork, Loader2, Lock, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { LANGUAGE_SHORT, variantRowLabels } from "@/lib/languages";
import type { LanguageVariant } from "@/lib/languages";
import i18n from "@/lib/i18n";


interface VariantForkPickerProps {
  open: boolean;
  onClose: () => void;
  /** All variants in the language group. The picker renders one row each. */
  variants: LanguageVariant[];
  /** Logged-in user's id. Variants whose `creatorId` matches are surfaced as
   *  "your version" (you don't need to fork; you can edit directly). */
  currentUserId?: string | null;
  /** Optional name shown in the dialog header for context. */
  worldName?: string;
  /** Called when the user picks a forkable variant and confirms. The picker
   *  is responsible for filtering out non-forkable variants before this fires. */
  onFork: (variantId: string) => Promise<void> | void;
  /** Called when the user clicks a variant they own. Optional — when omitted
   *  the dialog falls back to forking. Wire this to the editor route. */
  onEditOwn?: (variantId: string) => void;
  /** While true the confirm button shows a spinner. */
  loading?: boolean;
}

/**
 * Variant picker for the Edit/Fork action.
 *
 * Mirrors VariantDownloadPicker but adapted to the fork flow:
 *   - Rows whose `allowEdit === false` are visible but disabled, with a lock
 *     icon and a tooltip — users can see the full set of versions and learn
 *     that the author has only opened forking on the main version. Hiding
 *     them would feel like a bug, especially when the variant they wanted
 *     to fork is the one that's locked.
 *   - The viewer's own variants jump to the top with a "your version" tag
 *     and clicking them goes straight to the editor (no fork needed).
 *   - The Confirm button is disabled until the user selects a forkable row.
 */
export function VariantForkPicker({
  open,
  onClose,
  variants,
  currentUserId,
  worldName,
  onFork,
  onEditOwn,
  loading,
}: VariantForkPickerProps) {
  const { t } = useTranslation("library");
  const contentRef = useRef<HTMLDivElement>(null);

  // Sort: viewer's own variants → forkable → locked.
  const rowLabels = variantRowLabels(variants);

  const sorted = [...variants].sort((a, b) => {
    const aOwned = currentUserId && a.creatorId === currentUserId ? 0 : 1;
    const bOwned = currentUserId && b.creatorId === currentUserId ? 0 : 1;
    if (aOwned !== bOwned) return aOwned - bOwned;
    const aLocked = a.allowEdit === false ? 1 : 0;
    const bLocked = b.allowEdit === false ? 1 : 0;
    return aLocked - bLocked;
  });

  const isForkable = (v: LanguageVariant) => v.allowEdit !== false;
  const isOwned = (v: LanguageVariant) =>
    !!currentUserId && v.creatorId === currentUserId;

  const firstActionable =
    sorted.find(isOwned)?.id ??
    sorted.find((v) => isForkable(v) && v.language === i18n.language)?.id ??
    sorted.find(isForkable)?.id ??
    "";

  const [selectedId, setSelectedId] = useState(firstActionable);

  useEffect(() => {
    if (!open) return;
    setSelectedId(firstActionable);
  }, [open, firstActionable]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    contentRef.current?.focus();
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const selected = sorted.find((v) => v.id === selectedId);
  const selectedIsOwn = selected ? isOwned(selected) : false;
  const selectedIsForkable = selected ? isForkable(selected) : false;
  const noneForkable = !sorted.some(isForkable) && !sorted.some(isOwned);

  const handleConfirm = async () => {
    if (!selected || loading) return;
    if (selectedIsOwn && onEditOwn) {
      onEditOwn(selected.id);
      return;
    }
    if (!selectedIsForkable) return;
    await onFork(selected.id);
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/80 animate-in fade-in duration-150"
        onClick={onClose}
      />
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm rounded-lg border border-border bg-card shadow-lg animate-in fade-in zoom-in-95 duration-200 mx-4 outline-none"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {t("dialog.editAsMyProject")}
            </h2>
            {worldName && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {worldName}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1 px-3 py-3 max-h-[60vh] overflow-y-auto">
          {sorted.map((v) => {
            const owned = isOwned(v);
            const forkable = isForkable(v);
            const interactive = owned || forkable;
            const isSelected = v.id === selectedId;
            const label = rowLabels.get(v.id) ?? v.name;
            const langShort = v.language ? (LANGUAGE_SHORT[v.language] ?? null) : null;

            return (
              <button
                key={v.id}
                type="button"
                disabled={!interactive}
                title={
                  forkable
                    ? undefined
                    : t("dialog.authorDoesNotAllowEditing")
                }
                onClick={() => interactive && setSelectedId(v.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                  !interactive && "cursor-not-allowed opacity-50",
                  isSelected && interactive
                    ? "bg-primary/10 text-foreground ring-1 ring-primary/20"
                    : interactive
                      ? "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      : "text-muted-foreground",
                )}
              >
                <div
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                    isSelected && interactive
                      ? "border-primary"
                      : "border-muted-foreground/30",
                  )}
                >
                  {isSelected && interactive && (
                    <div className="h-2 w-2 rounded-full bg-primary" />
                  )}
                </div>

                <span className="flex-1 truncate font-medium">{label}</span>

                {owned && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                    {t("detail.yours", { defaultValue: "Yours" })}
                  </span>
                )}
                {!owned && !forkable && (
                  <Lock className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                )}
                {langShort && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                    {langShort}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {noneForkable && (
          <div className="px-5 pb-3 text-xs text-muted-foreground/80">
            {t("dialog.authorDoesNotAllowEditing")}
          </div>
        )}

        <div className="border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={handleConfirm}
            disabled={
              loading ||
              !selected ||
              (!selectedIsOwn && !selectedIsForkable)
            }
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <GitFork className="h-4 w-4" />
            )}
            {t("dialog.createCopy")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
