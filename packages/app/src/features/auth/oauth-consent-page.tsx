import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, X } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { isOAuthAuthorizeQuery } from "@/lib/oauth-authorize";
import { AuthLayout } from "./auth-layout";

const apiBase = import.meta.env?.VITE_API_URL || "";

/**
 * "Let Claude into your Yumina account?" — the consent step of our OAuth
 * authorization server (Better Auth oauthProvider). An outside AI (Claude,
 * ChatGPT, Codex, Cursor) that the creator added by URL lands the creator
 * here; allowing sends them back to it with a code it trades for an access
 * token to the card MCP.
 */
export function OAuthConsentPage() {
  const { t } = useTranslation("auth");
  const { data: session } = useSession();
  const [clientName, setClientName] = useState<string | null>(null);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState("");
  const valid = typeof window !== "undefined" && isOAuthAuthorizeQuery(window.location.search);

  useEffect(() => {
    const clientId = new URLSearchParams(window.location.search).get("client_id");
    if (!clientId) return;
    void fetch(`${apiBase}/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: { client_name?: string } | null) => setClientName(c?.client_name?.trim() || null))
      .catch(() => {});
  }, []);

  const decide = async (accept: boolean) => {
    setBusy(accept ? "allow" : "deny");
    setError("");
    const result = await authClient.oauth2.consent({ accept });
    const next = result.data as { url?: string; redirect_uri?: string } | null;
    const url = next?.url ?? next?.redirect_uri;
    if (url) {
      window.location.href = url;
      return;
    }
    setBusy(null);
    setError(t("oauthConsent.failed"));
  };

  const name = clientName ?? t("oauthConsent.unknownApp");
  const who = session?.user?.name || session?.user?.email || "";
  // Any program can register under any name, so say where "Allow" sends you.
  const returnsTo = (() => {
    try {
      const host = new URL(new URLSearchParams(window.location.search).get("redirect_uri") ?? "").hostname;
      return host === "127.0.0.1" || host === "localhost" || host === "[::1]" ? t("oauthConsent.returnsLocal") : host;
    } catch {
      return "";
    }
  })();

  return (
    <AuthLayout>
      <div className="mb-4 text-center sm:mb-6">
        <h1 className="text-[1.5rem] font-black tracking-tight text-[#E6E4DD] sm:text-[1.75rem]">
          {t("oauthConsent.title", { app: name })}
        </h1>
        {who && <p className="mt-1.5 text-[12px] text-[#9A978F]">{t("oauthConsent.signedInAs", { name: who })}</p>}
      </div>

      <div className="rounded-[1.2rem] border border-white/[0.08] bg-[#212124]/80 p-4 shadow-2xl shadow-black/40 backdrop-blur-xl sm:rounded-[1.35rem] sm:p-5">
        {!valid ? (
          <p className="text-center text-[13px] leading-relaxed text-[#C9C6BE]">{t("oauthConsent.invalid")}</p>
        ) : (
          <>
            <p className="text-[13px] font-semibold text-[#E6E4DD]">{t("oauthConsent.canHeading", { app: name })}</p>
            <ul className="mt-2.5 space-y-2">
              {(["see", "edit", "create", "spend"] as const).map((key) => (
                <li key={key} className="flex gap-2 text-[13px] leading-snug text-[#C9C6BE]">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" />
                  <span>{t(`oauthConsent.can.${key}`)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3.5 text-[13px] font-semibold text-[#E6E4DD]">{t("oauthConsent.cannotHeading")}</p>
            <ul className="mt-2.5 space-y-2">
              {(["publish", "account"] as const).map((key) => (
                <li key={key} className="flex gap-2 text-[13px] leading-snug text-[#9A978F]">
                  <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#6E6B65]" />
                  <span>{t(`oauthConsent.cannot.${key}`)}</span>
                </li>
              ))}
            </ul>

            <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5 text-[12px] leading-relaxed text-[#D8C9A8]">
              {t("oauthConsent.unverified", { app: name })}
              {returnsTo && <div className="mt-1 text-[#9A978F]">{t("oauthConsent.returnsTo", { place: returnsTo })}</div>}
            </div>

            {error && <p className="mt-3 text-[12px] text-red-400">{error}</p>}

            <div className="mt-5 flex gap-2.5">
              <button
                type="button"
                onClick={() => void decide(false)}
                disabled={busy !== null}
                className="flex-1 rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-4 py-2.5 text-[13px] font-semibold text-[#E6E4DD] transition-all hover:border-white/[0.15] hover:bg-white/[0.06] active:scale-[0.98] disabled:opacity-50"
              >
                {busy === "deny" ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : t("oauthConsent.deny")}
              </button>
              <button
                type="button"
                onClick={() => void decide(true)}
                disabled={busy !== null}
                className="flex-1 rounded-xl bg-gold px-4 py-2.5 text-[13px] font-bold text-[#181818] shadow-[0_0_20px_rgba(201,162,94,0.15)] transition-all hover:bg-[#F0C24A] active:scale-[0.98] disabled:opacity-50"
              >
                {busy === "allow" ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : t("oauthConsent.allow")}
              </button>
            </div>
            <p className="mt-3 text-center text-[11px] leading-relaxed text-[#6E6B65]">{t("oauthConsent.revokeHint")}</p>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
