import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { signUp, authClient } from "@/lib/auth-client";
import { readSafeAuthReturnTo } from "@/lib/auth-return";
import { getAuthErrorKey } from "@/lib/auth-errors";
import { trackSignupConversion } from "@/lib/analytics";
import { Turnstile, type TurnstileHandle } from "@/components/turnstile";
import { AuthLayout } from "./auth-layout";
import { VerificationPending } from "./verification-pending";

export function RegisterPage() {
  const { t } = useTranslation("auth");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Username availability
  const [usernameStatus, setUsernameStatus] = useState<"idle" | "checking" | "available" | "taken">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Verification screen state
  const [showVerification, setShowVerification] = useState(false);

  // Turnstile token
  const [turnstileToken, setTurnstileToken] = useState("");
  const turnstileRef = useRef<TurnstileHandle>(null);
  const handleTurnstileToken = useCallback((token: string) => setTurnstileToken(token), []);

  // Debounced username availability check
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (username.length < 3) {
      setUsernameStatus("idle");
      return;
    }

    setUsernameStatus("checking");
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await authClient.isUsernameAvailable({ username });
        setUsernameStatus(res.data?.available ? "available" : "taken");
      } catch {
        setUsernameStatus("idle");
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [username]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    setLoading(true);
    try {
      const turnstilePayload = turnstileToken ? { "cf-turnstile-response": turnstileToken } : {};
      const result = await signUp.email({
        name,
        username,
        email,
        password,
        // Verification links (success AND failure, e.g. TOKEN_EXPIRED) land on
        // /verified, which renders both states. The default "/" drops the
        // ?error= param and strands failed verifications on the hub, logged out.
        // A game return address (the PvZ invite flow) rides along so the
        // verified page can send the new player back into their friend's room.
        callbackURL: (() => {
          const aReturnTo = typeof window !== "undefined"
            ? readSafeAuthReturnTo(window.location.search) : undefined;
          return aReturnTo
            ? `/verified?returnTo=${encodeURIComponent(aReturnTo)}`
            : "/verified";
        })(),
        ...turnstilePayload,
      } as any);
      if (result.error) {
        setError(t(getAuthErrorKey(result.error) as any));
      } else {
        // Account row exists from this point — report the signup conversion
        // (PostHog + ad pixels) before the verification-pending screen.
        trackSignupConversion((result.data as { user?: { id?: string } } | null)?.user?.id);
        setShowVerification(true);
      }
    } catch {
      setError(t("register.unexpectedError"));
    } finally {
      setLoading(false);
      // Turnstile tokens are single-use; refresh after every attempt so a
      // retry doesn't re-send a spent token (which would fail verification).
      setTurnstileToken("");
      turnstileRef.current?.reset();
    }
  };

  if (showVerification) {
    return <VerificationPending email={email} />;
  }

  return (
    <AuthLayout>
        {/* Logo */}
        <div className="mb-3.5 text-center sm:mb-6">
          <h1 className="text-[1.75rem] font-black tracking-tight text-[#E6E4DD] sm:text-[2rem]">
            {t("register.title")}
          </h1>
          <p className="mt-1 text-[11px] leading-snug text-[#B9B6AE] sm:mt-1.5 sm:text-xs">
            {t("register.subtitle")}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-[1.2rem] border border-white/[0.08] bg-[#212124]/80 p-4 shadow-2xl shadow-black/40 backdrop-blur-xl sm:rounded-[1.35rem] sm:p-5">
          {/* Email form */}
          <form onSubmit={handleRegister} className="space-y-2.5 sm:space-y-3">
            <input
              type="text"
              placeholder={t("register.displayNamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
              className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-3 py-2.25 text-[12px] text-[#E6E4DD] placeholder:text-[#B9B6AE]/50 outline-none transition-colors focus:border-gold/40 focus:ring-1 focus:ring-gold/20 sm:px-3.5 sm:py-2.5 sm:text-[13px]"
            />
            <div>
              <input
                type="text"
                placeholder={t("register.usernamePlaceholder")}
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                required
                minLength={3}
                maxLength={20}
                autoComplete="username"
                className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-3 py-2.25 text-[12px] text-[#E6E4DD] placeholder:text-[#B9B6AE]/50 outline-none transition-colors focus:border-gold/40 focus:ring-1 focus:ring-gold/20 sm:px-3.5 sm:py-2.5 sm:text-[13px]"
              />
              <div className="mt-1.5 flex items-center justify-between px-1">
                <span className="text-[9px] text-[#B9B6AE]/40 sm:text-[10px]">{t("register.usernameHint")}</span>
                {usernameStatus === "checking" && (
                  <span className="text-[9px] text-[#B9B6AE]/40 sm:text-[10px]">{t("register.usernameChecking")}</span>
                )}
                {usernameStatus === "available" && (
                  <span className="text-[9px] text-emerald-400 sm:text-[10px]">{t("register.usernameAvailable")}</span>
                )}
                {usernameStatus === "taken" && (
                  <span className="text-[9px] text-red-400 sm:text-[10px]">{t("register.usernameTaken")}</span>
                )}
              </div>
            </div>
            <input
              type="email"
              placeholder={t("register.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-3 py-2.25 text-[12px] text-[#E6E4DD] placeholder:text-[#B9B6AE]/50 outline-none transition-colors focus:border-gold/40 focus:ring-1 focus:ring-gold/20 sm:px-3.5 sm:py-2.5 sm:text-[13px]"
            />
            <input
              type="password"
              placeholder={t("register.passwordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-3 py-2.25 text-[12px] text-[#E6E4DD] placeholder:text-[#B9B6AE]/50 outline-none transition-colors focus:border-gold/40 focus:ring-1 focus:ring-gold/20 sm:px-3.5 sm:py-2.5 sm:text-[13px]"
            />

            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-[12px] leading-snug text-red-400 sm:px-3 sm:py-2 sm:text-[13px]">
                {error}
                {error === t("errors.userAlreadyExists") && (
                  <div className="mt-1.5 flex gap-2 text-[11px]">
                    <Link to="/login" className="font-semibold text-gold hover:text-[#F0C24A]">
                      {t("register.signIn")}
                    </Link>
                    <Link to="/forgot-password" className="font-semibold text-gold hover:text-[#F0C24A]">
                      {t("login.forgotPassword")}
                    </Link>
                  </div>
                )}
              </div>
            )}

            <Turnstile ref={turnstileRef} onToken={handleTurnstileToken} />

            <button
              type="submit"
              disabled={loading || usernameStatus === "taken"}
              className="w-full rounded-xl bg-gold px-4 py-2.25 text-[12px] font-bold text-[#181818] shadow-[0_0_20px_rgba(201,162,94,0.15)] transition-all hover:bg-[#F0C24A] hover:shadow-[0_0_30px_rgba(201,162,94,0.25)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 sm:py-2.5 sm:text-[13px]"
            >
              {loading ? t("register.submitting") : t("register.submit")}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="mt-3 text-center text-[11px] text-[#B9B6AE]/60 sm:mt-4 sm:text-xs">
          {t("register.hasAccount")}{" "}
          <Link to="/login" className="font-semibold text-gold transition-colors hover:text-[#F0C24A]">
            {t("register.signIn")}
          </Link>
        </p>
    </AuthLayout>
  );
}
