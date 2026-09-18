import { AlertCircle, Loader2, X } from "lucide-react";
import i18n from "@/lib/i18n";

export type PillKind = "plain" | "error" | "progress" | "persistent";

export interface PillAction {
  label: string;
  onClick: () => void;
}

export interface PillProps {
  kind: PillKind;
  text: string;
  action?: PillAction;
  /** Called when the user taps the pill body, presses Escape on the action, or hits the X. */
  onClose?: () => void;
  /** Only the persistent variant shows an X (it has no timer). */
  showClose?: boolean;
  /** Spinner for in-flight progress. */
  busy?: boolean;
}

/**
 * The one feedback shape. Rendered by lib/feedback.tsx inside Sonner's <li>.
 * Styling lives in globals.css under "Feedback pills".
 */
export function Pill({ kind, text, action, onClose, showClose, busy }: PillProps) {
  const closeLabel = (i18n.t as (k: string, o?: Record<string, unknown>) => string)("common:action.close", {
    defaultValue: "Close",
  });
  return (
    <div className="yp-pill" data-kind={kind} onClick={kind === "persistent" ? undefined : onClose}>
      {kind === "error" && <AlertCircle className="yp-pill-icon" aria-hidden="true" />}
      {busy && <Loader2 className="yp-pill-icon yp-pill-spin" aria-hidden="true" />}
      <span className="yp-pill-text">{text}</span>
      {action && (
        <button
          type="button"
          className="yp-pill-action"
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose?.();
          }}
        >
          {action.label}
        </button>
      )}
      {showClose && (
        <button
          type="button"
          className="yp-pill-close"
          aria-label={closeLabel}
          onClick={(e) => {
            e.stopPropagation();
            onClose?.();
          }}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
