export type StripeCleanupArtifacts = {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripeConnectId?: string | null;
  stripePaymentIntentIds?: readonly string[];
  stripeCheckoutSessionIds?: readonly string[];
};

/** Keep the request preflight and durable outbox's Stripe requirements aligned. */
export function hasStripeCleanupArtifacts(context: StripeCleanupArtifacts): boolean {
  return Boolean(
    context.stripeCustomerId
      || context.stripeSubscriptionId
      || context.stripeConnectId
      || context.stripePaymentIntentIds?.length
      || context.stripeCheckoutSessionIds?.length,
  );
}
