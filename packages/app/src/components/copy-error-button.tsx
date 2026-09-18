import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

interface CopyErrorButtonProps {
  text: string;
  className?: string;
  /** Inline-flow placement uses static positioning instead of absolute. */
  inline?: boolean;
}

/**
 * One-click copy button for error displays. Sits in the corner of the
 * error card; on click writes the full error text to the clipboard and
 * flashes a check (R2 — no pill). Designed for the Studio canvas runtime
 * error, the code-view compile error, and ErrorCard — anywhere a user
 * needs to paste the raw error into an AI assistant.
 */
export function CopyErrorButton({ text, className = "", inline = false }: CopyErrorButtonProps) {
  const { t } = useTranslation("toasts");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail in non-secure contexts or restricted iframes;
      // fall back to a hidden textarea + execCommand so the button still works.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const positionClasses = inline ? "" : "absolute right-1.5 top-1.5";

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`${positionClasses} flex h-6 w-6 shrink-0 items-center justify-center rounded text-destructive/60 transition-colors hover:bg-destructive/10 hover:text-destructive ${className}`}
      title={copied ? undefined : t("copyError")}
      aria-label="Copy error"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
