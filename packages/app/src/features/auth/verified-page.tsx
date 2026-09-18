import { useEffect, useState } from "react";
import { isGameReturnTo, readSafeAuthReturnTo } from "@/lib/auth-return";
import { useNavigate } from "@tanstack/react-router";
import { getLandingRoute } from "@/edition/routes";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "./auth-layout";

export function VerifiedPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  // The PvZ invite flow: a refused joiner registered mid-join, and the room is still waiting.
  const gameReturnTo = typeof window !== "undefined"
    ? (() => { const v = readSafeAuthReturnTo(window.location.search);
               return v && isGameReturnTo(v) ? v : undefined; })()
    : undefined;
  const continueOn = () => {
    if (gameReturnTo) window.location.replace(gameReturnTo);
    else navigate({ to: getLandingRoute() });
  };
  const [countdown, setCountdown] = useState(4);
  // Better Auth redirects verification FAILURES here too, as
  // /verified?error=TOKEN_EXPIRED (links expire after 1h) — without reading
  // it this page showed "Email verified!" to users whose link was dead.
  const [verifyError] = useState(
    () => new URLSearchParams(window.location.search).get("error"),
  );

  useEffect(() => {
    if (verifyError) return;
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          continueOn();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [navigate, verifyError]);

  if (verifyError) {
    return (
      <AuthLayout wide>
        <div className="rounded-2xl border border-white/[0.08] bg-[#212124]/80 p-10 shadow-2xl shadow-black/40 backdrop-blur-xl text-center">
          <div className="mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-full bg-amber-500/10 ring-1 ring-amber-500/20">
            <svg
              className="h-10 w-10 text-amber-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
          </div>

          <h1 className="mb-2 text-2xl font-bold text-[#E6E4DD]">
            {t("verified.failedTitle")}
          </h1>
          <p className="mb-8 text-sm text-[#B9B6AE] leading-relaxed">
            {t("verified.failedDescription")}
          </p>

          <button
            onClick={() => navigate({ to: "/login" })}
            className="mt-2 w-full rounded-xl bg-gold px-4 py-3 text-sm font-bold text-[#181818] shadow-[0_0_20px_rgba(201,162,94,0.15)] transition-all hover:bg-[#F0C24A] hover:shadow-[0_0_30px_rgba(201,162,94,0.25)] active:scale-[0.98]"
          >
            {t("verified.backToLogin")}
          </button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout wide>
        <div className="rounded-2xl border border-white/[0.08] bg-[#212124]/80 p-10 shadow-2xl shadow-black/40 backdrop-blur-xl text-center">
          {/* Animated checkmark */}
          <div className="mx-auto mb-8 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/20">
            <svg
              className="h-10 w-10 text-emerald-400 animate-[scale-in_0.4s_ease-out]"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
                className="animate-[draw-check_0.5s_ease-out_0.2s_both]"
                style={{
                  strokeDasharray: 24,
                  strokeDashoffset: 24,
                  animation: "draw-check 0.5s ease-out 0.2s forwards",
                }}
              />
            </svg>
          </div>

          <h1 className="mb-2 text-2xl font-bold text-[#E6E4DD]">
            {t("verified.title")}
          </h1>
          <p className="mb-8 text-sm text-[#B9B6AE] leading-relaxed">
            {t("verified.description")}
          </p>

          {/* Progress ring / redirect notice */}
          <p className="text-xs text-[#B9B6AE]/50">
            {t("verified.redirecting", { seconds: countdown })}
          </p>

          <button
            onClick={continueOn}
            className="mt-6 w-full rounded-xl bg-gold px-4 py-3 text-sm font-bold text-[#181818] shadow-[0_0_20px_rgba(201,162,94,0.15)] transition-all hover:bg-[#F0C24A] hover:shadow-[0_0_30px_rgba(201,162,94,0.25)] active:scale-[0.98]"
          >
            {t("verified.continue")}
          </button>
        </div>

      {/* Inline keyframes for the checkmark animation */}
      <style>{`
        @keyframes draw-check {
          to { stroke-dashoffset: 0; }
        }
        @keyframes scale-in {
          from { transform: scale(0.5); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </AuthLayout>
  );
}
