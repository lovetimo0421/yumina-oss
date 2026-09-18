export type StripeSubscriptionListItem = {
  id: string;
  status: string;
};

export type StripeSubscriptionListPage = {
  data: readonly StripeSubscriptionListItem[];
  has_more: boolean;
};

export function isMissingStripeResource(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: string;
    statusCode?: number;
    raw?: { code?: string };
  };
  return value.statusCode === 404
    || value.code === "resource_missing"
    || value.raw?.code === "resource_missing";
}

/**
 * Close the exact Connect account captured before deleting the local user.
 * Missing accounts are already clean; every other Stripe failure must escape
 * so the durable deletion outbox retains the job and retries it.
 */
export async function closeStripeConnectAccount(
  accountId: string,
  deleteAccount: (accountId: string) => Promise<unknown>,
): Promise<void> {
  try {
    await deleteAccount(accountId);
  } catch (error) {
    if (!isMissingStripeResource(error)) throw error;
  }
}

/**
 * Walk every Stripe subscription page before cancellation begins. Keeping the
 * traversal separate from mutation avoids invalidating a starting_after cursor
 * midway through the list. A malformed/non-advancing page fails closed so the
 * deletion outbox retries instead of silently leaving a renewable subscription.
 */
export async function listCancelableStripeSubscriptionIds(
  listPage: (startingAfter: string | undefined) => Promise<StripeSubscriptionListPage>,
): Promise<string[]> {
  const subscriptionIds = new Set<string>();
  const usedCursors = new Set<string>();
  let startingAfter: string | undefined;

  for (;;) {
    const page = await listPage(startingAfter);
    for (const subscription of page.data) {
      if (subscription.status !== "canceled" && subscription.status !== "incomplete_expired") {
        subscriptionIds.add(subscription.id);
      }
    }

    if (!page.has_more) break;

    const nextCursor = page.data.at(-1)?.id;
    if (!nextCursor || nextCursor === startingAfter || usedCursors.has(nextCursor)) {
      throw new Error("Stripe subscription pagination did not advance");
    }
    usedCursors.add(nextCursor);
    startingAfter = nextCursor;
  }

  return [...subscriptionIds];
}
