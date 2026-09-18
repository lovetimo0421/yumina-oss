import { Globe, Key } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

export type ProviderChoice = "official" | "private";

export interface ProviderSwitchCopy {
  official: {
    title: string;
    description: string;
  };
  private: {
    title: string;
    description: string;
  };
  confirmLabel: string;
  cancelLabel: string;
}

interface ProviderSwitchControlProps {
  provider: ProviderChoice;
  disabled?: boolean;
  onRequest: (provider: ProviderChoice) => void;
  officialLabel: string;
  privateLabel: string;
  className?: string;
}

export function ProviderSwitchControl({
  provider,
  disabled = false,
  onRequest,
  officialLabel,
  privateLabel,
  className,
}: ProviderSwitchControlProps) {
  const itemClass = (value: ProviderChoice) => cn(
    "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary/50",
    provider === value
      ? value === "official"
        ? "bg-primary/[0.15] text-white"
        : "bg-slate-300/[0.12] text-white"
      : "text-white/35 hover:bg-white/[0.04] hover:text-white/60",
  );

  return (
    <div className={cn("border-t border-white/[0.06] px-5 py-3", className)}>
      <div className="flex rounded-xl bg-white/[0.04] p-1">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={provider === "official"}
          onClick={() => onRequest("official")}
          className={itemClass("official")}
        >
          <Globe className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{officialLabel}</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={provider === "private"}
          onClick={() => onRequest("private")}
          className={itemClass("private")}
        >
          <Key className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{privateLabel}</span>
        </button>
      </div>
    </div>
  );
}

interface ProviderSwitchConfirmDialogProps {
  provider: ProviderChoice | null;
  copy: ProviderSwitchCopy;
  busy?: boolean;
  error?: string | null;
  portalContainer?: HTMLElement | null;
  portalClassName?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ProviderSwitchConfirmDialog({
  provider,
  copy,
  busy = false,
  error,
  portalContainer,
  portalClassName,
  onConfirm,
  onCancel,
}: ProviderSwitchConfirmDialogProps) {
  if (!provider) return null;

  const selectedCopy = copy[provider];

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onCancel(); }}
      tone="action"
      title={selectedCopy.title}
      description={(
        <div className="space-y-3">
          <p>{selectedCopy.description}</p>
          {error && (
            <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
      confirmLabel={copy.confirmLabel}
      cancelLabel={copy.cancelLabel}
      busy={busy}
      onConfirm={onConfirm}
      overlayClassName="z-[10010]"
      contentClassName="z-[10020] max-w-md"
      portalContainer={portalContainer}
      portalClassName={portalClassName}
    />
  );
}
