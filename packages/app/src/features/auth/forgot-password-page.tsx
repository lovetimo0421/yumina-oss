import { useCallback, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation, Trans } from "react-i18next";
import { authClient } from "@/lib/auth-client";
import { Turnstile, type TurnstileHandle } from "@/components/turnstile";
import { AuthLayout } from "./auth-layout";

export function ForgotPasswordPage() {
  const { t } = useTranslation("auth");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  // Turnstile token — sent to the server, which verifies it on the
  // /request-password-reset endpoint (turnstileMiddleware). Blocks scripted
  // reset-email bombing that a plain form can't.
  const [turnstileToken, setTurnstileToken] = useState("");
  const turnstileRef = useRef<TurnstileHandle>(null);
  const handleTurnstileToken = useCallback((token: string) => setTurnstileToken(token), []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const turnstilePayload = turnstileToken ? { "cf-turnstile-response": turnstileToken } : {};
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
        ...turnstilePayload,
      } as Parameters<typeof authClient.requestPasswordReset>[0]);
      if (error) {
        setError(error.message ?? t("forgotPassword.failedSend"));
      } else {
        setSent(true);
      }
    } catch {
      setError(t("forgotPassword.unexpectedError"));
    } finally {
      setLoading(false);
      // Turnstile tokens are single-use; refresh after every attempt so a
      // retry doesn't re-send a spent token (which would fail verification).
      setTurnstileToken("");
      turnstileRef.current?.reset();
    }
  };

  if (sent) {
    return (
      <AuthLayout wide>
          <div className="rounded-2xl border border-white/[0.08] bg-[#212124]/80 p-8 shadow-2xl shadow-black/40 backdrop-blur-xl text-center">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gold/10 shadow-[0_0_30px_rgba(201,162,94,0.1)]">
              <svg className="h-8 w-8 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>

            <h2 className="mb-2 text-xl font-bold text-[#E6E4DD]">{t("forgotPassword.sent.title")}</h2>
            <p className="mb-6 text-sm text-[#B9B6AE] leading-relaxed">
              <Trans
                i18nKey="forgotPassword.sent.description"
                ns="auth"
                values={{ email }}
                components={{ email: <span className="font-semibold text-gold" /> }}
              />
            </p>
            <p className="mb-8 text-xs text-[#B9B6AE]/50">
              {t("forgotPassword.sent.checkSpam")}
            </p>

            <Link to="/login">
              <button className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-4 py-3 text-sm font-semibold text-[#E6E4DD] transition-all hover:border-white/[0.15] hover:bg-white/[0.06]">
                {t("forgotPassword.sent.backToSignIn")}
              </button>
            </Link>
          </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout wide>
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-black tracking-tight text-[#E6E4DD]">
            {t("forgotPassword.title")}
          </h1>
          <p className="mt-2 text-sm text-[#B9B6AE]">
            {t("forgotPassword.description")}
          </p>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#212124]/80 p-8 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <form onSubmit={handleSubmit} className="space-y-4">
            <input
              type="email"
              placeholder={t("forgotPassword.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              autoFocus
              className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-4 py-3 text-sm text-[#E6E4DD] placeholder:text-[#B9B6AE]/50 outline-none transition-colors focus:border-gold/40 focus:ring-1 focus:ring-gold/20"
            />

            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {error}
              </div>
            )}

            <Turnstile ref={turnstileRef} onToken={handleTurnstileToken} />

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-gold px-4 py-3 text-sm font-bold text-[#181818] shadow-[0_0_20px_rgba(201,162,94,0.15)] transition-all hover:bg-[#F0C24A] hover:shadow-[0_0_30px_rgba(201,162,94,0.25)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? t("forgotPassword.submitting") : t("forgotPassword.submit")}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-[#B9B6AE]/60">
          {t("forgotPassword.rememberPassword")}{" "}
          <Link to="/login" className="font-semibold text-gold transition-colors hover:text-[#F0C24A]">
            {t("forgotPassword.signIn")}
          </Link>
        </p>
    </AuthLayout>
  );
}
