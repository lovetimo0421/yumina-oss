import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert, X } from "lucide-react";
import { getMuteErrorMessage } from "./mute-feedback";

const BLOCKED_EVENT = "yumina:blocked-feedback";

export function isBlockedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("blocked_by_target") || message.includes("你已被拉黑");
}

export function showBlockedDialog() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BLOCKED_EVENT));
}

export async function throwApiError(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => ({}));
  const muteMessage = getMuteErrorMessage(body);
  if (muteMessage) throw new Error(muteMessage);
  const code = typeof body.code === "string" ? body.code : "";
  const error = typeof body.error === "string" ? body.error : fallback;
  const message = code ? `${code}: ${error}` : error;
  throw new Error(message);
}

export function BlockedDialogHost() {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(BLOCKED_EVENT, handler);
    return () => window.removeEventListener(BLOCKED_EVENT, handler);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm">
      <div className="relative w-full max-w-sm rounded-2xl border border-red-400/20 bg-[#171316]/95 p-6 text-center shadow-2xl">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-white/35 transition-colors hover:bg-white/8 hover:text-white/70"
          aria-label={t("action.close", "Close")}
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-red-300/20 bg-red-500/10 text-red-200">
          <ShieldAlert className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-black text-white">{t("dm.blockedByTarget", "You have been blocked :(")}</h2>
        <p className="mt-2 text-sm text-white/55">
          {t("dm.blockedDialogBody", "This person isn't accepting this interaction from you right now.")}
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-5 rounded-xl border border-white/10 bg-white/8 px-5 py-2 text-sm font-semibold text-white/80 transition-colors hover:bg-white/12"
        >
          {t("dm.blockedDialogOk", "Got it")}
        </button>
      </div>
    </div>
  );
}
