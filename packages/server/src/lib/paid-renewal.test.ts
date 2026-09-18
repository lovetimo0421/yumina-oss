import { test } from "node:test";
import assert from "node:assert/strict";
import { paidRenewalPeriod, type RenewalSubscription } from "./paid-renewal.js";

const now = new Date("2026-07-18T01:04:34Z");
const periodStart = Math.floor(new Date("2026-07-18T00:13:09Z").getTime() / 1000);
const periodEnd = Math.floor(new Date("2026-08-18T00:13:09Z").getTime() / 1000);

function sub(overrides: Partial<RenewalSubscription> = {}): RenewalSubscription {
  return {
    status: "active",
    latest_invoice: { status: "paid", billing_reason: "subscription_cycle" },
    items: {
      data: [{
        current_period_start: periodStart,
        current_period_end: periodEnd,
        price: { id: "price_go" },
      }],
    },
    ...overrides,
  };
}

test("paid cycle invoice on an active sub mints, anchored to the Stripe period", () => {
  const period = paidRenewalPeriod(sub(), now);
  assert.ok(period);
  assert.equal(period.periodStart.toISOString(), "2026-07-18T00:13:09.000Z");
  assert.equal(period.periodEnd.toISOString(), "2026-08-18T00:13:09.000Z");
  // The paid price is surfaced so callers can refuse tier-mismatched mints
  // (admin/comp tier layered over a cheaper paid sub).
  assert.equal(period.priceId, "price_go");
});

test("past_due sub never mints (the dekadesoummer8 case)", () => {
  // Renewal charge failed → sub past_due, invoice open. Pre-fix the lazy
  // refresh minted 4,000 mushies for $0 collected.
  const s = sub({
    status: "past_due",
    latest_invoice: { status: "open", billing_reason: "subscription_cycle" },
  });
  assert.equal(paidRenewalPeriod(s, now), null);
});

test("active sub with a still-open cycle invoice does not mint yet", () => {
  // At the cycle boundary Stripe advances the period and creates the invoice
  // BEFORE the first charge attempt. The sub is still `active` for ~an hour —
  // status alone is not proof of payment.
  const s = sub({ latest_invoice: { status: "open", billing_reason: "subscription_cycle" } });
  assert.equal(paidRenewalPeriod(s, now), null);
});

test("canceled and unpaid subs never mint", () => {
  assert.equal(paidRenewalPeriod(sub({ status: "canceled" }), now), null);
  assert.equal(paidRenewalPeriod(sub({ status: "unpaid" }), now), null);
});

test("a paid proration (subscription_update) invoice does not re-justify a grant", () => {
  const s = sub({ latest_invoice: { status: "paid", billing_reason: "subscription_update" } });
  assert.equal(paidRenewalPeriod(s, now), null);
});

test("subscription_create invoice mints (first cycle, missed checkout webhook)", () => {
  const s = sub({ latest_invoice: { status: "paid", billing_reason: "subscription_create" } });
  assert.ok(paidRenewalPeriod(s, now));
});

test("a lapsed period cannot fund a mint", () => {
  const late = new Date("2026-08-18T00:13:10Z");
  assert.equal(paidRenewalPeriod(sub(), late), null);
});

test("unexpanded or missing latest_invoice fails closed", () => {
  assert.equal(paidRenewalPeriod(sub({ latest_invoice: "in_123" }), now), null);
  assert.equal(paidRenewalPeriod(sub({ latest_invoice: null }), now), null);
});

test("missing item period or price fails closed", () => {
  assert.equal(paidRenewalPeriod(sub({ items: { data: [] } }), now), null);
  assert.equal(paidRenewalPeriod(sub({ items: { data: [{}] } }), now), null);
  const noPrice = sub({
    items: { data: [{ current_period_start: periodStart, current_period_end: periodEnd }] },
  });
  assert.equal(paidRenewalPeriod(noPrice, now), null);
});

test("the paid price comes from the invoice line, not the live item (downgrade billed, then reverted for free)", () => {
  // Diamond → Gold scheduled; the renewal billed Gold ($5). /cancel-pending
  // then put the Diamond price back on the item with no charge. The live item
  // says Diamond, the paid invoice says Gold — the mint must follow the money.
  const s = sub({
    latest_invoice: {
      status: "paid",
      billing_reason: "subscription_cycle",
      lines: { data: [{ pricing: { price_details: { price: "price_go" } } }] },
    },
    items: { data: [{ current_period_start: periodStart, current_period_end: periodEnd, price: { id: "price_pro" } }] },
  });
  assert.equal(paidRenewalPeriod(s, now)?.priceId, "price_go");
  // Legacy line shape and an expanded price object are read the same way.
  const legacy = sub({ latest_invoice: { status: "paid", billing_reason: "subscription_cycle", lines: { data: [{ price: { id: "price_plus" } }] } } });
  assert.equal(paidRenewalPeriod(legacy, now)?.priceId, "price_plus");
  const expanded = sub({ latest_invoice: { status: "paid", billing_reason: "subscription_cycle", lines: { data: [{ pricing: { price_details: { price: { id: "price_ultra" } } } }] } } });
  assert.equal(paidRenewalPeriod(expanded, now)?.priceId, "price_ultra");
  // No line at all falls back to the item.
  assert.equal(paidRenewalPeriod(sub(), now)?.priceId, "price_go");
});
