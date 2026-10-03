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
 * Stripe refuses platform edits of some fields on Standard/Express Connect
 * accounts ("This application is not authorized to edit the parameter
 * 'email'."). That is a permanent property of the account, not a transient
 * failure: retrying the same update can never succeed.
 */
export function isStripeParameterNotEditable(error: unknown, parameter: string): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { param?: string; message?: string; raw?: { param?: string; message?: string } };
  const message = value.message ?? value.raw?.message ?? "";
  const match = /not authorized to edit the parameter '([^']+)'/i.exec(message);
  if (!match) return false;
  return match[1] === parameter || value.param === parameter || value.raw?.param === parameter;
}

/**
 * Redact then delete a Connect account found by the final metadata scan. When
 * Stripe does not let the platform edit the account's email, redact only what
 * it allows (metadata) and still delete; deletion removes the email as well.
 */
export async function redactAndDeleteConnectAccount(
  accountId: string,
  deletedUserId: string,
  api: {
    update(accountId: string, params: { email?: string; metadata: Record<string, string> }): Promise<unknown>;
    del(accountId: string): Promise<unknown>;
  },
): Promise<void> {
  // Retain the minimal discovery marker until Stripe confirms deletion.
  const metadata = { userId: deletedUserId };
  try {
    await api.update(accountId, { email: "", metadata });
  } catch (error) {
    if (!isStripeParameterNotEditable(error, "email")) throw error;
    await api.update(accountId, { metadata });
  }
  await api.del(accountId);
}

/**
 * A deleted (or disconnected) Connect account is not reported as a 404: Stripe
 * answers "The provided key ... does not have access to account 'acct_…' (or
 * that account does not exist)" with code account_invalid. Either way the
 * platform can no longer reach it, so there is nothing left to close.
 */
export function isUnreachableConnectAccount(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; message?: string; raw?: { code?: string; message?: string } };
  if (value.code === "account_invalid" || value.raw?.code === "account_invalid") return true;
  const message = value.message ?? value.raw?.message ?? "";
  return /does not have access to account '[^']+' \(or that account does not exist\)/i.test(message);
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
    if (!isMissingStripeResource(error) && !isUnreachableConnectAccount(error)) throw error;
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
