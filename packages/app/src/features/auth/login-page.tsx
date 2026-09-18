import { useState, useCallback, useRef, useLayoutEffect } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { signIn, signOut, useSession } from "@/lib/auth-client";
import { markLoginComplete } from "@/lib/auth-guard";
import { getAuthErrorKey } from "@/lib/auth-errors";
import { isGameReturnTo, readSafeAuthReturnTo } from "@/lib/auth-return";
import { isCreatorHost } from "@/lib/creator-hub-url";
import { getLandingRoute } from "@/edition/routes";
import { Separator } from "@/components/ui/separator";
import { Turnstile, type TurnstileHandle } from "@/components/turnstile";
import { AuthLayout } from "./auth-layout";
import { VerificationPending } from "./verification-pending";

export function LoginPage() {
  const { t } = useTranslation("auth");
  const router = useRouter();
  const { data: session } = useSession();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() => {
    if (typeof window === "undefined") return "";
    const code = new URLSearchParams(window.location.search).get("error");
    return code ? t(getAuthErrorKey({ code }) as any) : "";
  });
  const [loading, setLoading] = useState(false);
  const [accountDeleted] = useState(() =>
    typeof window !== "undefined"
      && new URLSearchParams(window.location.search).get("accountDeleted") === "1"
  );
  const [returnTo] = useState(() =>
    typeof window === "undefined"
      ? undefined
      : readSafeAuthReturnTo(window.location.search)
  );

  // Show verification screen when unverified user tries to log in
  const [showVerification, setShowVerification] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState("");

  // Turnstile token
  const [turnstileToken, setTurnstileToken] = useState("");
  const turnstileRef = useRef<TurnstileHandle>(null);
  const handleTurnstileToken = useCallback((token: string) => setTurnstileToken(token), []);

  // Already signed in (e.g. navigated to /login from the top bar) — bounce to
  // the hub without flashing the login form. Replaces the old route-level
  // beforeLoad guard, which blocked every /login navigation on a session fetch.
  useLayoutEffect(() => {
    if (session) {
      // A game path lives OUTSIDE the SPA (the PvZ page): leave by full navigation, straight
      // back into the room the invite named. Everything else stays a router hop.
      if (returnTo && isGameReturnTo(returnTo)) {
        window.location.replace(returnTo);
        return;
      }
      void router.navigate({
        to: returnTo ?? getLandingRoute(),
        replace: true,
      });
    }
  }, [session, router, returnTo]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const isEmail = identifier.includes("@");

      const turnstilePayload = turnstileToken ? { "cf-turnstile-response": turnstileToken } : {};
      const result = isEmail
        ? await signIn.email({ email: identifier, password, ...turnstilePayload } as any)
        : await signIn.username({ username: identifier, password, ...turnstilePayload } as any);

      if (result.error) {
        // If email not verified, show verification screen instead of error
        if (result.error.message === "Email not verified") {
          setVerificationEmail(isEmail ? identifier : "");
          setShowVerification(true);
          return;
        }
        setError(t(getAuthErrorKey(result.error) as any));
      } else {
        markLoginComplete();
        if (returnTo === "/delete-account") {
          router.navigate({ to: "/delete-account" });
          return;
        }
        // Land users back on the subdomain they signed in from. Without
        // this, a creator.yumina.io sign-in would bounce them to
        // yumina.io/app/hub.
        if (typeof window !== "undefined" && isCreatorHost(window.location.hostname)) {
          router.navigate({ to: "/" });
        } else {
          router.navigate({ to: getLandingRoute() });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      if (msg.includes("429") || msg.toLowerCase().includes("too many") || msg.includes("rate")) {
        setError(t("errors.rateLimited" as any));
      } else if (msg.includes("401") || msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("password")) {
        setError(t("errors.invalidCredentials" as any));
      } else {
        setError(t("login.unexpectedError"));
      }
    } finally {
      setLoading(false);
      // Turnstile tokens are single-use; refresh after every attempt so a
      // retry doesn't re-send a spent token (which would fail verification).
      setTurnstileToken("");
      turnstileRef.current?.reset();
    }
  };

  const handleOAuthLogin = async (provider: "google" | "discord" | "twitter") => {
    // Force-clear any stale session before initiating OAuth. With account
    // linking enabled, signing in while authenticated would link the new
    // provider's identity to the current session instead of authenticating
    // as a different user — which manifests as "every login lands me on
    // the same account I first signed in as." Clearing first guarantees
    // a fresh sign-in.
    try {
      await signOut();
    } catch {
      /* no session to clear — proceed */
    }

    // Better Auth resolves a relative callbackURL against baseURL
    // (yumina.io). For creator.yumina.io we must pass an absolute URL so
    // the post-OAuth redirect lands the user back on the subdomain they
    // started from. The destination must be in trustedOrigins on the
    // server (it is — see auth.ts).
    const callbackURL = returnTo === "/delete-account"
      ? `${window.location.origin}/delete-account`
      : returnTo && isGameReturnTo(returnTo)
      ? `${window.location.origin}${returnTo}`
      : typeof window !== "undefined" && isCreatorHost(window.location.hostname)
        ? window.location.origin
        : getLandingRoute();
    const errorCallbackURL = new URL("/login", window.location.origin);
    if (returnTo) errorCallbackURL.searchParams.set("returnTo", returnTo);

    const result = await signIn.social({
      provider,
      callbackURL,
      errorCallbackURL: errorCallbackURL.toString(),
    });
    if (result?.error) {
      setError(result.error.message ?? t("login.failedOAuth", { provider }));
    } else if (result?.data?.url) {
      window.location.href = result.data.url;
    }
  };

  if (session) return null;

  if (showVerification) {
    return <VerificationPending email={verificationEmail} />;
  }

  return (
    <AuthLayout>
        {/* Logo */}
        <div className="mb-3.5 text-center sm:mb-6">
          <h1 className="text-[1.75rem] font-black tracking-tight text-[#E6E4DD] sm:text-[2rem]">
            {t("login.title")}
          </h1>
          <p className="mt-1 text-[11px] leading-snug text-[#B9B6AE] sm:mt-1.5 sm:text-xs">
            {t("login.subtitle")}
          </p>
        </div>

        {accountDeleted && (
          <div className="mb-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-center text-xs leading-relaxed text-emerald-300 sm:mb-4">
            {t("login.accountDeleted")}
          </div>
        )}

        {/* Card */}
        <div className="rounded-[1.2rem] border border-white/[0.08] bg-[#212124]/80 p-4 shadow-2xl shadow-black/40 backdrop-blur-xl sm:rounded-[1.35rem] sm:p-5">
          {/* OAuth buttons */}
          <div className="space-y-2.5">
            <button
              onClick={() => handleOAuthLogin("google")}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-3 py-2.25 text-[12px] font-semibold text-[#E6E4DD] transition-all hover:border-white/[0.15] hover:bg-white/[0.06] active:scale-[0.98] sm:px-3.5 sm:py-2.5 sm:text-[13px]"
            >
              <svg className="h-4 w-4 sm:h-4.5 sm:w-4.5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              {t("login.continueWithGoogle")}
            </button>

            <button
              onClick={() => handleOAuthLogin("discord")}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-3 py-2.25 text-[12px] font-semibold text-[#E6E4DD] transition-all hover:border-[#5865F2]/40 hover:bg-[#5865F2]/10 active:scale-[0.98] sm:px-3.5 sm:py-2.5 sm:text-[13px]"
            >
              <svg className="h-4 w-4 text-[#5865F2] sm:h-4.5 sm:w-4.5" viewBox="0 0 24 24">
                <path fill="currentColor" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
              {t("login.continueWithDiscord")}
            </button>

            <button
              onClick={() => handleOAuthLogin("twitter")}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-3 py-2.25 text-[12px] font-semibold text-[#E6E4DD] transition-all hover:border-white/[0.15] hover:bg-white/[0.06] active:scale-[0.98] sm:px-3.5 sm:py-2.5 sm:text-[13px]"
            >
              <svg className="h-3.5 w-3.5 text-[#E6E4DD] sm:h-4 sm:w-4" viewBox="0 0 24 24">
                <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              {t("login.continueWithX")}
            </button>
          </div>

          {/* Divider */}
          <div className="relative my-3.5 sm:my-4.5">
            <Separator className="bg-white/[0.06]" />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#212124] px-3 text-[11px] font-medium text-[#B9B6AE]/60 sm:text-xs">
              {t("login.divider")}
            </span>
          </div>

          {/* Email/password form */}
          <form onSubmit={handleLogin} className="space-y-2.5 sm:space-y-3">
            <div>
              <input
                type="text"
                placeholder={t("login.identifierPlaceholder")}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                autoComplete="username"
                className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-3 py-2.25 text-[12px] text-[#E6E4DD] placeholder:text-[#B9B6AE]/50 outline-none transition-colors focus:border-gold/40 focus:ring-1 focus:ring-gold/20 sm:px-3.5 sm:py-2.5 sm:text-[13px]"
              />
            </div>
            <div>
              <input
                type="password"
                placeholder={t("login.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full rounded-xl border border-white/[0.08] bg-[#1A1A1C] px-3 py-2.25 text-[12px] text-[#E6E4DD] placeholder:text-[#B9B6AE]/50 outline-none transition-colors focus:border-gold/40 focus:ring-1 focus:ring-gold/20 sm:px-3.5 sm:py-2.5 sm:text-[13px]"
              />
            </div>

            <div className="flex justify-end">
              <Link to="/forgot-password" className="text-[11px] font-medium text-[#B9B6AE]/60 transition-colors hover:text-gold">
                {t("login.forgotPassword")}
              </Link>
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-[12px] leading-snug text-red-400 sm:px-3 sm:py-2 sm:text-[13px]">
                {error}
              </div>
            )}

            <Turnstile ref={turnstileRef} onToken={handleTurnstileToken} />

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-gold px-4 py-2.25 text-[12px] font-bold text-[#181818] shadow-[0_0_20px_rgba(201,162,94,0.15)] transition-all hover:bg-[#F0C24A] hover:shadow-[0_0_30px_rgba(201,162,94,0.25)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 sm:py-2.5 sm:text-[13px]"
            >
              {loading ? t("login.submitting") : t("login.submit")}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="mt-3 text-center text-[11px] text-[#B9B6AE]/60 sm:mt-4 sm:text-xs">
          {t("login.noAccount")}{" "}
          <Link to="/register" search={returnTo ? { returnTo } : undefined} className="font-semibold text-gold transition-colors hover:text-[#F0C24A]">
            {t("login.createOne")}
          </Link>
        </p>
    </AuthLayout>
  );
}
