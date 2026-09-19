import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2 } from "lucide-react";
import { POPUP_AUTH_DONE } from "@/lib/popup-auth";

/**
 * Where an OAuth popup lands after the provider round trip. The session
 * cookie is already set for yumina.io by the time this renders; all that is
 * left is to tell the page that opened us and close. If nothing opened us
 * (bookmark, blocked opener), show a plain confirmation instead.
 */
export function PopupDonePage() {
  const { t } = useTranslation("common");
  const [error] = useState(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("error"),
  );
  // No opener (bookmark, blocked opener): plain confirmation from the start.
  const [standalone, setStandalone] = useState(() => {
    if (typeof window === "undefined") return false;
    const opener = window.opener as Window | null;
    return !opener || opener.closed;
  });

  useEffect(() => {
    const opener = window.opener as Window | null;
    if (!opener || opener.closed) return;
    opener.postMessage(
      error ? { type: POPUP_AUTH_DONE, error } : { type: POPUP_AUTH_DONE },
      window.location.origin,
    );
    // Script-opened windows may close themselves; if the browser refuses, the
    // fallback text below tells the player what happened.
    const timer = setTimeout(() => setStandalone(true), 1200);
    window.close();
    return () => clearTimeout(timer);
  }, [error]);

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#0f0f11] px-6 text-center text-white">
      <div className="max-w-xs space-y-3">
        {standalone ? (
          <CheckCircle2 className="mx-auto size-8 text-emerald-400" aria-hidden="true" />
        ) : (
          <Loader2 className="mx-auto size-6 animate-spin text-white/70" aria-label={t("krew.signIn.finishing")} />
        )}
        <p className="text-sm text-white/80">
          {error ? t("krew.signIn.popupFailed") : standalone ? t("krew.signIn.popupDone") : t("krew.signIn.finishing")}
        </p>
        {standalone && (
          <a
            href="/krew"
            target="_top"
            className="inline-flex min-h-10 items-center justify-center rounded-md bg-white px-4 text-sm font-medium text-black"
          >
            {t("krew.signIn.backToGame")}
          </a>
        )}
      </div>
    </div>
  );
}
