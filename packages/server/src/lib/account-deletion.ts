import Stripe from "stripe";
import { and, asc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import { db, isAccountDeletionSchemaReady } from "../db/index.js";
import {
  bundles,
  accountDeletionCleanupJobs,
  creditTransactions,
  creditWallets,
  creatorEarnings,
  creatorPayoutAccounts,
  deletedAccountTombstones,
  inviteCodeRedemptions,
  mushieGifts,
  referralMilestones,
  referralRedemptions,
  session,
  threadRewards,
  tipPaymentIntents,
  user,
  userAssets,
  userCheckinStats,
  worlds,
  verification,
} from "../db/schema.js";
import { env } from "./env.js";
import { deleteObject, deletePrefix, isS3Configured } from "./s3.js";
import { redis } from "./redis.js";
import { captureServerError, posthog } from "./posthog.js";
import { invalidateSessionUser } from "./session-user-cache.js";
import {
  getDeletedIdentity,
  hashDeletedIdentity,
  hashDeletedIdentityCandidates,
} from "./deleted-identity.js";
import { accountDeletionBlockedUntil } from "./account-deletion-cooldown.js";
import { REFERRAL_REWARD_EPOCH } from "./referral-rewards.js";
import { mergeReferralClaims } from "./referral-claim-history.js";
import {
  evaluateAccountDeletionAccess,
  type AccountDeletionAccessBlockCode,
  type AccountDeletionAccessDecision,
} from "./account-deletion-access.js";
import { anonymizeDeletedAccountAudit } from "./account-deletion-audit.js";
import {
  eraseDiscoveryAccountData,
  findLinkedDiscoveryGuests,
  purgeErasedDiscoveryEvents,
  purgeErasedDiscoveryEventsBatched,
  type BatchedErasureExecutor,
} from "./discovery-erasure.js";
import {
  CLEANUP_CLAIM_MS,
  CLEANUP_CONTINUE_DELAY_MS,
  CLEANUP_MAX_ATTEMPTS,
  createCleanupTicker,
  planCleanupFailure,
  redisCleanupLease,
  type MinimalLeaseRedis,
} from "./account-deletion-cleanup-runner.js";
import { isRogueInstance } from "./leader.js";
import { hasStripeCleanupArtifacts } from "./account-deletion-policy.js";
import {
  closeStripeConnectAccount,
  isMissingStripeResource,
  listCancelableStripeSubscriptionIds,
  redactAndDeleteConnectAccount,
} from "./account-deletion-stripe.js";

export type AccountDeletionBlockCode =
  | AccountDeletionAccessBlockCode
  | "ACCOUNT_DELETION_NOT_READY"
  | "ACCOUNT_DELETION_COOLDOWN"
  | "PENDING_CREATOR_EARNINGS"
  | "BILLING_CLEANUP_UNAVAILABLE"
  | "SUBSCRIPTION_CANCELLATION_FAILED";

export class AccountDeletionBlockedError extends Error {
  constructor(
    public readonly code: AccountDeletionBlockCode,
    message: string,
  ) {
    super(message);
    this.name = "AccountDeletionBlockedError";
  }
}

export class InvalidAccountDeletionTokenError extends Error {
  constructor() {
    super("The account deletion link is invalid, expired, or has been canceled.");
    this.name = "InvalidAccountDeletionTokenError";
  }
}

const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY)
  : null;

type DeletionContext = {
  email: string;
  wasBanned: boolean;
  wasSuspended: boolean;
  blockInviteRedemption: boolean;
  lastCheckinDay: string | null;
  rewardBlockedUntil: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeConnectId: string | null;
  stripePaymentIntentIds: string[];
  stripeCheckoutSessionIds: string[];
  assetKeys: string[];
  assetPrefixes: string[];
  sessionTokens: string[];
};

type QueryExecutor = Pick<typeof db, "select">;

function assertAccountDeletionAccessDecision(
  decision: AccountDeletionAccessDecision,
): asserts decision is { allowed: true } {
  if (!decision.allowed) {
    throw new AccountDeletionBlockedError(decision.code, decision.message);
  }
}

function assertRepeatDeletionCooldownElapsed(
  latestDeletionAt: Date | null | undefined,
  now = new Date(),
): void {
  const blockedUntil = accountDeletionBlockedUntil(latestDeletionAt, now);
  if (!blockedUntil) return;
  throw new AccountDeletionBlockedError(
    "ACCOUNT_DELETION_COOLDOWN",
    `This account cannot be deleted again until ${blockedUntil.toISOString()}.`,
  );
}

async function getDeletionContext(
  userId: string,
  executor: QueryExecutor = db,
): Promise<DeletionContext> {
  // Keep these sequential: during final deletion `executor` is a single
  // transaction connection holding the user-row lock.
  const accountRows = await executor
    .select({
      email: user.email,
      wasBanned: user.isBanned,
      wasSuspended: user.isSuspended,
      referredBy: user.referredBy,
      stripeCustomerId: user.stripeCustomerId,
      stripeSubscriptionId: user.stripeSubscriptionId,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const inviteRedemptions = await executor
    .select({ id: inviteCodeRedemptions.id })
    .from(inviteCodeRedemptions)
    .where(eq(inviteCodeRedemptions.userId, userId))
    .limit(1);
  const referralRedemption = await executor
    .select({ inviteeId: referralRedemptions.inviteeId })
    .from(referralRedemptions)
    .where(eq(referralRedemptions.inviteeId, userId))
    .limit(1);
  const payoutRows = await executor
    .select({ stripeConnectId: creatorPayoutAccounts.stripeConnectId })
    .from(creatorPayoutAccounts)
    .where(eq(creatorPayoutAccounts.userId, userId))
    .limit(1);
  const assets = await executor
    .select({ key: userAssets.url })
    .from(userAssets)
    .where(eq(userAssets.userId, userId));
  const sessions = await executor
    .select({ token: session.token })
    .from(session)
    .where(eq(session.userId, userId));
  const ownedWorlds = await executor
    .select({ id: worlds.id })
    .from(worlds)
    .where(eq(worlds.creatorId, userId));
  const ownedBundles = await executor
    .select({ id: bundles.id })
    .from(bundles)
    .where(eq(bundles.userId, userId));
  const checkinRows = await executor
    .select({ lastCheckinDay: userCheckinStats.lastDayKey })
    .from(userCheckinStats)
    .where(eq(userCheckinStats.userId, userId))
    .limit(1);
  const walletRows = await executor
    .select({ periodEnd: creditWallets.periodEnd })
    .from(creditWallets)
    .where(eq(creditWallets.userId, userId))
    .limit(1);
  const earningRows = await executor
    .select({ paymentIntentId: creatorEarnings.stripePaymentIntentId })
    .from(creatorEarnings)
    .where(or(
      eq(creatorEarnings.creatorId, userId),
      eq(creatorEarnings.senderId, userId),
    ));
  const pendingTipRows = await executor
    .select({ paymentIntentId: tipPaymentIntents.stripePaymentIntentId })
    .from(tipPaymentIntents)
    .where(or(
      eq(tipPaymentIntents.creatorId, userId),
      eq(tipPaymentIntents.senderId, userId),
    ));
  const walletTransactionRows = await executor
    .select({ referenceId: creditTransactions.referenceId })
    .from(creditTransactions)
    .innerJoin(creditWallets, eq(creditTransactions.walletId, creditWallets.id))
    .where(eq(creditWallets.userId, userId));

  return {
    email: accountRows[0]?.email ?? "",
    wasBanned: accountRows[0]?.wasBanned ?? false,
    wasSuspended: accountRows[0]?.wasSuspended ?? false,
    blockInviteRedemption: !!accountRows[0]?.referredBy || inviteRedemptions.length > 0 || referralRedemption.length > 0,
    lastCheckinDay: checkinRows[0]?.lastCheckinDay ?? null,
    rewardBlockedUntil: walletRows[0]?.periodEnd ?? null,
    stripeCustomerId: accountRows[0]?.stripeCustomerId ?? null,
    stripeSubscriptionId: accountRows[0]?.stripeSubscriptionId ?? null,
    stripeConnectId: payoutRows[0]?.stripeConnectId ?? null,
    stripePaymentIntentIds: [...new Set(
      [...earningRows, ...pendingTipRows]
        .map((row) => row.paymentIntentId)
        .filter((id): id is string => !!id),
    )],
    stripeCheckoutSessionIds: [...new Set(
      walletTransactionRows
        .map((row) => row.referenceId)
        .filter((id): id is string => typeof id === "string" && id.startsWith("cs_")),
    )],
    assetKeys: [...new Set([
      ...assets.map((asset) => asset.key),
    ].filter(Boolean))],
    assetPrefixes: [...new Set([
      `users/${userId}/`,
      `private-session-media/${userId}/`,
      `dm/${userId}/`,
      `studio-chat/${userId}/`,
      `community/${userId}/`,
      `reports/${userId}/`,
      ...ownedWorlds.map((world) => `worlds/${world.id}/`),
      ...ownedBundles.map((bundle) => `bundles/${bundle.id}/`),
    ])],
    sessionTokens: [...new Set(sessions.map((row) => row.token).filter(Boolean))],
  };
}

export async function getAccountDeletionConfirmationTarget(userId: string): Promise<string | null> {
  const [account] = await db
    .select({ username: user.username, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  return account?.username?.trim() || account?.email.trim() || null;
}

/**
 * Cheap guard used both when requesting the confirmation email and again when
 * its link is opened. Held creator earnings must be settled while the creator
 * identity and Connect account still exist.
 */
export async function assertAccountDeletionAllowed(userId: string): Promise<void> {
  if (!isAccountDeletionSchemaReady()) {
    throw new AccountDeletionBlockedError(
      "ACCOUNT_DELETION_NOT_READY",
      "Account deletion is temporarily unavailable while the server finishes preparing. Try again shortly.",
    );
  }

  const [account] = await db
    .select({
      email: user.email,
      role: user.role,
      isBanned: user.isBanned,
      isSuspended: user.isSuspended,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const [administratorCountRow] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(user)
    .where(and(
      eq(user.role, "admin"),
      eq(user.isBanned, false),
      eq(user.isSuspended, false),
    ));
  assertAccountDeletionAccessDecision(evaluateAccountDeletionAccess(
    account?.role,
    administratorCountRow?.value ?? 0,
    account?.isBanned === true || account?.isSuspended === true,
  ));
  if (!account) throw new Error(`Account ${userId} no longer exists`);
  const deletedIdentity = await getDeletedIdentity(account.email);
  assertRepeatDeletionCooldownElapsed(deletedIdentity?.latestDeletionAt);
  const [unsettledEarning] = await db
    .select({ id: creatorEarnings.id })
    .from(creatorEarnings)
    .where(
      and(
        eq(creatorEarnings.creatorId, userId),
        sql`${creatorEarnings.status} NOT IN ('completed', 'refunded')`,
      ),
    )
    .limit(1);

  if (unsettledEarning) {
    throw new AccountDeletionBlockedError(
      "PENDING_CREATOR_EARNINGS",
      "Creator earnings are still awaiting settlement. Contact support before deleting this account.",
    );
  }

  const context = await getDeletionContext(userId);

  if (stripe) return;

  if (hasStripeCleanupArtifacts(context)) {
    throw new AccountDeletionBlockedError(
      "BILLING_CLEANUP_UNAVAILABLE",
      "Billing cleanup is temporarily unavailable. Try again later or contact support.",
    );
  }
}

async function cancelExternalSubscriptions(context: DeletionContext): Promise<void> {
  if (context.stripeCustomerId || context.stripeSubscriptionId) {
    if (!stripe) {
      throw new AccountDeletionBlockedError(
        "BILLING_CLEANUP_UNAVAILABLE",
        "Billing cleanup is temporarily unavailable. Try again later or contact support.",
      );
    }

    const subscriptionIds = new Set<string>();
    if (context.stripeSubscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(context.stripeSubscriptionId);
        if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired") {
          subscriptionIds.add(subscription.id);
        }
      } catch (error) {
        if (!isMissingStripeResource(error)) {
          throw new AccountDeletionBlockedError(
            "SUBSCRIPTION_CANCELLATION_FAILED",
            "The active subscription could not be checked. Try again later or contact support.",
          );
        }
      }
    }

    if (context.stripeCustomerId) {
      try {
        const customerSubscriptionIds = await listCancelableStripeSubscriptionIds(
          (startingAfter) => stripe.subscriptions.list({
            customer: context.stripeCustomerId!,
            status: "all",
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          }),
        );
        for (const subscriptionId of customerSubscriptionIds) {
          subscriptionIds.add(subscriptionId);
        }
      } catch (error) {
        if (!isMissingStripeResource(error)) {
          throw new AccountDeletionBlockedError(
            "SUBSCRIPTION_CANCELLATION_FAILED",
            "The active subscription could not be canceled. Try again later or contact support.",
          );
        }
      }
    }

    for (const subscriptionId of subscriptionIds) {
      try {
        // Account deletion ends paid access immediately. This also prevents a
        // subscription webhook from continuing to charge an account with no user.
        await stripe.subscriptions.cancel(subscriptionId);
      } catch (error) {
        if (!isMissingStripeResource(error)) {
          throw new AccountDeletionBlockedError(
            "SUBSCRIPTION_CANCELLATION_FAILED",
            "The active subscription could not be canceled. Try again later or contact support.",
          );
        }
      }
    }

    if (context.stripeCustomerId) {
      try {
        let startingAfter: string | undefined;
        for (;;) {
          const page = await stripe.checkout.sessions.list({
            customer: context.stripeCustomerId,
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });
          for (const checkoutSession of page.data) {
            if (checkoutSession.status === "open") {
              try {
                await stripe.checkout.sessions.expire(checkoutSession.id);
              } catch (error) {
                if (!isMissingStripeResource(error)) throw error;
              }
            } else if (
              checkoutSession.status !== "expired"
              && checkoutSession.payment_status === "unpaid"
              && checkoutSession.metadata?.asyncPaymentStatus !== "failed"
            ) {
              throw new AccountDeletionBlockedError(
                "SUBSCRIPTION_CANCELLATION_FAILED",
                "A payment is still awaiting settlement. Try again after it finishes or contact support.",
              );
            }
          }
          if (!page.has_more || page.data.length === 0) break;
          startingAfter = page.data.at(-1)!.id;
        }
      } catch (error) {
        // A previous final-sweep attempt may already have deleted the Customer.
        // Treat that state as complete so a later idempotent retry can finish.
        if (!isMissingStripeResource(error)) throw error;
      }
    }

  }
}

async function anonymizeExternalBillingIdentity(context: DeletionContext): Promise<void> {
  if (!stripe || !context.stripeCustomerId) return;
  try {
    await stripe.customers.update(context.stripeCustomerId, {
      email: "",
      name: "",
      phone: "",
      metadata: { userId: "" },
    });
  } catch (error) {
    if (!isMissingStripeResource(error)) throw error;
  }
}

async function removeExternalBillingIdentity(context: DeletionContext): Promise<void> {
  if (!stripe) return;

  if (context.stripeCustomerId) {
    try {
      // Removes mutable customer PII while Stripe retains transaction records
      // according to its own compliance obligations.
      await stripe.customers.del(context.stripeCustomerId);
    } catch (error) {
      if (!isMissingStripeResource(error)) {
        throw error;
      }
    }
  }

  if (context.stripeConnectId) {
    await closeStripeConnectAccount(
      context.stripeConnectId,
      (accountId) => stripe.accounts.del(accountId),
    );
  }
}

async function clearDeletedSessionCaches(userId: string, tokens: string[]): Promise<void> {
  if (!redis) return;

  const keys = [
    `ba:rl:active-sessions-${userId}`,
    ...tokens.flatMap((token) => [
      `session-v2:${token}`,
      `session:${token}`,
      `ba:rl:${token}`,
    ]),
  ];

  try {
    await redis.del(...keys);
  } catch (error) {
    throw new Error("Failed to clear deleted session caches", { cause: error });
  }
}

async function clearDeletedVerificationCaches(identifiers: string[]): Promise<void> {
  if (!redis || identifiers.length === 0) return;
  try {
    await redis.del(
      ...identifiers.map((identifier) => `ba:rl:verification:${identifier}`),
    );
  } catch (error) {
    throw new Error("Failed to clear deleted verification caches", { cause: error });
  }
}

async function deleteStoredAssets(keys: string[], prefixes: string[]): Promise<void> {
  if (!isS3Configured()) {
    if (keys.length > 0 || prefixes.length > 0) {
      throw new Error("Asset storage cleanup is not configured");
    }
    return;
  }

  let failures = 0;
  for (let index = 0; index < keys.length; index += 20) {
    const results = await Promise.allSettled(
      keys.slice(index, index + 20).map((key) => deleteObject(key)),
    );
    failures += results.filter((result) => result.status === "rejected").length;
  }

  if (failures > 0) {
    throw new Error(`${failures}/${keys.length} stored assets could not be deleted`);
  }

  let prefixFailures = 0;
  for (let index = 0; index < prefixes.length; index += 5) {
    const results = await Promise.allSettled(
      prefixes.slice(index, index + 5).map((prefix) => deletePrefix(prefix)),
    );
    prefixFailures += results.filter((result) => result.status === "rejected").length;
  }
  if (prefixFailures > 0) {
    throw new Error(`${prefixFailures}/${prefixes.length} asset prefixes could not be deleted`);
  }
}

type CleanupJob = typeof accountDeletionCleanupJobs.$inferSelect;

const PURGE_BUDGET_MS = 2 * 60_000;
const PURGE_CURSOR_TTL_SECONDS = 2 * 24 * 60 * 60;
const localPurgeCursors = new Map<string, string>();
const purgeCursorKey = (jobId: string) => `account-deletion:purge-cursor:${jobId}`;

/** Resume point for the no-index fallback purge. Kept in Redis because the
 * fleet lease can move the runner between replicas from one tick to the next. */
async function loadPurgeCursor(jobId: string): Promise<string | null> {
  if (redis) {
    try {
      return (await redis.get(purgeCursorKey(jobId))) ?? null;
    } catch {
      // fall through to the local copy
    }
  }
  return localPurgeCursors.get(jobId) ?? null;
}

async function savePurgeCursor(jobId: string, cursor: string | null): Promise<void> {
  if (cursor === null) return forgetPurgeCursor(jobId);
  localPurgeCursors.set(jobId, cursor);
  if (redis) await redis.set(purgeCursorKey(jobId), cursor, "EX", PURGE_CURSOR_TTL_SECONDS).catch(() => {});
}

async function forgetPurgeCursor(jobId: string): Promise<void> {
  localPurgeCursors.delete(jobId);
  if (redis) await redis.del(purgeCursorKey(jobId)).catch(() => {});
}

type CleanupJobOutcome = "final" | "pre-final" | "partial";

async function runAccountDeletionCleanupJob(job: CleanupJob): Promise<CleanupJobOutcome> {
  // Freeze the phase at attempt start. A long pre-final pass can cross the
  // deadline, but must not delete the job until an actual final sweep ran.
  const isFinalSweep = Date.now() >= job.finalizeAfter.getTime();
  // Safety net for the post-commit discovery purge (process restart, error).
  // Only on the final sweep. It is the one step that touches a large table, so
  // it runs first and alone, in small individually timed-out batches within a
  // time budget; an unfinished purge resumes on the next tick before any of
  // the external (Stripe/S3/Redis/PostHog) steps are repeated.
  let purgeFailure: unknown = null;
  if (isFinalSweep) {
    try {
      const purge = await purgeErasedDiscoveryEventsBatched(
        db as unknown as BatchedErasureExecutor,
        [`user:${job.deletedUserId}`],
        { budgetMs: PURGE_BUDGET_MS, cursor: await loadPurgeCursor(job.id) },
      );
      if (!purge.done) {
        await savePurgeCursor(job.id, purge.cursor);
        return "partial";
      }
      await forgetPurgeCursor(job.id);
    } catch (error) {
      purgeFailure = error;
    }
  }
  const billingContext: DeletionContext = {
    email: "",
    wasBanned: false,
    wasSuspended: false,
    blockInviteRedemption: false,
    lastCheckinDay: null,
    rewardBlockedUntil: null,
    stripeCustomerId: job.stripeCustomerId,
    stripeSubscriptionId: job.stripeSubscriptionId,
    stripeConnectId: job.stripeConnectId,
    stripePaymentIntentIds: [],
    stripeCheckoutSessionIds: [],
    assetKeys: [],
    assetPrefixes: [],
    sessionTokens: [],
  };
  const redactProcessorMetadata = async () => {
    // Leave metadata available through the presigned/checkouts race window so
    // late webhooks can still reconcile/refund. The mandatory final job run
    // removes user IDs and free text from processor metadata.
    if (!isFinalSweep) return;
    if (!stripe) {
      if (hasStripeCleanupArtifacts({
        stripeCustomerId: job.stripeCustomerId,
        stripeSubscriptionId: job.stripeSubscriptionId,
        stripeConnectId: job.stripeConnectId,
        stripePaymentIntentIds: job.stripePaymentIntentIds,
        stripeCheckoutSessionIds: job.stripeCheckoutSessionIds,
      })) {
        throw new Error("Stripe metadata cleanup is not configured");
      }
      return;
    }

    const paymentIntentIds = new Set(job.stripePaymentIntentIds);
    // One-time compatibility path for tips created before local pending-intent
    // storage existed. Stripe Search is eventually consistent, so the final
    // sweep runs after 70 minutes and looks up both legacy identity fields.
    for (const field of ["senderId", "creatorId"] as const) {
      let pageToken: string | undefined;
      for (;;) {
        const page = await stripe.paymentIntents.search({
          query: `metadata['${field}']:'${job.deletedUserId}'`,
          limit: 100,
          ...(pageToken ? { page: pageToken } : {}),
        });
        for (const paymentIntent of page.data) paymentIntentIds.add(paymentIntent.id);
        if (!page.has_more || !page.next_page) break;
        pageToken = page.next_page;
      }
    }

    for (const paymentIntentId of paymentIntentIds) {
      try {
        await stripe.paymentIntents.update(paymentIntentId, {
          metadata: {
            tipIntentId: "",
            senderId: "",
            creatorId: "",
            worldId: "",
            bundleId: "",
            message: "",
            isAnonymous: "",
          },
        });
      } catch (error) {
        if (!isMissingStripeResource(error)) throw error;
      }
    }
    const customerIds = new Set<string>();
    if (job.stripeCustomerId) customerIds.add(job.stripeCustomerId);
    let customerPageToken: string | undefined;
    for (;;) {
      const page = await stripe.customers.search({
        query: `metadata['userId']:'${job.deletedUserId}'`,
        limit: 100,
        ...(customerPageToken ? { page: customerPageToken } : {}),
      });
      for (const customer of page.data) customerIds.add(customer.id);
      if (!page.has_more || !page.next_page) break;
      customerPageToken = page.next_page;
    }

    const checkoutSessionIds = new Set(job.stripeCheckoutSessionIds);
    for (const customerId of customerIds) {
      try {
        let startingAfter: string | undefined;
        for (;;) {
          const page = await stripe.checkout.sessions.list({
            customer: customerId,
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });
          for (const checkoutSession of page.data) checkoutSessionIds.add(checkoutSession.id);
          if (!page.has_more || page.data.length === 0) break;
          startingAfter = page.data.at(-1)!.id;
        }
      } catch (error) {
        if (!isMissingStripeResource(error)) throw error;
      }
    }
    for (const checkoutSessionId of checkoutSessionIds) {
      try {
        await stripe.checkout.sessions.update(checkoutSessionId, {
          metadata: { userId: "", accountDeleted: "true" },
        });
      } catch (error) {
        if (!isMissingStripeResource(error)) throw error;
      }
    }
    for (const customerId of customerIds) {
      try {
        await stripe.customers.update(customerId, {
          email: "",
          name: "",
          phone: "",
          // Search-only legacy customers must remain discoverable if deletion
          // fails after redaction. The durable stored ID can safely be cleared.
          metadata: {
            userId: customerId === job.stripeCustomerId ? "" : job.deletedUserId,
          },
        });
        await stripe.customers.del(customerId);
      } catch (error) {
        if (!isMissingStripeResource(error)) throw error;
      }
    }

    // Connect account creation uses a deterministic idempotency key, and this
    // final metadata scan catches the rare create-success/DB-failure orphan.
    let connectStartingAfter: string | undefined;
    for (;;) {
      const page = await stripe.accounts.list({
        limit: 100,
        ...(connectStartingAfter ? { starting_after: connectStartingAfter } : {}),
      });
      for (const account of page.data) {
        if (account.metadata?.userId !== job.deletedUserId) continue;
        // Standard/Express accounts reject a platform email edit; that used to
        // fail every final sweep forever (2 jobs, 1,769 attempts by 09-29).
        await redactAndDeleteConnectAccount(account.id, job.deletedUserId, {
          update: (accountId, params) => stripe.accounts.update(accountId, params),
          del: (accountId) => stripe.accounts.del(accountId),
        });
      }
      if (!page.has_more || page.data.length === 0) break;
      connectStartingAfter = page.data.at(-1)!.id;
    }
  };
  const anonymizeAnalyticsIdentity = async () => {
    posthog.identify({
      distinctId: job.deletedUserId,
      properties: {
        username: null,
        name: null,
        email: null,
        language: null,
        role: null,
        accountDeleted: true,
      },
    });
    await posthog.flush();
  };
  const results = await Promise.allSettled([
    clearDeletedSessionCaches(job.deletedUserId, job.sessionTokens),
    clearDeletedVerificationCaches(job.verificationIdentifiers),
    deleteStoredAssets(job.assetKeys, job.assetPrefixes),
    // The analytics rollup has no user FK and can race the transactional
    // delete with a pre-deletion usage_logs snapshot. Re-delete it on every
    // outbox pass, including the mandatory post-presign final sweep.
    db.execute(sql`DELETE FROM daily_user_activity WHERE user_id = ${job.deletedUserId}`),
    // The final-sweep discovery purge already ran above; report its failure here.
    purgeFailure ? Promise.reject(purgeFailure) : Promise.resolve(),
    (async () => {
      await cancelExternalSubscriptions(billingContext);
      await anonymizeExternalBillingIdentity(billingContext);
      if (isFinalSweep) {
        // Checkout Sessions must be listed/redacted before deleting the Stripe
        // Customer; otherwise the list call becomes permanently resource-missing.
        await redactProcessorMetadata();
        await removeExternalBillingIdentity(billingContext);
      }
    })(),
    anonymizeAnalyticsIdentity(),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
  if (failures.length > 0) throw new Error(failures.join("; "));
  return isFinalSweep ? "final" : "pre-final";
}

async function processAccountDeletionCleanupJob(job: CleanupJob): Promise<void> {
  try {
    const outcome = await runAccountDeletionCleanupJob(job);
    if (outcome === "partial") {
      // Progress was made but the bounded purge ran out of its time budget.
      // Not a failure: resume soon without spending an attempt.
      try {
        await db
          .update(accountDeletionCleanupJobs)
          .set({
            nextAttemptAt: new Date(Date.now() + CLEANUP_CONTINUE_DELAY_MS),
            updatedAt: new Date(),
          })
          .where(eq(accountDeletionCleanupJobs.id, job.id));
      } catch (error) {
        console.warn(`[account-deletion] Could not schedule purge continuation for ${job.id}:`, error);
      }
      return;
    }
    if (outcome === "pre-final") {
      try {
        // Presigned PUT URLs remain valid for one hour. Keep the manifest and
        // perform one mandatory final sweep after they (and resize workers)
        // have expired, otherwise an upload could recreate a deleted prefix.
        await db
          .update(accountDeletionCleanupJobs)
          .set({
            lastError: null,
            nextAttemptAt: new Date(Math.max(Date.now(), job.finalizeAfter.getTime())),
            updatedAt: new Date(),
          })
          .where(eq(accountDeletionCleanupJobs.id, job.id));
      } catch (error) {
        console.warn(`[account-deletion] Could not schedule final sweep for ${job.id}:`, error);
      }
      return;
    }
    try {
      await db.delete(accountDeletionCleanupJobs).where(eq(accountDeletionCleanupJobs.id, job.id));
      await forgetPurgeCursor(job.id);
    } catch (error) {
      // Cleanup already succeeded and every operation is idempotent. Leaving
      // the job in place merely causes a safe retry; never turn a committed
      // account deletion into a misleading 500 response.
      console.warn(`[account-deletion] Could not remove completed cleanup job ${job.id}:`, error);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const plan = planCleanupFailure(job.attempts, message);
    try {
      await db
        .update(accountDeletionCleanupJobs)
        .set({
          attempts: plan.attempts,
          lastError: plan.lastError,
          nextAttemptAt: plan.nextAttemptAt,
          updatedAt: new Date(),
        })
        .where(eq(accountDeletionCleanupJobs.id, job.id));
    } catch (updateError) {
      // The claim already pushed next_attempt_at out by CLEANUP_CLAIM_MS, so a
      // lost backoff write delays the retry instead of hot-looping it.
      console.error(`[account-deletion] Could not update cleanup job ${job.id}:`, updateError);
    }
    if (plan.exhausted) {
      // Logged once: the runner never selects a job at the ceiling again.
      console.error(
        `[account-deletion] Cleanup job ${job.id} stopped after ${plan.attempts} attempts and needs attention: ${message}`,
      );
      captureServerError("account-deletion-cleanup-exhausted", error, { job_id: job.id, attempts: plan.attempts });
    } else {
      const minutes = Math.round((plan.nextAttemptAt.getTime() - Date.now()) / 60_000);
      console.warn(`[account-deletion] Cleanup job ${job.id} attempt ${plan.attempts}/${CLEANUP_MAX_ATTEMPTS} failed; retry in ~${minutes} min: ${message}`);
    }
  }
}

/** Claim = push next_attempt_at out before running, conditional on the job
 * still being due. Exactly one caller (a tick on any replica, or the
 * post-commit immediate run) wins; the others get no row and skip it. */
async function claimAccountDeletionCleanupJob(job: CleanupJob): Promise<CleanupJob | null> {
  const now = Date.now();
  const [claimed] = await db
    .update(accountDeletionCleanupJobs)
    .set({ nextAttemptAt: new Date(now + CLEANUP_CLAIM_MS), updatedAt: new Date(now) })
    .where(and(
      eq(accountDeletionCleanupJobs.id, job.id),
      lte(accountDeletionCleanupJobs.nextAttemptAt, new Date(now)),
      lt(accountDeletionCleanupJobs.attempts, CLEANUP_MAX_ATTEMPTS),
    ))
    .returning();
  return claimed ?? null;
}

const tickAccountDeletionCleanup = createCleanupTicker<CleanupJob>({
  lease: redisCleanupLease(redis as unknown as MinimalLeaseRedis | null),
  // The outbox is additive DDL. Avoid querying it during the rolling-deploy
  // window before the background schema heal has completed.
  isBlocked: () => isRogueInstance || !isAccountDeletionSchemaReady(),
  listDue: (limit) => db
    .select()
    .from(accountDeletionCleanupJobs)
    .where(and(
      lte(accountDeletionCleanupJobs.nextAttemptAt, new Date()),
      lt(accountDeletionCleanupJobs.attempts, CLEANUP_MAX_ATTEMPTS),
    ))
    .orderBy(asc(accountDeletionCleanupJobs.nextAttemptAt))
    .limit(limit),
  claim: claimAccountDeletionCleanupJob,
  process: processAccountDeletionCleanupJob,
});

export async function processPendingAccountDeletionCleanupJobs(): Promise<void> {
  await tickAccountDeletionCleanup();
}

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startAccountDeletionCleanupInterval(): void {
  if (cleanupInterval) return;
  void processPendingAccountDeletionCleanupJobs().catch((error) => {
    console.error("[account-deletion] Cleanup outbox failed:", error);
  });
  // Overlapping ticks are no-ops (reentrancy guard + fleet lease), so a slow
  // tick can never stack another copy of the same job behind it.
  cleanupInterval = setInterval(() => {
    void processPendingAccountDeletionCleanupJobs().catch((error) => {
      console.error("[account-deletion] Cleanup outbox failed:", error);
    });
  }, 60_000);
  cleanupInterval.unref();
}

/**
 * Execute the destructive step from Better Auth's beforeDelete hook.
 *
 * Deleting the user here (instead of letting Better Auth first delete sessions
 * and accounts in separate statements) makes the database side one atomic
 * cascading DELETE. If an unexpected FK blocks it, the login credentials stay
 * intact and the user can retry after support fixes the data.
 */
export async function permanentlyDeleteAccount(
  userId: string,
  options?: { verificationIdentifier?: string },
): Promise<void> {
  await assertAccountDeletionAllowed(userId);
  // The linked-guest scan reads the whole discovery_events table. Run it with
  // no locks held; the transaction re-checks only links received since.
  const knownDiscoveryGuests = await findLinkedDiscoveryGuests(db as unknown as Parameters<typeof findLinkedDiscoveryGuests>[0], userId);
  let discoveryActors: string[] = [];
  const result = await db.transaction(async (tx) => {
    // Lock the current account first. FK inserts that target it take a
    // key-share lock and serialize with this final deletion transaction.
    // Administrators are locked (in id order) ONLY when the account being
    // deleted is itself an administrator: that is the one case the "never
    // remove the final active administrator" invariant needs. Locking every
    // admin for an ordinary account made each deletion freeze all admin
    // writes for its full duration, which took Discover down for admins on
    // 2026-09-24 while one user's deletion kept retrying.
    type LockedAccount = { id?: string; role?: string; is_banned?: boolean; is_suspended?: boolean };
    const targetResult = await tx.execute(sql`
      SELECT id, role, is_banned, is_suspended
      FROM "user"
      WHERE id = ${userId}
      FOR UPDATE
    `);
    let lockedAccounts = targetResult.rows as LockedAccount[];
    if (lockedAccounts[0]?.role === "admin") {
      const adminResult = await tx.execute(sql`
        SELECT id, role, is_banned, is_suspended
        FROM "user"
        WHERE id = ${userId} OR role = 'admin'
        ORDER BY id
        FOR UPDATE
      `);
      lockedAccounts = adminResult.rows as LockedAccount[];
    }
    const lockedAccount = lockedAccounts.find((row) => row.id === userId);
    assertAccountDeletionAccessDecision(evaluateAccountDeletionAccess(
      lockedAccount?.role,
      lockedAccounts.filter(
        (account) => account.role === "admin"
          && account.is_banned !== true
          && account.is_suspended !== true,
      ).length,
      lockedAccount?.is_banned === true || lockedAccount?.is_suspended === true,
    ));
    if (!lockedAccount) throw new Error(`Account ${userId} no longer exists`);
    const [unsettledEarning] = await tx
      .select({ id: creatorEarnings.id })
      .from(creatorEarnings)
      .where(
        and(
          eq(creatorEarnings.creatorId, userId),
          sql`${creatorEarnings.status} NOT IN ('completed', 'refunded')`,
        ),
      )
      .limit(1);
    if (unsettledEarning) {
      throw new AccountDeletionBlockedError(
        "PENDING_CREATOR_EARNINGS",
        "Creator earnings are still awaiting settlement. Contact support before deleting this account.",
      );
    }

    const lockedContext = await getDeletionContext(
      userId,
      tx as unknown as QueryExecutor,
    );
    if (!lockedContext.email) {
      throw new Error(`Account ${userId} no longer exists`);
    }

    const identityHash = hashDeletedIdentity(lockedContext.email);
    const identityHashCandidates = hashDeletedIdentityCandidates(lockedContext.email);
    const priorTombstones = await tx
      .select()
      .from(deletedAccountTombstones)
      .where(inArray(deletedAccountTombstones.identityHash, identityHashCandidates));
    const latestPriorDeletionAt = priorTombstones
      .map((record) => record.updatedAt)
      .sort((left, right) => left.getTime() - right.getTime())
      .at(-1) ?? null;
    assertRepeatDeletionCooldownElapsed(latestPriorDeletionAt);

    const verificationIdentifiers = new Set<string>();
    if (options?.verificationIdentifier) {
      const consumed = await tx
        .delete(verification)
        .where(and(
          eq(verification.identifier, options.verificationIdentifier),
          eq(verification.value, userId),
          gt(verification.expiresAt, new Date()),
        ))
        .returning();
      if (consumed.length === 0) throw new InvalidAccountDeletionTokenError();
      for (const row of consumed) verificationIdentifiers.add(row.identifier);
    }

    // Revoke every Better Auth verification capability owned by this identity:
    // password resets, OAuth linking state and any overlapping deletion links.
    const normalizedEmail = lockedContext.email.trim().toLowerCase();
    const compactUserIdNeedle = `%"userId":"${userId}"%`;
    const spacedUserIdNeedle = `%"userId": "${userId}"%`;
    const ownedVerificationRows = await tx
      .select({ id: verification.id, identifier: verification.identifier })
      .from(verification)
      .where(or(
        eq(verification.value, userId),
        sql`lower(${verification.value}) = ${normalizedEmail}`,
        sql`${verification.value} LIKE ${compactUserIdNeedle}`,
        sql`${verification.value} LIKE ${spacedUserIdNeedle}`,
      ));
    for (const row of ownedVerificationRows) {
      verificationIdentifiers.add(row.identifier);
    }

    // Redis can hold the same capabilities. Failure is fail-closed here; the
    // durable cleanup job repeats this purge after commit.
    await clearDeletedVerificationCaches([...verificationIdentifiers]);
    if (ownedVerificationRows.length > 0) {
      await tx
        .delete(verification)
        .where(inArray(verification.id, ownedVerificationRows.map((row) => row.id)));
    }

    // Retain only a keyed, non-reversible identity marker so an immediately
    // recreated account cannot be deleted again during the three-day cooldown
    // or reset bans, invite eligibility, or today's check-in reward. Signup and
    // normal wallet defaults are available immediately after deletion.
    const priorLastCheckinDay = priorTombstones
      .map((record) => record.lastCheckinDay)
      .filter((day): day is string => !!day)
      .sort()
      .at(-1) ?? null;
    const lastCheckinDay = [priorLastCheckinDay, lockedContext.lastCheckinDay]
      .filter((day): day is string => !!day)
      .sort()
      .at(-1) ?? null;
    const rewardBlockedUntil = [
      ...priorTombstones.map((record) => record.rewardBlockedUntil),
      lockedContext.rewardBlockedUntil,
    ]
      .filter((date): date is Date => !!date)
      .sort((left, right) => left.getTime() - right.getTime())
      .at(-1) ?? null;
    const mergedWasBanned = lockedContext.wasBanned
      || priorTombstones.some((record) => record.wasBanned);
    const mergedWasSuspended = lockedContext.wasSuspended
      || priorTombstones.some((record) => record.wasSuspended);
    const claimedMilestones = await tx
      .select({ milestone: referralMilestones.milestone })
      .from(referralMilestones)
      .where(eq(referralMilestones.userId, userId));
    const referralClaims = mergeReferralClaims(
      REFERRAL_REWARD_EPOCH,
      claimedMilestones.map((row) => row.milestone),
      priorTombstones.map((record) => record.referralClaims),
    );
    const mergedBlockInviteRedemption = lockedContext.blockInviteRedemption
      || priorTombstones.some((record) => record.blockInviteRedemption);
    await tx
      .insert(deletedAccountTombstones)
      .values({
        identityHash,
        wasBanned: mergedWasBanned,
        wasSuspended: mergedWasSuspended,
        referralClaims,
        blockWelcomeRewards: true,
        blockInviteRedemption: mergedBlockInviteRedemption,
        lastCheckinDay,
        rewardBlockedUntil,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: deletedAccountTombstones.identityHash,
        set: {
          wasBanned: sql`${deletedAccountTombstones.wasBanned} OR ${mergedWasBanned}`,
          wasSuspended: sql`${deletedAccountTombstones.wasSuspended} OR ${mergedWasSuspended}`,
          referralClaims,
          blockWelcomeRewards: true,
          blockInviteRedemption: sql`${deletedAccountTombstones.blockInviteRedemption} OR ${mergedBlockInviteRedemption}`,
          lastCheckinDay: lastCheckinDay
            ? sql`GREATEST(COALESCE(${deletedAccountTombstones.lastCheckinDay}, ''), ${lastCheckinDay})`
            : deletedAccountTombstones.lastCheckinDay,
          rewardBlockedUntil: rewardBlockedUntil
            ? sql`GREATEST(COALESCE(${deletedAccountTombstones.rewardBlockedUntil}, ${rewardBlockedUntil}), ${rewardBlockedUntil})`
            : deletedAccountTombstones.rewardBlockedUntil,
          updatedAt: new Date(),
        },
      });
    const legacyIdentityHashes = identityHashCandidates.filter((hash) => hash !== identityHash);
    if (legacyIdentityHashes.length > 0) {
      await tx
        .delete(deletedAccountTombstones)
        .where(inArray(deletedAccountTombstones.identityHash, legacyIdentityHashes));
    }

    // Administrative audit rows are retained, but a deleted administrator or
    // target is represented by the keyed tombstone identity instead of the
    // live user ID. Having audit history therefore never blocks self-deletion.
    const deletedAuditIdentity = `deleted:${identityHash}`;
    await anonymizeDeletedAccountAudit(
      tx as unknown as Parameters<typeof anonymizeDeletedAccountAudit>[0],
      userId,
      deletedAuditIdentity,
    );

    // Ledger amounts and processor references are retained, but free-text
    // messages and sender/recipient descriptions are not accounting data and
    // could identify the deleted person.
    await tx
      .update(tipPaymentIntents)
      .set({ message: null, isAnonymous: true, updatedAt: new Date() })
      .where(or(
        eq(tipPaymentIntents.creatorId, userId),
        eq(tipPaymentIntents.senderId, userId),
      ));
    // Notification actor IDs are backfilled before account deletion becomes
    // available and indexed by a CASCADE FK. The user DELETE below therefore
    // removes every surviving recipient's actor snapshot without a hot-table
    // JSON/text scan while this transaction holds the user-row lock.

    const affectedGifts = await tx
      .select({ id: mushieGifts.id })
      .from(mushieGifts)
      .where(
        or(
          eq(mushieGifts.senderId, userId),
          eq(mushieGifts.recipientId, userId),
        ),
      );
    await tx
      .update(mushieGifts)
      .set({
        message: null,
        isAnonymous: true,
        idempotencyKey: sql`'deleted:' || ${mushieGifts.id}`,
      })
      .where(
        or(
          eq(mushieGifts.senderId, userId),
          eq(mushieGifts.recipientId, userId),
        ),
      );
    await tx
      .update(creatorEarnings)
      .set({ message: null, isAnonymous: true })
      .where(
        or(
          eq(creatorEarnings.creatorId, userId),
          eq(creatorEarnings.senderId, userId),
        ),
      );
    await tx
      .update(threadRewards)
      .set({ reason: "Reward issued to a deleted account" })
      .where(eq(threadRewards.recipientId, userId));
    if (affectedGifts.length > 0) {
      await tx
        .update(creditTransactions)
        .set({ description: "Mushie gift involving a deleted account" })
        .where(inArray(creditTransactions.referenceId, affectedGifts.map((gift) => gift.id)));
    }

    // Cascades remove the user's reactions and authored content, but the
    // denormalized counters on their surviving parents are not trigger-backed.
    // Capture those parents in a transaction-local table before the DELETE.
    await tx.execute(sql`
      CREATE TEMP TABLE account_deletion_affected (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      ) ON COMMIT DROP
    `);
    await tx.execute(sql`
      INSERT INTO account_deletion_affected (kind, id)
      SELECT 'world', world_id FROM favorites WHERE user_id = ${userId}
      UNION SELECT 'world', world_id FROM reviews WHERE user_id = ${userId}
      UNION SELECT 'world', world_id FROM world_ratings WHERE user_id = ${userId}
      UNION SELECT 'review', review_id FROM review_replies WHERE user_id = ${userId}
      UNION SELECT 'bundle', bundle_id FROM bundle_likes WHERE user_id = ${userId}
      UNION SELECT 'bundle_review', review_id FROM bundle_review_replies WHERE user_id = ${userId}
      UNION SELECT 'thread', thread_id FROM thread_likes WHERE user_id = ${userId}
      UNION SELECT 'thread', thread_id FROM posts WHERE author_id = ${userId}
      UNION SELECT 'post', post_id FROM post_likes WHERE user_id = ${userId}
      UNION SELECT 'poll_option', option_id FROM poll_votes WHERE user_id = ${userId}
      UNION SELECT 'playthrough', playthrough_id FROM shared_playthrough_likes WHERE user_id = ${userId}
      UNION SELECT 'extension', extension_key FROM extension_reviews WHERE user_id = ${userId}
      UNION SELECT 'extension', extension_key FROM extension_ratings WHERE user_id = ${userId}
      ON CONFLICT DO NOTHING
    `);

    // Translation cache is polymorphic and therefore has no FK to cascade.
    // Capture the exact source keys so both the initial cleanup and the
    // post-cascade race closure stay index-bounded.
    await tx.execute(sql`
      CREATE TEMP TABLE account_deletion_translation_sources (
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        PRIMARY KEY (source_type, source_id)
      ) ON COMMIT DROP
    `);
    await tx.execute(sql`
      INSERT INTO account_deletion_translation_sources (source_type, source_id)
      SELECT 'thread', source.id FROM threads source WHERE source.author_id = ${userId}
      UNION SELECT 'post', source.id
        FROM posts source
        JOIN threads parent_thread ON parent_thread.id = source.thread_id
        WHERE source.author_id = ${userId} OR parent_thread.author_id = ${userId}
      UNION SELECT 'review', source.id
        FROM reviews source
        JOIN worlds parent_world ON parent_world.id = source.world_id
        WHERE source.user_id = ${userId} OR parent_world.creator_id = ${userId}
      UNION SELECT 'review_reply', source.id
        FROM review_replies source
        JOIN reviews parent_review ON parent_review.id = source.review_id
        JOIN worlds parent_world ON parent_world.id = parent_review.world_id
        WHERE source.user_id = ${userId}
          OR parent_review.user_id = ${userId}
          OR parent_world.creator_id = ${userId}
      ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      DELETE FROM content_translations translation
      USING account_deletion_translation_sources source
      WHERE translation.source_type = source.source_type
        AND translation.source_id = source.source_id
    `);

    // Posts use snapshot IDs instead of self-FKs. Promote surviving replies
    // whose root is being deleted, and remove snapshots of the deleted author,
    // so they remain visible without retaining a dangling name/id reference.
    await tx.execute(sql`
      UPDATE posts survivor
      SET parent_id = NULL
      WHERE survivor.author_id <> ${userId}
        AND survivor.parent_id IN (SELECT id FROM posts WHERE author_id = ${userId})
    `);
    await tx.execute(sql`
      UPDATE posts survivor
      SET
        reply_to_id = NULL,
        reply_to_author_name = NULL,
        reply_to_floor = NULL
      WHERE survivor.author_id <> ${userId}
        AND survivor.reply_to_id IN (SELECT id FROM posts WHERE author_id = ${userId})
    `);

    // Recommendation history stores denormalized world names and image URLs.
    // Its world FK now cascades too, but deleting snapshots explicitly here
    // documents the privacy boundary and cleans them before the creator row.
    await tx.execute(sql`
      DELETE FROM world_click_history history
      USING worlds owned
      WHERE history.world_id = owned.id
        AND owned.creator_id = ${userId}
    `);

    // This analytics rollup deliberately has no FK (to avoid deploy-time locks),
    // so it must be explicitly forgotten during account deletion.
    await tx.execute(sql`DELETE FROM daily_user_activity WHERE user_id = ${userId}`);

    // Do not acknowledge account deletion while any renewable subscription is
    // still active. The durable outbox repeats this idempotently after commit.
    await cancelExternalSubscriptions(lockedContext);

    // Canonical discovery has no user FK. Record durable actor/cutoff erasures
    // before removing its events, even if measurement collection is now off.
    // The tombstones hide the events from every reader at commit; the physical
    // delete (a full table scan) runs after commit so it holds no account lock.
    discoveryActors = await eraseDiscoveryAccountData(tx, userId, undefined, {
      knownGuests: knownDiscoveryGuests, deferEventDelete: true,
    });

    // The FK clears referred_by on surviving invitees. Retain only the
    // invitee's one-time redemption marker before that happens.
    await tx.execute(sql`
      INSERT INTO referral_redemptions (invitee_id, redeemed_at)
      SELECT id, COALESCE(referred_at, created_at)
      FROM "user"
      WHERE referred_by = ${userId}
      ON CONFLICT (invitee_id) DO NOTHING
    `);
    // Qualifications intentionally have no user FK. A deleted referrer has
    // no future reward to settle, so remove rows that retain their user ID.
    await tx.execute(sql`DELETE FROM referral_qualifications WHERE referrer_id = ${userId}`);

    const deleted = await tx
      .delete(user)
      .where(eq(user.id, userId))
      .returning();
    if (deleted.length === 0) {
      throw new Error(`Account ${userId} no longer exists`);
    }
    await invalidateSessionUser(userId);

    // The reply self-FK and its BEFORE UPDATE trigger clear target/name/floor
    // snapshots for concurrent inserts. Close the translation worker race by
    // deleting only the captured source keys a second time after cascades.
    await tx.execute(sql`
      DELETE FROM content_translations translation
      USING account_deletion_translation_sources source
      WHERE translation.source_type = source.source_type
        AND translation.source_id = source.source_id
    `);

    await tx.execute(sql`
      UPDATE worlds parent SET
        favorite_count = (SELECT count(*)::int FROM favorites row WHERE row.world_id = parent.id),
        review_count = (SELECT count(*)::int FROM world_ratings row WHERE row.world_id = parent.id),
        average_rating = (SELECT COALESCE(AVG(row.rating), 0)::real FROM world_ratings row WHERE row.world_id = parent.id)
      WHERE parent.id IN (SELECT id FROM account_deletion_affected WHERE kind = 'world')
    `);
    await tx.execute(sql`
      UPDATE reviews parent SET
        reply_count = (SELECT count(*)::int FROM review_replies row WHERE row.review_id = parent.id)
      WHERE parent.id IN (SELECT id FROM account_deletion_affected WHERE kind = 'review')
    `);
    await tx.execute(sql`
      UPDATE bundles parent SET
        like_count = (SELECT count(*)::int FROM bundle_likes row WHERE row.bundle_id = parent.id)
      WHERE parent.id IN (SELECT id FROM account_deletion_affected WHERE kind = 'bundle')
    `);
    await tx.execute(sql`
      UPDATE bundle_reviews parent SET
        reply_count = (SELECT count(*)::int FROM bundle_review_replies row WHERE row.review_id = parent.id)
      WHERE parent.id IN (SELECT id FROM account_deletion_affected WHERE kind = 'bundle_review')
    `);
    await tx.execute(sql`
      UPDATE threads parent SET
        reply_count = (SELECT count(*)::int FROM posts row WHERE row.thread_id = parent.id),
        like_count = (SELECT count(*)::int FROM thread_likes row WHERE row.thread_id = parent.id),
        last_reply_at = COALESCE(
          (SELECT row.created_at FROM posts row WHERE row.thread_id = parent.id ORDER BY row.created_at DESC, row.id DESC LIMIT 1),
          parent.created_at
        ),
        last_reply_user_id = COALESCE(
          (SELECT row.author_id FROM posts row WHERE row.thread_id = parent.id ORDER BY row.created_at DESC, row.id DESC LIMIT 1),
          parent.author_id
        )
      WHERE parent.id IN (SELECT id FROM account_deletion_affected WHERE kind = 'thread')
    `);
    await tx.execute(sql`
      UPDATE posts parent SET
        like_count = (SELECT count(*)::int FROM post_likes row WHERE row.post_id = parent.id)
      WHERE parent.id IN (SELECT id FROM account_deletion_affected WHERE kind = 'post')
    `);
    await tx.execute(sql`
      UPDATE poll_options parent SET
        vote_count = (SELECT count(*)::int FROM poll_votes row WHERE row.option_id = parent.id)
      WHERE parent.id IN (SELECT id FROM account_deletion_affected WHERE kind = 'poll_option')
    `);
    await tx.execute(sql`
      UPDATE shared_playthroughs parent SET
        like_count = (SELECT count(*)::int FROM shared_playthrough_likes row WHERE row.playthrough_id = parent.id)
      WHERE parent.id IN (SELECT id FROM account_deletion_affected WHERE kind = 'playthrough')
    `);
    await tx.execute(sql`
      INSERT INTO extension_stats (extension_key, review_count, average_rating, updated_at)
      SELECT
        affected.id,
        (SELECT count(*)::int FROM extension_ratings row WHERE row.extension_key = affected.id),
        (SELECT COALESCE(AVG(row.rating), 0)::real FROM extension_ratings row WHERE row.extension_key = affected.id),
        NOW()
      FROM account_deletion_affected affected
      WHERE affected.kind = 'extension'
      ON CONFLICT (extension_key) DO UPDATE SET
        review_count = EXCLUDED.review_count,
        average_rating = EXCLUDED.average_rating,
        updated_at = NOW()
    `);

    const [cleanupJob] = await tx
      .insert(accountDeletionCleanupJobs)
      .values({
        deletedUserId: userId,
        stripeCustomerId: lockedContext.stripeCustomerId,
        stripeSubscriptionId: lockedContext.stripeSubscriptionId,
        stripeConnectId: lockedContext.stripeConnectId,
        stripePaymentIntentIds: lockedContext.stripePaymentIntentIds,
        stripeCheckoutSessionIds: lockedContext.stripeCheckoutSessionIds,
        assetKeys: lockedContext.assetKeys,
        assetPrefixes: lockedContext.assetPrefixes,
        sessionTokens: lockedContext.sessionTokens,
        verificationIdentifiers: [...verificationIdentifiers],
        finalizeAfter: new Date(Date.now() + 70 * 60_000),
      })
      .returning();
    if (!cleanupJob) throw new Error("Failed to queue external account cleanup");

    return { context: lockedContext, cleanupJob };
  });

  void purgeErasedDiscoveryEvents(db as unknown as Parameters<typeof purgeErasedDiscoveryEvents>[0], discoveryActors).catch((error) => {
    // Tombstones already hide these rows; the outbox's final sweep retries.
    console.error(`[account-deletion] Discovery event purge for ${userId} failed:`, error);
  });

  // Attempt immediately for fast erasure. Any transient failure is durably
  // retained in the outbox and retried by every server process until success.
  void (async () => {
    // Claim first: an interval tick on any replica may have picked it up too.
    const claimed = await claimAccountDeletionCleanupJob(result.cleanupJob);
    if (claimed) await processAccountDeletionCleanupJob(claimed);
  })().catch((error) => {
    // Defensive: the processor handles and records its own failures, but no
    // post-commit exception may change the successful deletion response.
    console.error(`[account-deletion] Immediate cleanup job ${result.cleanupJob.id} failed:`, error);
  });
}
