// Decides whether a Stripe subscription justifies minting a new month of plan
// credits, and for which billing period. Pure logic — the Stripe fetch lives in
// credit-service.ts (paidStripeRenewalPeriod) so this part is unit-testable.
//
// Why this exists (2026-07-19, @dekadesoummer8 report): the lazy renewal in
// checkBalance minted a full month of credits the moment wallet.periodEnd
// passed, even when the renewal charge had FAILED and the sub was past_due —
// plan benefits granted with $0 collected. Minting must follow money:
// only an active sub whose current cycle invoice is PAID gets the grant.

export interface RenewalInvoiceLine {
  /** Current API shape: the price the line was billed at (id, or the object when expanded). */
  pricing?: { price_details?: { price?: string | { id: string } | null } | null } | null;
  /** Legacy (pre-basil) line shape. */
  price?: { id: string } | null;
}

export interface RenewalInvoice {
  status: string | null;
  billing_reason?: string | null;
  lines?: { data: RenewalInvoiceLine[] } | null;
}

export interface RenewalSubscription {
  status: string;
  // Expanded by the caller; a string means "not expanded" and is treated as unpaid.
  latest_invoice?: string | RenewalInvoice | null;
  items: {
    data: Array<{
      current_period_start?: number;
      current_period_end?: number;
      price?: { id: string } | null;
    }>;
  };
}

export interface PaidRenewal {
  periodStart: Date;
  periodEnd: Date;
  /** Price the customer is actually paying. Callers map it to a plan and must
   * refuse to mint when it doesn't match the wallet's plan — e.g. a
   * time-limited admin/comp tier layered over a cheaper paid sub must never
   * have the comp tier's credits minted against the cheap sub's invoice. */
  priceId: string;
}

/**
 * Returns the paid-for billing period if (and only if) the subscription's
 * current cycle is settled: status is `active` (past_due/unpaid/canceled/
 * incomplete never mint; Stripe's dunning owns those), the latest invoice is
 * PAID, and that invoice is a cycle/create invoice (a paid `subscription_update`
 * proration does not re-justify a monthly grant — the upgrade path already
 * granted it). The period must still be running; a lapsed period can't fund
 * a mint. Returns null otherwise — callers fail closed.
 */
export function paidRenewalPeriod(
  sub: RenewalSubscription,
  now: Date,
): PaidRenewal | null {
  if (sub.status !== "active") return null;

  const inv = sub.latest_invoice;
  if (!inv || typeof inv === "string") return null;
  if (inv.status !== "paid") return null;
  const reason = inv.billing_reason ?? null;
  if (reason !== "subscription_cycle" && reason !== "subscription_create") return null;

  const item = sub.items.data[0];
  if (!item?.current_period_start || !item?.current_period_end || !item.price?.id) return null;
  const periodStart = new Date(item.current_period_start * 1000);
  const periodEnd = new Date(item.current_period_end * 1000);
  if (periodEnd.getTime() <= now.getTime()) return null;

  // The price the customer actually PAID comes from the invoice line, never
  // from the live subscription item. A scheduled downgrade that has already
  // billed the lower price, followed by /cancel-pending (which reverts the item
  // with no charge), would otherwise mint the higher plan's month against the
  // cheap invoice (found in review 2026-09-17).
  const line = inv.lines?.data?.[0];
  const linePrice = line?.pricing?.price_details?.price ?? null;
  const linePriceId = (typeof linePrice === "string" ? linePrice : linePrice?.id) ?? line?.price?.id ?? null;

  return { periodStart, periodEnd, priceId: linePriceId ?? item.price.id };
}
