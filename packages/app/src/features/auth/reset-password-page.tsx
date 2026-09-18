import { useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { authClient } from "@/lib/auth-client";
import { AuthLayout } from "./auth-layout";

export function ResetPasswordPage() {
  const { t } = useTranslation("auth");
  const search = useSearch({ from: "/reset-password" });
  const token = (search as Record<string, string>).token;
  const errorParam = (search as Record<string, string>).error;

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(errorParam === "INVALID_TOKEN" ? t("resetPassword.invalidToken") : "");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError(t("resetPassword.passwordTooShort"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("resetPassword.passwordsMismatch"));
      return;
    }
    if (!token) {
      setError(t("resetPassword.noToken"));
      return;
    }

    setLoading(true);
    try {
      const { error } = await authClient.resetPassword({ newPassword: password, token });
      if (error) {
        setError(error.message ?? t("resetPassword.failedReset"));
      } else {
        setSuccess(true);
      }
    } catch {
      setError(t("resetPassword.unexpectedError"));
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <AuthLayout wide>
          <div className="rounded-2xl border border-white/[0.08] bg-[#212124]/80 p-10 shadow-2xl shadow-black/40 backdrop-blur-xl text-center">
            <div className="mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20">
              <svg className="h-10 w-10 text-emerald-400" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>

            <h1 className="mb-8 text-2xl font-bold text-[#E6E4DD]">
              {t("resetPassword.success.title")}
            </h1>

            <Link to="/login">
              <button className="w-full rounded-xl bg-gold px-4 py-3 text-sm font-bold text-[#181818] shadow-[0_0_20px_rgba(201,162,94,0.15)] transition-all hover:bg-[#F0C24A] hover:shadow-[0_0_30px_rgba(201,162,94,0.25)] active:scale-[0.98]">
                {t("resetPassword.success.signIn")}
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
            {t("resetPassword.title")}
          </h1>
        </div>

        <div className="rounded-2xl border border-white/[0.08] bg-[#212124]/80 p-8 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <form onSubmit={handleSubmit} className="space-y-4">
            <input
              type="password"
              placeholder={t("resetPassword.newPasswordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              autoFocus
              className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-4 py-3 text-sm text-[#E6E4DD] placeholder:text-[#B9B6AE]/50 outline-none transition-colors focus:border-gold/40 focus:ring-1 focus:ring-gold/20"
            />
            <input
              type="password"
              placeholder={t("resetPassword.confirmPasswordPlaceholder")}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-4 py-3 text-sm text-[#E6E4DD] placeholder:text-[#B9B6AE]/50 outline-none transition-colors focus:border-gold/40 focus:ring-1 focus:ring-gold/20"
            />

            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !token}
              className="w-full rounded-xl bg-gold px-4 py-3 text-sm font-bold text-[#181818] shadow-[0_0_20px_rgba(201,162,94,0.15)] transition-all hover:bg-[#F0C24A] hover:shadow-[0_0_30px_rgba(201,162,94,0.25)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? t("resetPassword.submitting") : t("resetPassword.submit")}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-[#B9B6AE]/60">
          {t("resetPassword.needNewLink")}{" "}
          <Link to="/forgot-password" className="font-semibold text-gold transition-colors hover:text-[#F0C24A]">
            {t("resetPassword.requestReset")}
          </Link>
        </p>
    </AuthLayout>
  );
}
