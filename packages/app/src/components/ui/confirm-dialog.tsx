import type { ReactNode } from "react";
import { AlertTriangle, ArrowLeftRight, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmDialogItem {
  name: string;
  detail?: string;
  imageUrl?: string | null;
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  descriptionHtml?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
  tone?: "destructive" | "warning" | "action";
  contentClassName?: string;
  overlayClassName?: string;
  portalContainer?: HTMLElement | null;
  portalClassName?: string;
  item?: ConfirmDialogItem;
  consequences?: ReactNode[];
  requireText?: string;
  requireTextLabel?: ReactNode;
  typedValue?: string;
  onTypedValueChange?: (value: string) => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  descriptionHtml,
  confirmLabel,
  cancelLabel,
  onConfirm,
  busy = false,
  tone = "destructive",
  contentClassName,
  overlayClassName,
  portalContainer,
  portalClassName,
  item,
  consequences = [],
  requireText,
  requireTextLabel,
  typedValue = "",
  onTypedValueChange,
}: ConfirmDialogProps) {
  const requiresMatch = typeof requireText === "string" && requireText.length > 0;
  const canConfirm = !busy && (!requiresMatch || typedValue === requireText);
  const Icon = tone === "destructive" ? Trash2 : tone === "warning" ? AlertTriangle : ArrowLeftRight;
  const isDestructive = tone === "destructive";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        mobileSheet
        overlayClassName={overlayClassName}
        portalContainer={portalContainer}
        portalClassName={portalClassName}
        className={cn("gap-5 border-white/10 bg-[#17181D] p-5 sm:p-6", contentClassName)}
      >
        <DialogHeader className="pr-12 text-left">
          <div className="flex items-center gap-3">
            <div className={isDestructive
              ? "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/10 text-destructive"
              : "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-action-primary"}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <DialogTitle className="text-xl leading-tight text-foreground">{title}</DialogTitle>
          </div>
          {descriptionHtml ? (
            <DialogDescription
              className="pt-1 leading-relaxed text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground"
              dangerouslySetInnerHTML={{ __html: descriptionHtml }}
            />
          ) : description ? (
            <DialogDescription asChild>
              <div className="pt-1 text-sm leading-relaxed text-muted-foreground">{description}</div>
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {item && (
          <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.035] p-3">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/[0.04] text-lg font-semibold text-muted-foreground">
              {item.imageUrl ? (
                <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                item.name.slice(0, 1).toUpperCase()
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{item.name}</p>
              {item.detail && <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>}
            </div>
          </div>
        )}

        {consequences.length > 0 && (
          <ul className={isDestructive
            ? "space-y-2 rounded-xl border border-destructive/15 bg-destructive/[0.05] p-3 text-sm text-muted-foreground"
            : "space-y-2 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 text-sm text-muted-foreground"}
          >
            {consequences.map((consequence, index) => (
              <li key={index} className="flex gap-2">
                <span className={isDestructive
                  ? "mt-2 h-1 w-1 shrink-0 rounded-full bg-destructive"
                  : "mt-2 h-1 w-1 shrink-0 rounded-full bg-action-primary"}
                  aria-hidden="true"
                />
                <span>{consequence}</span>
              </li>
            ))}
          </ul>
        )}

        {requiresMatch && (
          <label className="grid gap-2 text-sm text-muted-foreground">
            <span>{requireTextLabel}</span>
            <input
              type="text"
              value={typedValue}
              onChange={(event) => onTypedValueChange?.(event.target.value)}
              autoComplete="off"
              className="h-11 rounded-xl border border-white/10 bg-inset px-3 text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-destructive/50 focus:ring-2 focus:ring-destructive/15"
            />
          </label>
        )}

        <DialogFooter className="gap-y-3">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] px-4 text-sm font-semibold text-foreground transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#17181D] disabled:opacity-50 sm:flex-none"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={!canConfirm}
            className={isDestructive
              ? "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-destructive px-4 text-sm font-semibold text-destructive-foreground transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#17181D] disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
              : "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-action-primary px-4 text-sm font-semibold text-action-primary-foreground transition-colors hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#17181D] disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
