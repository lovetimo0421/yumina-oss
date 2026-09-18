import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AuthLayout } from "@/features/auth/auth-layout";
import { clearLocalAuthStateAfterDeletion, useSession } from "@/lib/auth-client";

const apiBase = import.meta.env.VITE_API_URL || "";

type DeleteAccountResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  code?: string;
};

export function AccountDeletionConfirmPage({ token }: { token: string }) {
  const { t } = useTranslation("settings");
  const { data: session, isPending } = useSession();
  const [confirmationTarget, setConfirmationTarget] = useState("");
  const [targetError, setTargetError] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState("");

  const canDelete = !!token
    && !!confirmationTarget
    && confirmation.trim() === confirmationTarget
    && acknowledged
    && !deleting;

  useEffect(() => {
    if (!session?.user?.id) {
      setConfirmationTarget("");
      setTargetError(false);
      return;
    }

    let cancelled = false;
    setTargetError(false);
    void fetch(`${apiBase}/api/users/me`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load account");
        const payload = await response.json() as {
          data?: {
            username?: string | null;
            email?: string | null;
          };
        };
        const target = payload.data?.username?.trim() || payload.data?.email?.trim() || "";
        if (!target) throw new Error("Missing account confirmation target");
        if (!cancelled) {
          setConfirmationTarget(target);
        }
      })
      .catch(() => {
        if (!cancelled) setTargetError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const getErrorMessage = (code?: string) => {
    switch (code) {
      case "CONFIRMATION_MISMATCH":
        return t("account.deleteAccount.errors.confirmationMismatch");
      case "PENDING_CREATOR_EARNINGS":
        return t("account.deleteAccount.errors.pendingEarnings");
      case "BILLING_CLEANUP_UNAVAILABLE":
      case "SUBSCRIPTION_CANCELLATION_FAILED":
        return t("account.deleteAccount.errors.billing");
      case "CREATOR_ACCOUNT_CLOSURE_FAILED":
        return t("account.deleteAccount.errors.creatorAccount");
      case "ACCOUNT_DELETION_NOT_READY":
        return t("account.deleteAccount.errors.notReady");
      case "ACCOUNT_DELETION_COOLDOWN":
        return t("account.deleteAccount.errors.cooldown");
      case "LAST_ADMIN_ACCOUNT":
        return t("account.deleteAccount.errors.lastAdmin");
      case "REFERRAL_HISTORY_REQUIRES_SUPPORT":
        return t("account.deleteAccount.errors.referral");
      case "ACCOUNT_RESTRICTION_REQUIRES_SUPPORT":
        return t("account.deleteAccount.errors.protectedHistory");
      case "DELETE_CONFIRMATION_EMAIL_FAILED":
        return t("account.deleteAccount.errors.email");
      case "INVALID_TOKEN":
      case "INVALID_DELETE_TOKEN":
      case "FAILED_TO_GET_USER_INFO":
        return t("account.deleteAccount.errors.invalidLink");
      default:
        return t("account.deleteAccount.errors.generic");
    }
  };

  const handleDelete = async () => {
    if (!canDelete) return;
    setDeleting(true);
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/auth/delete-user`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          confirmation: confirmation.trim(),
        }),
      });
      const payload = await response.json().catch(() => ({})) as DeleteAccountResponse;

      if (!response.ok || !payload.success) {
        if (payload.code === "INVALID_TOKEN" || payload.code === "INVALID_DELETE_TOKEN" || payload.code === "FAILED_TO_GET_USER_INFO") {
          clearDeletionToken();
        }
        setError(getErrorMessage(payload.code));
        return;
      }

      clearLocalAuthStateAfterDeletion();
      clearDeletionToken();
      window.location.replace("/login?accountDeleted=1");
    } catch {
      setError(t("account.deleteAccount.errors.generic"));
    } finally {
      setDeleting(false);
    }
  };

  const handleCancel = async () => {
    if (canceling || deleting) return;
    setCanceling(true);
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/auth/delete-user/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        setError(t("account.deleteAccount.errors.generic"));
        return;
      }
      clearDeletionToken();
      window.location.replace("/app/settings#account");
    } catch {
      setError(t("account.deleteAccount.errors.generic"));
    } finally {
      setCanceling(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout wide>
        <StatusCard
          title={t("account.deleteAccount.invalidLinkTitle")}
          description={t("account.deleteAccount.errors.invalidLink")}
        />
      </AuthLayout>
    );
  }

  if (isPending) {
    return (
      <AuthLayout wide>
        <div className="flex justify-center py-16 text-sub">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      </AuthLayout>
    );
  }

  if (!session) {
    return (
      <AuthLayout wide>
        <StatusCard
          title={t("account.deleteAccount.signInRequiredTitle")}
          description={t("account.deleteAccount.signInRequiredDescription")}
        >
          <Link
            to="/login"
            search={{ returnTo: "/delete-account" }}
            className="mt-5 inline-flex rounded-xl bg-gold px-5 py-2.5 text-sm font-bold text-[#181818] transition-colors hover:bg-[#F0C24A]"
          >
            {t("account.deleteAccount.signIn")}
          </Link>
        </StatusCard>
      </AuthLayout>
    );
  }

  if (!confirmationTarget) {
    return (
      <AuthLayout wide>
        {targetError ? (
          <StatusCard
            title={t("account.deleteAccount.invalidLinkTitle")}
            description={t("account.deleteAccount.errors.generic")}
          />
        ) : (
          <div className="flex justify-center py-16 text-sub">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout wide>
      <div className="rounded-3xl border border-red-500/25 bg-[#212124]/95 p-5 shadow-2xl shadow-black/40 sm:p-7">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/15 text-red-400">
          <TriangleAlert className="h-6 w-6" />
        </div>
        <h1 className="mt-5 text-xl font-black text-red-200">
          {t("account.deleteAccount.dialogTitle")}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-sub">
          {t("account.deleteAccount.finalConfirmationDescription")}
        </p>

        <div className="mt-5 rounded-xl border border-red-500/25 bg-red-950/25 p-4">
          <div className="text-sm font-bold text-red-200">
            {t("account.deleteAccount.warningTitle")}
          </div>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-xs leading-relaxed text-red-100/70">
            <li>{t("account.deleteAccount.warnings.identity")}</li>
            <li>{t("account.deleteAccount.warnings.deletionCooldown")}</li>
            <li>{t("account.deleteAccount.warnings.content")}</li>
            <li>{t("account.deleteAccount.warnings.community")}</li>
            <li>{t("account.deleteAccount.warnings.billing")}</li>
            <li>{t("account.deleteAccount.warnings.records")}</li>
            <li>{t("account.deleteAccount.warnings.antiAbuse")}</li>
            <li>{t("account.deleteAccount.warnings.cache")}</li>
          </ul>
        </div>

        <div className="mt-5 space-y-2">
          <label htmlFor="final-delete-confirmation" className="text-xs font-semibold text-main">
            {t("account.deleteAccount.confirmLabel", { target: confirmationTarget })}
          </label>
          <input
            id="final-delete-confirmation"
            type="text"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={t("account.deleteAccount.confirmPlaceholder", { target: confirmationTarget })}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl border border-red-500/25 bg-black/20 px-3 py-2.5 text-sm text-main outline-none transition-colors placeholder:text-sub/35 focus:border-red-400/60 focus:ring-1 focus:ring-red-400/20"
          />
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-3 text-xs leading-relaxed text-sub">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-red-500"
          />
          <span>{t("account.deleteAccount.acknowledge")}</span>
        </label>

        {error && (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-300">
            {error}
          </div>
        )}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={handleCancel}
            disabled={canceling || deleting}
            className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-center text-sm font-semibold text-main transition-colors hover:bg-white/[0.08]"
          >
            {canceling ? t("account.deleteAccount.canceling") : t("account.deleteAccount.cancel")}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={!canDelete}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
            {deleting
              ? t("account.deleteAccount.deleting")
              : t("account.deleteAccount.button")}
          </button>
        </div>
      </div>
    </AuthLayout>
  );
}

function clearDeletionToken() {
  try {
    window.sessionStorage.removeItem("yumina-account-deletion-token");
  } catch {
    // Storage may be unavailable in hardened/private browser modes.
  }
  delete (window as Window & {
    __yuminaAccountDeletionToken?: string;
  }).__yuminaAccountDeletionToken;
}

function StatusCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-white/10 bg-[#212124]/95 p-7 text-center shadow-2xl shadow-black/40">
      <h1 className="text-xl font-black text-main">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-sub">{description}</p>
      {children}
    </div>
  );
}
