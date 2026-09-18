import { useState, useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "./auth-layout";

interface VerificationPendingProps {
  email: string;
}

const RESEND_COOLDOWN = 60;

export function VerificationPending({ email }: VerificationPendingProps) {
  const { t } = useTranslation("auth");
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN);
    timerRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) { clearInterval(timerRef.current); return 0; }
        return c - 1;
      });
    }, 1000);
  };

  const handleResend = async () => {
    if (cooldown > 0) return;
    setResending(true);
    setResendError("");
    try {
      // The auth client returns {error} instead of throwing on HTTP failures
      // (429 rate limit, 400) — checking only the catch path showed a false
      // "resent ✓" while nothing was sent.
      const result = await authClient.sendVerificationEmail({
        email,
        callbackURL: "/verified",
      });
      if (result.error) {
        setResendError(t("register.verification.resendFailed"));
        return;
      }
      setResent(true);
      startCooldown();
      setTimeout(() => setResent(false), 5000);
    } catch {
      setResendError(t("register.verification.resendFailed"));
    } finally {
      setResending(false);
    }
  };

  return (
    <AuthLayout wide>
        <div className="rounded-2xl border border-white/[0.08] bg-[#212124]/80 p-8 shadow-2xl shadow-black/40 backdrop-blur-xl text-center">
          {/* Email icon */}
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gold/10 shadow-[0_0_30px_rgba(201,162,94,0.1)]">
            <svg className="h-8 w-8 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>

          <h2 className="mb-2 text-xl font-bold text-[#E6E4DD]">{t("register.verification.title")}</h2>
          <p className="mb-1 text-sm text-[#B9B6AE]">
            {t("register.verification.sentTo")}
          </p>
          <p className="mb-8 text-sm font-semibold text-gold">{email}</p>

          {resendError && (
            <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {resendError}
            </div>
          )}

          <div className="space-y-3">
            <button
              onClick={handleResend}
              disabled={resending || resent || cooldown > 0}
              className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-4 py-3 text-sm font-semibold text-[#E6E4DD] transition-all hover:border-white/[0.15] hover:bg-white/[0.06] disabled:opacity-40"
            >
              {resent ? `\u2713 ${t("register.verification.resent")}` : resending ? t("register.verification.resending") : cooldown > 0 ? `${t("register.verification.resend")} (${cooldown}s)` : t("register.verification.resend")}
            </button>
            <Link to="/login" className="block">
              <button className="w-full rounded-xl px-4 py-3 text-sm font-medium text-[#B9B6AE]/60 transition-colors hover:text-[#E6E4DD]">
                {t("register.verification.backToSignIn")}
              </button>
            </Link>
          </div>
        </div>
    </AuthLayout>
  );
}
