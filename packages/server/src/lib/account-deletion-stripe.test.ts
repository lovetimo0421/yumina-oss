import assert from "node:assert/strict";
import test from "node:test";
import {
  closeStripeConnectAccount,
  isMissingStripeResource,
  isStripeParameterNotEditable,
  listCancelableStripeSubscriptionIds,
  redactAndDeleteConnectAccount,
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

test("Connect cleanup accepts an account Stripe says is gone or unreachable", async () => {
  const message = "The provided key 'sk_live_***' does not have access to account 'acct_1Tz' (or that account does not exist). Application access may have been revoked.";
  for (const error of [
    Object.assign(new Error(message), { statusCode: 403 }),
    { code: "account_invalid" },
    { raw: { message } },
  ]) {
    await closeStripeConnectAccount("acct_gone", async () => {
      throw error;
    });
  }
});

test("Connect cleanup still propagates an unrelated permission error", async () => {
  const stripeError = Object.assign(new Error("The provided key does not have the required permissions for this endpoint"), {
    statusCode: 403,
  });
  await assert.rejects(
    closeStripeConnectAccount("acct_1", async () => {
      throw stripeError;
    }),
    stripeError,
  );
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

const EMAIL_NOT_EDITABLE = Object.assign(
  new Error("This application is not authorized to edit the parameter 'email'."),
  { type: "StripeInvalidRequestError", param: "email", statusCode: 400 },
);

test("a platform-uneditable Connect email is recognised as permanent, other errors are not", () => {
  assert.equal(isStripeParameterNotEditable(EMAIL_NOT_EDITABLE, "email"), true);
  assert.equal(isStripeParameterNotEditable({ raw: { message: EMAIL_NOT_EDITABLE.message } }, "email"), true);
  assert.equal(isStripeParameterNotEditable(EMAIL_NOT_EDITABLE, "business_profile"), false);
  assert.equal(isStripeParameterNotEditable(new Error("Rate limit"), "email"), false);
  assert.equal(isStripeParameterNotEditable(null, "email"), false);
});

test("Connect redaction still deletes the account when Stripe refuses the email edit", async () => {
  const calls: unknown[] = [];
  await redactAndDeleteConnectAccount("acct_1", "user_1", {
    async update(accountId, params) {
      calls.push(["update", accountId, params]);
      if ("email" in params) throw EMAIL_NOT_EDITABLE;
    },
    async del(accountId) { calls.push(["del", accountId]); },
  });
  assert.deepEqual(calls, [
    ["update", "acct_1", { email: "", metadata: { userId: "user_1" } }],
    ["update", "acct_1", { metadata: { userId: "user_1" } }],
    ["del", "acct_1"],
  ]);
});

test("Connect redaction keeps the normal path and surfaces other failures", async () => {
  const calls: unknown[] = [];
  await redactAndDeleteConnectAccount("acct_2", "user_2", {
    async update(accountId, params) { calls.push(["update", accountId, params]); },
    async del(accountId) { calls.push(["del", accountId]); },
  });
  assert.deepEqual(calls, [
    ["update", "acct_2", { email: "", metadata: { userId: "user_2" } }],
    ["del", "acct_2"],
  ]);
  let deleted = false;
  await assert.rejects(redactAndDeleteConnectAccount("acct_3", "user_3", {
    async update() { throw new Error("Stripe is down"); },
    async del() { deleted = true; },
  }), /Stripe is down/);
  assert.equal(deleted, false);
});
