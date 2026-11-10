import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export type DeletionIssue = {
  code: string;
  blocksEmail: boolean;
  blockedUntil?: string;
  billingRecords?: string[];
};
export type DeletionPreflight = { issues: DeletionIssue[]; canSendEmail: boolean; canDelete: boolean };
export type DeleteAccountResponse = {
  success?: boolean; code?: string; blockedUntil?: string;
  issues?: DeletionIssue[]; preflight?: DeletionPreflight;
};

type Translate = ReturnType<typeof useTranslation<"settings">>["t"];
export function deletionErrorMessage(t: Translate, code?: string, blockedUntil?: string): string {
  if (code === "ACCOUNT_DELETION_COOLDOWN") {
    const at = blockedUntil ? new Date(blockedUntil) : null;
    return at && !Number.isNaN(at.getTime())
      ? t("account.deleteAccount.errors.cooldownUntil", { time: at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) })
      : t("account.deleteAccount.errors.cooldown");
  }
  switch (code) {
    case "CONFIRMATION_MISMATCH": return t("account.deleteAccount.errors.confirmationMismatch");
    case "PENDING_CREATOR_EARNINGS": return t("account.deleteAccount.errors.pendingEarnings");
    case "BILLING_CLEANUP_UNAVAILABLE": return t("account.deleteAccount.errors.billingUnavailable");
    case "SUBSCRIPTION_CANCELLATION_FAILED": return t("account.deleteAccount.errors.billing");
    case "SUBSCRIPTION_LOOKUP_FAILED": return t("account.deleteAccount.errors.subscriptionLookup");
    case "PAYMENT_SETTLEMENT_PENDING": return t("account.deleteAccount.errors.paymentPending");
    case "CREATOR_ACCOUNT_CLOSURE_FAILED": return t("account.deleteAccount.errors.creatorAccount");
    case "ACCOUNT_DELETION_NOT_READY": return t("account.deleteAccount.errors.notReady");
    case "LAST_ADMIN_ACCOUNT": return t("account.deleteAccount.errors.lastAdmin");
    case "REFERRAL_HISTORY_REQUIRES_SUPPORT": return t("account.deleteAccount.errors.referral");
    case "ACCOUNT_RESTRICTION_REQUIRES_SUPPORT": return t("account.deleteAccount.errors.protectedHistory");
    case "DELETE_CONFIRMATION_EMAIL_FAILED": return t("account.deleteAccount.errors.email");
    case "INVALID_TOKEN":
    case "INVALID_DELETE_TOKEN":
    case "FAILED_TO_GET_USER_INFO": return t("account.deleteAccount.errors.invalidLink");
    case "UNAUTHORIZED": return t("account.deleteAccount.errors.signIn");
    case "INVALID_REQUEST_ORIGIN": return t("account.deleteAccount.errors.origin");
    case "INVALID_REQUEST": return t("account.deleteAccount.errors.request");
    default: return t("account.deleteAccount.errors.generic");
  }
}

export function useDeletionPreflight(enabled: boolean) {
  const [report, setReport] = useState<DeletionPreflight | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setReport(null);
    setFailed(false);
    if (!enabled) return;
    const controller = new AbortController();
    void fetch(`${import.meta.env.VITE_API_URL || ""}/api/auth/delete-user/preflight`, {
      credentials: "include", cache: "no-store", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("Preflight unavailable");
      const payload = await response.json() as { data?: DeletionPreflight };
      if (!payload.data || !Array.isArray(payload.data.issues)
        || typeof payload.data.canSendEmail !== "boolean" || typeof payload.data.canDelete !== "boolean") {
        throw new Error("Invalid preflight");
      }
      if (!controller.signal.aborted) setReport(payload.data);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [enabled, revision]);
  return { report, setReport, failed, retry: () => { setReport(null); setFailed(false); setRevision(n => n + 1); } };
}

export function DeletionPreflightNotice({ report, failed, retry }: {
  report: DeletionPreflight | null; failed: boolean; retry: () => void;
}) {
  const { t } = useTranslation("settings");
  if (!report) return <div role="status" className="text-left text-xs leading-relaxed text-sub">
    {failed ? t("account.deleteAccount.preflight.failed") : t("account.deleteAccount.preflight.loading")}
    {failed && <button type="button" onClick={retry} className="ml-2 underline">{t("account.deleteAccount.preflight.retry")}</button>}
  </div>;
  if (!report.issues.length) return null;
  const recordLabels: Record<string, string> = {
    customer: t("account.deleteAccount.preflight.recordKinds.customer"),
    subscription: t("account.deleteAccount.preflight.recordKinds.subscription"),
    connect: t("account.deleteAccount.preflight.recordKinds.connect"),
    payment: t("account.deleteAccount.preflight.recordKinds.payment"),
    checkout: t("account.deleteAccount.preflight.recordKinds.checkout"),
  };
  return <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-left text-xs leading-relaxed text-amber-100">
    <p className="font-semibold">{t("account.deleteAccount.preflight.title")}</p>
    <ul className="mt-2 list-disc space-y-2 pl-4">
      {report.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>
        <span>{deletionErrorMessage(t, issue.code, issue.blockedUntil)}</span>
        {!!issue.billingRecords?.length && <p className="mt-1 text-amber-100/80">
          {t("account.deleteAccount.preflight.records", { records: issue.billingRecords
            .map(kind => recordLabels[kind]).filter(Boolean).join(" / ") })}
        </p>}
      </li>)}
    </ul>
    <p className="mt-2">{report.canSendEmail ? t("account.deleteAccount.preflight.emailAllowed") : t("account.deleteAccount.preflight.emailBlocked")}</p>
    <p className="mt-1 text-amber-100/70">{t("account.deleteAccount.preflight.scope")}</p>
    <button type="button" onClick={retry} className="mt-2 underline">{t("account.deleteAccount.preflight.retry")}</button>
  </div>;
}
