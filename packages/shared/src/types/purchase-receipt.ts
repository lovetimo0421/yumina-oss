export interface DeliveredPurchase {
  status: "ready";
  purchaseId: string;
  kind: "pack" | "subscription";
  plan: string | null;
  /** The actual ledger grant, not the total monthly entitlement or balance. */
  mushies: number;
  bonusMushies: number;
  nextDrop: { amount: number; at: string } | null;
  preservesGift: boolean;
  /** What Stripe charged, in the currency's minor unit, for ad-conversion values. */
  amountCents?: number | null;
  currency?: string | null;
}

export type PurchaseReceipt = DeliveredPurchase | {
  status: "pending" | "reversing" | "failed" | "expired";
};
