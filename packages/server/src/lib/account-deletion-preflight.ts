import { evaluateAccountDeletionAccess } from "./account-deletion-access.js";
import { accountDeletionBlockedUntil } from "./account-deletion-cooldown.js";
import type { StripeCleanupArtifacts } from "./account-deletion-policy.js";

export type DeletionIssueCode = "ACCOUNT_DELETION_NOT_READY" | "LAST_ADMIN_ACCOUNT"
  | "ACCOUNT_DELETION_COOLDOWN" | "PENDING_CREATOR_EARNINGS" | "BILLING_CLEANUP_UNAVAILABLE";
export type BillingRecordKind = "customer" | "subscription" | "connect" | "payment" | "checkout";
export type DeletionIssue = {
  code: DeletionIssueCode;
  message: string;
  blocksEmail: boolean;
  blockedUntil?: string;
  billingRecords?: BillingRecordKind[];
};
export type DeletionPreflight = { issues: DeletionIssue[]; canSendEmail: boolean; canDelete: boolean };

/** Read-only diagnostics. Email delivery never performs external billing cleanup. */
export function evaluateDeletionPreflight(input: {
  schemaReady: boolean;
  role?: string | null;
  activeAdministrators: number;
  restricted: boolean;
  latestDeletionAt?: Date | null;
  unsettledEarnings: boolean;
  stripeConfigured: boolean;
  billing: StripeCleanupArtifacts;
}, now = new Date()): DeletionPreflight {
  const issues: DeletionIssue[] = [];
  if (!input.schemaReady) {
    issues.push({ code: "ACCOUNT_DELETION_NOT_READY", blocksEmail: true,
      message: "Account deletion is temporarily unavailable while the server finishes preparing." });
  } else {
    const access = evaluateAccountDeletionAccess(input.role, input.activeAdministrators, input.restricted);
    if (!access.allowed) issues.push({ code: access.code, message: access.message, blocksEmail: true });
    const blockedUntil = accountDeletionBlockedUntil(input.latestDeletionAt, now);
    if (blockedUntil) issues.push({ code: "ACCOUNT_DELETION_COOLDOWN", blocksEmail: true,
      message: "Wait until the repeat-deletion cooldown ends.", blockedUntil: blockedUntil.toISOString() });
    if (input.unsettledEarnings) issues.push({ code: "PENDING_CREATOR_EARNINGS", blocksEmail: true,
      message: "Creator earnings are awaiting settlement. Contact support before deleting this account." });
    const billingRecords: BillingRecordKind[] = [];
    if (input.billing.stripeCustomerId) billingRecords.push("customer");
    if (input.billing.stripeSubscriptionId) billingRecords.push("subscription");
    if (input.billing.stripeConnectId) billingRecords.push("connect");
    if (input.billing.stripePaymentIntentIds?.length) billingRecords.push("payment");
    if (input.billing.stripeCheckoutSessionIds?.length) billingRecords.push("checkout");
    if (!input.stripeConfigured && billingRecords.length) issues.push({
      code: "BILLING_CLEANUP_UNAVAILABLE", blocksEmail: false, billingRecords,
      message: "Payment-service configuration is unavailable and this account has billing records to clean up. Contact support. You can still request the confirmation email; final deletion remains blocked.",
    });
  }
  return { issues, canSendEmail: !issues.some(issue => issue.blocksEmail), canDelete: issues.length === 0 };
}
