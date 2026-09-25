// ─── Plan changes for card subscribers (in-app flow, owner decision 2026-09-17) ──
//
// The rule:
//   UPGRADE   — charge a full month of the new plan today, keep every mushie the
//               user holds, restart the billing month today. Stripe: change the
//               item price with `billing_cycle_anchor: "now"` and
//               `proration_behavior: "none"`; in flexible billing mode that
//               invoices the full new period immediately and credits nothing for
//               the old plan's unused days. No time credit on purpose: mushies
//               are delivered up front, so a day credit plus the kept balance
//               would pay the user twice. On a version-2 wallet the drops of the
//               plan being left that have not landed yet are paid out first
//               (they were bought with the old month's price), then the new
//               plan's drops run from today.
//   DOWNGRADE — switch the Stripe price with no proration (no invoice, no
//               credit); the wallet keeps the higher plan until the renewal
//               (pendingPlan), where the renewal invoice applies it.
//
// Why: the Customer-Portal path prorated the charge and the grant, which (a)
// nobody understood, (b) handed upgraders ~60% more mushies per dollar than the
// plan itself, and (c) on version-2 wallets re-armed the cycle's later drops at
// the new plan's size for a few dollars. A full month per grant closes every
// ladder by construction.
//
// Pure decisions live here so they are unit-testable without Stripe; the
// orchestrators take an injected Stripe-like client for the same reason
// (scripts/test-local.mjs blocks outbound HTTP).

import type Stripe from "stripe";
import { PLANS, planMeetsMinimum, STRIPE_PLAN_TO_PRICE, STRIPE_PRICE_TO_PLAN, type PlanId } from "./plan-config.js";
import { CURRENT_DROP_SCHEDULE, PLANS_V2, dropsFor, type DropScheduleKey } from "./plan-config-v2.js";
import {
  ensureWallet,
  refreshMonthlyCredits,
  setPendingPlan,
  setSubscriptionCancelAt,
  setSubscriptionSource,
  syncPlan,
  type CreditWallet,
} from "./credit-service.js";
import { dropCycleFor } from "./plan-drops.js";

// ─── Feature flag ───────────────────────────────────────────────────────

/** Server env `PLAN_CHANGE_IN_APP=1`: the plans page changes plans through our endpoints instead of the Stripe portal. */
export function planChangeInAppEnabled(): boolean {
  const raw = (process.env.PLAN_CHANGE_IN_APP ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

// ─── Pure decisions ─────────────────────────────────────────────────────

/** Plans a card subscription can move between. Free has no subscription; internal is never sold. */
export const CARD_PLANS: readonly PlanId[] = ["go", "plus", "pro", "ultra"];

export type PlanChangeDirection = "upgrade" | "downgrade" | "same" | "invalid";

export function classifyPlanChange(currentPlan: string, targetPlan: string): PlanChangeDirection {
  if (!CARD_PLANS.includes(targetPlan as PlanId) || !CARD_PLANS.includes(currentPlan as PlanId)) return "invalid";
  if (targetPlan === currentPlan) return "same";
  return planMeetsMinimum(targetPlan as PlanId, currentPlan as PlanId) ? "upgrade" : "downgrade";
}

export interface SubscriptionItemLike {
  id: string;
  price: { id: string; currency?: string };
  current_period_start: number;
  current_period_end: number;
}

export interface InvoiceLineLike {
  period: { start: number; end: number };
  parent?: { subscription_item_details?: { proration?: boolean | null } | null } | null;
  /** Legacy (pre-basil) line shape. */
  proration?: boolean | null;
}

export interface InvoiceLike {
  id: string;
  status: string | null;
  billing_reason?: string | null;
  hosted_invoice_url?: string | null;
  amount_due?: number;
  lines: { data: InvoiceLineLike[] };
  confirmation_secret?: { client_secret: string } | null;
}

export interface SubscriptionLike {
  id: string;
  status: string;
  collection_method: string;
  customer: string | { id: string };
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
  pending_update?: { expires_at: number } | null;
  latest_invoice?: string | InvoiceLike | null;
  metadata?: Record<string, string> | null;
  items: { data: SubscriptionItemLike[] };
}

export type EligibilityFailure = "not_active" | "send_invoice" | "no_item" | "plan_drift" | "comp";

export type Eligibility =
  | { ok: true; item: SubscriptionItemLike; stripePlan: PlanId }
  | { ok: false; reason: EligibilityFailure };

/**
 * Can this subscription be changed from the app right now?
 * - comp wallets never: the sponsor pays, and an upgrade would resume billing.
 * - only `active` (past_due/unpaid/incomplete mint nothing — PR #85 policy).
 * - only card (`charge_automatically`); legacy WeChat subs are `send_invoice`.
 * - the Stripe price must be the wallet's plan or its scheduled downgrade; any
 *   other drift is resolved by hand, never by charging a month against it.
 */
export function subscriptionEligibility(
  sub: Pick<SubscriptionLike, "status" | "collection_method" | "items">,
  wallet: { plan: string; pendingPlan: string | null; subscriptionSource: string | null },
): Eligibility {
  if (wallet.subscriptionSource === "comp") return { ok: false, reason: "comp" };
  if (sub.status !== "active") return { ok: false, reason: "not_active" };
  if (sub.collection_method !== "charge_automatically") return { ok: false, reason: "send_invoice" };
  const item = sub.items.data[0];
  if (!item) return { ok: false, reason: "no_item" };
  const stripePlan = STRIPE_PRICE_TO_PLAN[item.price.id];
  if (!stripePlan) return { ok: false, reason: "plan_drift" };
  if (stripePlan !== wallet.plan && stripePlan !== wallet.pendingPlan) return { ok: false, reason: "plan_drift" };
  return { ok: true, item, stripePlan };
}

/**
 * Marker written to the subscription's metadata in the same update that
 * restarts the cycle. Deterministic within a minute so a Stripe idempotent
 * replay sends identical parameters; the minute is what the webhook compares
 * against the new period start.
 */
export function planChangeMarker(plan: PlanId, prevInvoiceId: string, at: Date): string {
  return `${plan}:${prevInvoiceId}:${Math.floor(at.getTime() / 60_000)}`;
}

export function planChangeIdempotencyKey(userId: string, plan: PlanId, prevInvoiceId: string, at: Date): string {
  return `plan-change:${userId}:${plan}:${prevInvoiceId}:${Math.floor(at.getTime() / 60_000)}`;
}

/** Does the subscription carry our marker for `plan`, written within a few minutes of the item's current period start? */
export function markerMatches(
  sub: Pick<SubscriptionLike, "metadata">,
  item: Pick<SubscriptionItemLike, "current_period_start">,
  plan: PlanId,
): boolean {
  const marker = sub.metadata?.yumina_plan_change;
  if (!marker) return false;
  const parts = marker.split(":");
  if (parts.length !== 3 || parts[0] !== plan) return false;
  const minute = Number(parts[2]);
  if (!Number.isFinite(minute)) return false;
  return Math.abs(item.current_period_start - minute * 60) <= 180;
}

/**
 * Is this the paid invoice of a cycle-reset upgrade, as opposed to a proration
 * invoice (portal/dashboard change) or a renewal? Structural: PAID, exactly one
 * line, not a proration, and the line covers exactly the item's current period
 * — plus either Stripe's `subscription_update` reason or our own marker.
 *
 * A dashboard price change with no proration creates no invoice at all, so the
 * latest invoice is the previous renewal (`subscription_cycle`, no marker) and
 * is correctly rejected; the legacy prorated rule handles that path.
 */
export function isCycleResetInvoice(
  invoice: InvoiceLike,
  item: SubscriptionItemLike,
  sub?: Pick<SubscriptionLike, "metadata">,
  plan?: PlanId,
): boolean {
  if (invoice.status !== "paid") return false;
  const lines = invoice.lines?.data ?? [];
  if (lines.length !== 1) return false;
  const line = lines[0]!;
  const proration = line.parent?.subscription_item_details?.proration ?? line.proration ?? false;
  if (proration) return false;
  if (line.period.start !== item.current_period_start || line.period.end !== item.current_period_end) return false;
  if (invoice.billing_reason === "subscription_update") return true;
  return !!(sub && plan && markerMatches(sub, item, plan));
}

/**
 * May a paid invoice reset the wallet to a fresh month? Only a renewal or the
 * very first invoice, and only when it opens a period the wallet has not seen.
 * A `subscription_update` invoice (a plan change) never does — the change
 * handlers own it, and a reset there would wipe the kept balance and the grant.
 */
export function shouldRefreshOnInvoicePaid(
  invoice: { billing_reason?: string | null; lines: { data: Array<{ period: { end: number } }> } },
  wallet: { periodEnd: Date },
): boolean {
  const reason = invoice.billing_reason ?? null;
  if (reason !== "subscription_cycle" && reason !== "subscription_create") return false;
  const end = invoice.lines.data[0]?.period.end;
  if (!end) return false;
  return end * 1000 > wallet.periodEnd.getTime();
}

export interface UpgradeMushiePreview {
  /** Mushies the user keeps (their whole current balance). */
  keep: number;
  /** v2 only: drops of the current plan not yet landed, paid at upgrade. */
  settledDrops: Array<{ index: number; amount: number }>;
  /** Granted the moment the payment succeeds (v1: the month; v2: drop 1). */
  grantNow: number;
  /** v2 only: the new plan's later drops, dated from today. */
  laterDrops: Array<{ amount: number; at: string }>;
  newMonthlyCredits: number;
  /** Balance right after the upgrade. */
  total: number;
}

export function upgradeMushiePreview(
  wallet: { plan: string; planVersion: number; balance: number },
  dropsReleased: number,
  targetPlan: PlanId,
  now: Date,
  /** Schedule the wallet's CURRENT cycle opened under (wallet_plan_drops.schedule); the new plan always starts on the current one. */
  leavingSchedule: DropScheduleKey = CURRENT_DROP_SCHEDULE,
): UpgradeMushiePreview {
  const keep = Math.floor(wallet.balance);
  if (wallet.planVersion !== 2) {
    const grantNow = PLANS[targetPlan].monthlyCredits;
    return { keep, settledDrops: [], grantNow, laterDrops: [], newMonthlyCredits: grantNow, total: keep + grantNow };
  }
  const leaving = dropsFor(wallet.plan, leavingSchedule);
  const released = Math.max(1, dropsReleased);
  const settledDrops = leaving.slice(released).map((d, i) => ({ index: released + i, amount: d.amount }));
  const next = PLANS_V2[targetPlan];
  const grantNow = next.drops[0]?.amount ?? 0;
  const laterDrops = next.drops.slice(1).map((d) => ({
    amount: d.amount,
    at: new Date(now.getTime() + d.day * 86_400_000).toISOString(),
  }));
  const total = keep + settledDrops.reduce((s, d) => s + d.amount, 0) + grantNow;
  return { keep, settledDrops, grantNow, laterDrops, newMonthlyCredits: next.monthlyCredits, total };
}

// ─── Shared appliers ────────────────────────────────────────────────────

/**
 * Book a PAID cycle-reset upgrade: full grant, kept balance, new Stripe period,
 * v2 settlement of the old drops. Idempotent on `referenceId` (the Stripe
 * invoice id), so the endpoint, `finalize`, both webhooks and the status-page
 * drift heal can all call it for the same invoice and exactly one grant lands.
 */
export async function applyPaidUpgrade(
  userId: string,
  plan: PlanId,
  opts: { periodStart: Date; periodEnd: Date; referenceId: string },
): Promise<CreditWallet> {
  const wallet = await syncPlan(userId, plan, {
    additive: true,
    cycleReset: true,
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    referenceId: opts.referenceId,
    source: "stripe",
  });
  await setSubscriptionSource(userId, "stripe");
  await setSubscriptionCancelAt(userId, null);
  return wallet;
}

// ─── Orchestrators (Stripe injected) ────────────────────────────────────

export interface StripeLike {
  subscriptions: {
    retrieve(id: string, params?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription>;
    update(id: string, params?: Stripe.SubscriptionUpdateParams, options?: Stripe.RequestOptions): Promise<Stripe.Subscription>;
  };
  invoices: {
    createPreview(params: Stripe.InvoiceCreatePreviewParams): Promise<Stripe.Invoice>;
    voidInvoice(id: string): Promise<Stripe.Invoice>;
  };
}

export interface PlanChangeDeps {
  stripe: StripeLike;
  /** The user's live subscription id (self-healing resolver in routes/stripe.ts), or null. */
  resolveSubscription: (userId: string) => Promise<{ subId: string } | null>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type PlanChangeErrorCode =
  | "invalid_plan"
  | "same_plan"
  | "no_subscription"
  | "wallet_stale"
  | EligibilityFailure;

export interface PlanChangeError {
  status: "error";
  code: PlanChangeErrorCode;
  httpStatus: 400 | 409;
  message: string;
}

export type PlanChangeResult =
  | { status: "applied"; plan: PlanId; balance: number; periodEnd: string }
  | { status: "scheduled"; plan: PlanId; effectiveAt: string }
  | {
      status: "requires_action";
      invoiceId: string | null;
      clientSecret: string | null;
      hostedInvoiceUrl: string | null;
      expiresAt: string | null;
      amountDueCents: number | null;
    }
  | { status: "pending" }
  | PlanChangeError;

export type PlanChangePreview =
  | {
      status: "ok";
      direction: "upgrade";
      currentPlan: PlanId;
      plan: PlanId;
      amountDueCents: number;
      currency: string;
      renewsAt: string | null;
      cancelPending: boolean;
      mushies: UpgradeMushiePreview;
    }
  | {
      status: "ok";
      direction: "downgrade";
      currentPlan: PlanId;
      plan: PlanId;
      effectiveAt: string;
      newPriceCents: number;
      currency: string;
    }
  | PlanChangeError;

const ERROR_MESSAGES: Record<PlanChangeErrorCode, string> = {
  invalid_plan: "That plan cannot be selected here.",
  same_plan: "You are already on this plan.",
  no_subscription: "No active card subscription was found.",
  wallet_stale: "Your last renewal is still settling. Try again in a moment.",
  not_active: "Your subscription has an unpaid invoice. Update your payment method first.",
  send_invoice: "This subscription is billed manually and cannot be changed here.",
  no_item: "The subscription has no price to change.",
  plan_drift: "Your subscription does not match your plan. Contact support.",
  comp: "Sponsored memberships are managed by the team.",
};

function fail(code: PlanChangeErrorCode, httpStatus: 400 | 409 = 409): PlanChangeError {
  return { status: "error", code, httpStatus, message: ERROR_MESSAGES[code] };
}

function expandedInvoice(sub: Stripe.Subscription): Stripe.Invoice | null {
  const inv = sub.latest_invoice;
  return inv && typeof inv !== "string" ? inv : null;
}

function invoiceIdOf(sub: Stripe.Subscription): string | null {
  const inv = sub.latest_invoice;
  if (!inv) return null;
  return typeof inv === "string" ? inv : inv.id;
}

function customerIdOf(sub: Stripe.Subscription): string {
  return typeof sub.customer === "string" ? sub.customer : sub.customer.id;
}

function itemPeriod(item: Stripe.SubscriptionItem): { periodStart: Date; periodEnd: Date } {
  return {
    periodStart: new Date(item.current_period_start * 1000),
    periodEnd: new Date(item.current_period_end * 1000),
  };
}

function applied(wallet: CreditWallet): PlanChangeResult {
  return { status: "applied", plan: wallet.plan, balance: Math.floor(wallet.balance), periodEnd: wallet.periodEnd.toISOString() };
}

/** Exact numbers for the confirmation dialog. Reads only; never touches Stripe state. */
export async function previewPlanChange(deps: PlanChangeDeps, userId: string, targetPlanRaw: string): Promise<PlanChangePreview> {
  const now = deps.now?.() ?? new Date();
  const wallet = await ensureWallet(userId);
  const direction = classifyPlanChange(wallet.plan, targetPlanRaw);
  if (direction === "invalid") return fail("invalid_plan", 400);
  if (direction === "same") return fail("same_plan", 400);
  const targetPlan = targetPlanRaw as PlanId;

  const resolved = await deps.resolveSubscription(userId);
  if (!resolved) return fail("no_subscription");
  const sub = await deps.stripe.subscriptions.retrieve(resolved.subId, { expand: ["latest_invoice"] });
  const eligibility = subscriptionEligibility(sub, wallet);
  if (!eligibility.ok) return fail(eligibility.reason);
  const { item } = eligibility;

  if (direction === "downgrade") {
    return {
      status: "ok",
      direction,
      currentPlan: wallet.plan,
      plan: targetPlan,
      effectiveAt: new Date(item.current_period_end * 1000).toISOString(),
      newPriceCents: PLANS[targetPlan].priceCents,
      currency: item.price.currency ?? "usd",
    };
  }

  const preview = await deps.stripe.invoices.createPreview({
    customer: customerIdOf(sub),
    subscription: sub.id,
    subscription_details: {
      items: [{ id: item.id, price: STRIPE_PLAN_TO_PRICE[targetPlan]! }],
      billing_cycle_anchor: "now",
      proration_behavior: "none",
    },
  });
  const fullLine = preview.lines.data.find((l) => !l.parent?.subscription_item_details?.proration) ?? preview.lines.data[0];
  const cycle = wallet.planVersion === 2 ? await dropCycleFor(wallet) : null;
  return {
    status: "ok",
    direction,
    currentPlan: wallet.plan,
    plan: targetPlan,
    amountDueCents: preview.amount_due,
    currency: preview.currency,
    renewsAt: fullLine ? new Date(fullLine.period.end * 1000).toISOString() : null,
    cancelPending: !!(sub.cancel_at || sub.cancel_at_period_end),
    mushies: upgradeMushiePreview(wallet, cycle?.released ?? 0, targetPlan, now, cycle?.schedule),
  };
}

/**
 * Change the plan. Upgrades charge now and, when the charge succeeds, book the
 * grant synchronously (the webhooks are idempotent backups). Downgrades switch
 * the Stripe price with no proration and schedule the wallet change.
 */
export async function executePlanChange(deps: PlanChangeDeps, userId: string, targetPlanRaw: string): Promise<PlanChangeResult> {
  const now = deps.now?.() ?? new Date();
  const wallet = await ensureWallet(userId);
  const direction = classifyPlanChange(wallet.plan, targetPlanRaw);
  if (direction === "invalid") return fail("invalid_plan", 400);
  if (direction === "same") return fail("same_plan", 400);
  const targetPlan = targetPlanRaw as PlanId;

  // Sponsored wallets are managed by the team: never charge or un-comp them.
  if (wallet.subscriptionSource === "comp") return fail("comp");

  const resolved = await deps.resolveSubscription(userId);
  if (!resolved) return fail("no_subscription");
  let sub = await deps.stripe.subscriptions.retrieve(resolved.subId, { expand: ["latest_invoice"] });
  const item = sub.items.data[0];
  if (!item) return fail("no_item");
  const stripePlan = STRIPE_PRICE_TO_PLAN[item.price.id];

  // Recovery: Stripe already moved to the target (a lost response, or a webhook
  // still in flight). Never restart the cycle again — that bills another month.
  if (direction === "upgrade" && stripePlan === targetPlan) {
    const inv = expandedInvoice(sub);
    if (inv && isCycleResetInvoice(inv, item, sub, targetPlan)) {
      return applied(await applyPaidUpgrade(userId, targetPlan, { ...itemPeriod(item), referenceId: inv.id }));
    }
    return fail("plan_drift");
  }

  const eligibility = subscriptionEligibility(sub, wallet);
  if (!eligibility.ok) return fail(eligibility.reason);

  // A wallet whose period has lapsed is waiting on a renewal webhook. Heal it
  // from the paid cycle invoice first; otherwise the upgrade's invoice would
  // become `latest_invoice` and the late renewal grant would be lost.
  if (wallet.periodEnd.getTime() <= now.getTime()) {
    const inv = expandedInvoice(sub);
    if (inv && inv.status === "paid" && shouldRefreshOnInvoicePaid(inv, wallet)) {
      const line = inv.lines.data[0]!;
      await refreshMonthlyCredits(userId, {
        periodStart: new Date(line.period.start * 1000),
        periodEnd: new Date(line.period.end * 1000),
      });
    } else {
      return fail("wallet_stale");
    }
  }

  if (direction === "downgrade") {
    await deps.stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: STRIPE_PLAN_TO_PRICE[targetPlan]! }],
      proration_behavior: "none",
    });
    const effectiveAt = new Date(item.current_period_end * 1000);
    await setPendingPlan(userId, targetPlan, effectiveAt);
    return { status: "scheduled", plan: targetPlan, effectiveAt: effectiveAt.toISOString() };
  }

  // Upgrade. A leftover pending update (an earlier decline) must be voided or
  // Stripe refuses the new one; its invoice is the current latest_invoice.
  if (sub.pending_update) {
    const pendingInvoiceId = invoiceIdOf(sub);
    if (pendingInvoiceId) await deps.stripe.invoices.voidInvoice(pendingInvoiceId).catch(() => {});
    sub = await deps.stripe.subscriptions.retrieve(sub.id, { expand: ["latest_invoice"] });
  }
  // Cancellation must be cleared in its own call (not pending-update safe).
  // Flexible-mode portal cancels set cancel_at; ours set cancel_at_period_end.
  if (sub.cancel_at_period_end) {
    sub = await deps.stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
  } else if (sub.cancel_at) {
    sub = await deps.stripe.subscriptions.update(sub.id, { cancel_at: "" });
  }

  const prevInvoiceId = invoiceIdOf(sub) ?? "none";
  const updated = await deps.stripe.subscriptions.update(sub.id, {
    items: [{ id: item.id, price: STRIPE_PLAN_TO_PRICE[targetPlan]! }],
    billing_cycle_anchor: "now",
    proration_behavior: "none",
    payment_behavior: "pending_if_incomplete",
    metadata: { ...(sub.metadata ?? {}), yumina_plan_change: planChangeMarker(targetPlan, prevInvoiceId, now) },
    expand: ["latest_invoice.confirmation_secret"],
  }, { idempotencyKey: planChangeIdempotencyKey(userId, targetPlan, prevInvoiceId, now) });

  const inv = expandedInvoice(updated);
  if (updated.pending_update) {
    // Payment needs the customer (3DS) or a new card. The subscription is
    // unchanged until the open invoice is paid; nothing is booked here.
    return {
      status: "requires_action",
      invoiceId: inv?.id ?? invoiceIdOf(updated),
      clientSecret: inv?.confirmation_secret?.client_secret ?? null,
      hostedInvoiceUrl: inv?.hosted_invoice_url ?? null,
      expiresAt: updated.pending_update.expires_at ? new Date(updated.pending_update.expires_at * 1000).toISOString() : null,
      amountDueCents: inv?.amount_due ?? null,
    };
  }
  const newItem = updated.items.data[0];
  if (inv && newItem && inv.status === "paid") {
    return applied(await applyPaidUpgrade(userId, targetPlan, { ...itemPeriod(newItem), referenceId: inv.id }));
  }
  // Charged asynchronously (rare): the webhooks book it when the invoice pays.
  return { status: "pending" };
}

/**
 * After the customer finished a payment in the app (3DS) or on the hosted
 * invoice page: book the upgrade if Stripe applied it. Trusts nothing from the
 * client — everything is re-read from the subscription. Stripe applies a
 * pending update a moment after the payment succeeds, so this polls briefly.
 */
export async function finalizePlanChange(
  deps: PlanChangeDeps,
  userId: string,
): Promise<{ status: "applied" | "pending" | "unchanged"; plan?: PlanId; balance?: number; periodEnd?: string }> {
  const resolved = await deps.resolveSubscription(userId);
  if (!resolved) return { status: "unchanged" };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 5; attempt++) {
    const sub = await deps.stripe.subscriptions.retrieve(resolved.subId, { expand: ["latest_invoice"] });
    const wallet = await ensureWallet(userId);
    const item = sub.items.data[0];
    const inv = expandedInvoice(sub);
    const stripePlan = item ? STRIPE_PRICE_TO_PLAN[item.price.id] : undefined;
    if (item && inv && stripePlan && stripePlan !== wallet.plan && planMeetsMinimum(stripePlan, wallet.plan)
      && isCycleResetInvoice(inv, item, sub, stripePlan)) {
      const w = await applyPaidUpgrade(userId, stripePlan, { ...itemPeriod(item), referenceId: inv.id });
      return { status: "applied", plan: w.plan, balance: Math.floor(w.balance), periodEnd: w.periodEnd.toISOString() };
    }
    if (!sub.pending_update) {
      // Matching an unchanged tier also happens when an unpaid upgrade expires.
      // Only a paid upgrade invoice can confirm delivery (including webhook-first).
      return sub.status === "active" && item && inv && stripePlan === wallet.plan
        && isCycleResetInvoice(inv, item, sub, stripePlan)
        ? { status: "applied", plan: wallet.plan, balance: Math.floor(wallet.balance), periodEnd: wallet.periodEnd.toISOString() }
        : { status: "unchanged" };
    }
    await sleep(1000);
  }
  return { status: "pending" };
}

/** For the status payload: an upgrade the customer still has to pay for, if any. */
export function pendingUpgradeFor(sub: Stripe.Subscription): { invoiceId: string | null; hostedInvoiceUrl: string | null; expiresAt: string | null } | null {
  if (!sub.pending_update) return null;
  const inv = expandedInvoice(sub);
  return {
    invoiceId: inv?.id ?? invoiceIdOf(sub),
    hostedInvoiceUrl: inv?.hosted_invoice_url ?? null,
    expiresAt: sub.pending_update.expires_at ? new Date(sub.pending_update.expires_at * 1000).toISOString() : null,
  };
}
