/**
 * Gift cards through Tremendous: one API call per winner, the recipient gets
 * an email and picks their own brand from our campaign's catalog. We never
 * buy, hold or send a card ourselves.
 *
 * Env:
 *   TREMENDOUS_API_KEY            — off when unset (prizes wait in the admin queue instead)
 *   TREMENDOUS_CAMPAIGN_ID        — the campaign that defines which brands winners can choose
 *   TREMENDOUS_FUNDING_SOURCE_ID  — a connected bank account (Tremendous pulls per order),
 *                                   or "BALANCE" for a prefunded balance. Default "BALANCE".
 *   TREMENDOUS_SANDBOX=true       — use testflight.tremendous.com (fake money)
 *
 * Orders carry external_id, so a retry can never send the same prize twice:
 * Tremendous returns the existing order instead of making a new one.
 */

export interface GiftCardOrder {
  externalId: string;
  amountUsd: number; // whole dollars
  email: string;
  name: string;
}

export type GiftCardResult = { ok: true; orderId: string } | { ok: false; error: string; configured: boolean };

export function giftCardsConfigured() {
  return !!process.env.TREMENDOUS_API_KEY && !!process.env.TREMENDOUS_CAMPAIGN_ID;
}

export async function sendGiftCard(order: GiftCardOrder): Promise<GiftCardResult> {
  if (!giftCardsConfigured()) return { ok: false, error: "gift cards not configured", configured: false };
  if (!Number.isInteger(order.amountUsd) || order.amountUsd <= 0) return { ok: false, error: "amount must be whole dollars", configured: true };
  const base = process.env.TREMENDOUS_SANDBOX === "true"
    ? "https://testflight.tremendous.com/api/v2"
    : "https://www.tremendous.com/api/v2";
  try {
    const res = await fetch(`${base}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TREMENDOUS_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_id: order.externalId,
        payment: { funding_source_id: process.env.TREMENDOUS_FUNDING_SOURCE_ID || "BALANCE" },
        reward: {
          campaign_id: process.env.TREMENDOUS_CAMPAIGN_ID,
          value: { denomination: order.amountUsd, currency_code: "USD" },
          delivery: { method: "EMAIL" },
          recipient: { name: order.name.slice(0, 100), email: order.email },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => ({})) as { order?: { id?: string }; errors?: { message?: string } };
    if (!res.ok || !json.order?.id) {
      return { ok: false, error: `${res.status} ${json.errors?.message ?? "order failed"}`.slice(0, 300), configured: true };
    }
    return { ok: true, orderId: json.order.id };
  } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : "request failed").slice(0, 300), configured: true };
  }
}
