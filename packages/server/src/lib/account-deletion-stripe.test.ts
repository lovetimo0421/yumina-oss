import assert from "node:assert/strict";
import test from "node:test";
import {
  closeStripeConnectAccount,
  isMissingStripeResource,
  listCancelableStripeSubscriptionIds,
} from "./account-deletion-stripe.js";

test("Connect cleanup accepts an already-missing account", async () => {
  for (const error of [
    { statusCode: 404 },
    { code: "resource_missing" },
    { raw: { code: "resource_missing" } },
  ]) {
    assert.equal(isMissingStripeResource(error), true);
    await closeStripeConnectAccount("acct_deleted", async () => {
      throw error;
    });
  }
});

test("Connect cleanup propagates a nonzero-balance failure for durable retry", async () => {
  const stripeError = Object.assign(new Error("account balance must be zero"), {
    code: "balance_not_zero",
  });

  await assert.rejects(
    closeStripeConnectAccount("acct_with_balance", async () => {
      throw stripeError;
    }),
    stripeError,
  );
});

test("subscription cleanup follows every page and filters terminal subscriptions", async () => {
  const requestedCursors: Array<string | undefined> = [];
  const pages = new Map<string | undefined, {
    data: Array<{ id: string; status: string }>;
    has_more: boolean;
  }>([
    [undefined, {
      data: [
        { id: "sub_active_1", status: "active" },
        { id: "sub_cursor_1", status: "canceled" },
      ],
      has_more: true,
    }],
    ["sub_cursor_1", {
      data: [
        { id: "sub_active_2", status: "past_due" },
        { id: "sub_cursor_2", status: "incomplete_expired" },
      ],
      has_more: true,
    }],
    ["sub_cursor_2", {
      data: [
        { id: "sub_active_1", status: "active" },
        { id: "sub_active_3", status: "trialing" },
      ],
      has_more: false,
    }],
  ]);

  const ids = await listCancelableStripeSubscriptionIds(async (startingAfter) => {
    requestedCursors.push(startingAfter);
    const page = pages.get(startingAfter);
    assert.ok(page, `unexpected cursor ${startingAfter}`);
    return page;
  });

  assert.deepEqual(requestedCursors, [undefined, "sub_cursor_1", "sub_cursor_2"]);
  assert.deepEqual(ids, ["sub_active_1", "sub_active_2", "sub_active_3"]);
});

test("subscription cleanup fails closed when Stripe cannot advance the cursor", async () => {
  await assert.rejects(
    listCancelableStripeSubscriptionIds(async () => ({ data: [], has_more: true })),
    /pagination did not advance/,
  );
});
