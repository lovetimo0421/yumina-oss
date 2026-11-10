import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import * as database from "../db/index.js";
import { user, creatorPayoutAccounts, creatorEarnings, deletedAccountTombstones, verification } from "../db/schema.js";
import { env } from "../lib/env.js";

// The fixture provisions the complete schema, while PGlite intentionally
// never reports production FK readiness. Mock only that readiness probe.
let schemaReady = true;
mock.module(new URL("../db/index.ts", import.meta.url).href, {
  namedExports: { ...database, isAccountDeletionSchemaReady: () => schemaReady },
});
// A fake provider key enables the production send path; all HTTP is mocked.
env.RESEND_API_KEY = "re_isolated_fixture";
// Exercise production-origin validation and link generation in the isolated DB.
env.APP_URL = "https://yumina.io";
const { auth } = await import("../lib/auth.js");
const { authRoutes } = await import("./auth.js");
const { assertAccountDeletionAllowed } = await import("../lib/account-deletion.js");
const { hashDeletedIdentity } = await import("../lib/deleted-identity.js");
const app = new Hono().route("/api/auth", authRoutes);
const json = async (response: Response): Promise<any> => response.json();

test("authenticated preflight and email flow defer billing, final deletion remains blocked", async t => {
  const id = "deletion-email-fixture";
  await db.insert(user).values({ id, email: "deletion@example.test", username: "DeleteFixture", name: "Fixture",
    stripeCustomerId: "cus_fixture", birthYear: 1990 });
  await db.insert(creatorPayoutAccounts).values({ userId: id, stripeConnectId: "acct_fixture", status: "restricted" });
  let signedIn = true;
  t.mock.method(auth.api, "getSession", async () => signedIn ? { user: { id }, session: { userId: id } } : null);
  let delivered = 0;
  let failDelivery = false;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.equal(String(input), "https://api.resend.com/emails", "no Stripe mutations or other outbound calls");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.to, "deletion@example.test");
    assert.ok(body.html.includes("#token="));
    assert.match(body.html, /https:\/\/yumina\.io\/delete-account#token=[a-f0-9]{48}/);
    assert.ok(!body.html.includes("testing.example.test"));
    if (failDelivery) return Response.json({ name: "validation_error", message: "fixture failure" }, { status: 400 });
    delivered++;
    return Response.json({ id: "fixture-email" });
  });
  const send = (body: object, origin = env.APP_URL) => app.request("/api/auth/delete-user", {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
  signedIn = false;
  assert.equal((await app.request("/api/auth/delete-user/preflight")).status, 401);
  assert.equal((await send({ confirmation: "DeleteFixture" })).status, 401);
  signedIn = true;
  const check = await app.request("/api/auth/delete-user/preflight");
  assert.equal(check.status, 200);
  assert.equal(check.headers.get("cache-control"), "no-store");
  const report = (await json(check)).data;
  assert.equal(report.canSendEmail, true);
  assert.equal(report.canDelete, false);
  assert.deepEqual(report.issues[0].billingRecords, ["customer", "connect"]);
  assert.equal((await db.select().from(verification)).length, 0, "read-only diagnostics");
  assert.equal((await send({ confirmation: "wrong" })).status, 400);
  assert.equal((await send({ confirmation: "DeleteFixture" }, "https://untrusted.test")).status, 403);
  assert.equal((await send({ confirmation: "DeleteFixture" }, "https://testing.example.test")).status, 403);
  const sent = await send({ confirmation: "DeleteFixture", locale: "zh" });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.equal((await json(sent)).success, true);
  assert.equal(delivered, 1);
  const tokens = await db.select().from(verification).where(eq(verification.value, id));
  assert.equal(tokens.length, 1);
  const token = tokens[0]!.identifier.replace("delete-account-", "");
  assert.match(token, /^[a-f0-9]{48}$/);
  const deletion = await send({ confirmation: "DeleteFixture", token, phase: "email" });
  assert.equal(deletion.status, 409, "client cannot select email mode for final deletion");
  assert.equal((await json(deletion)).code, "BILLING_CLEANUP_UNAVAILABLE");
  await assert.rejects(assertAccountDeletionAllowed(id), { code: "BILLING_CLEANUP_UNAVAILABLE" });
  assert.equal((await db.select().from(user).where(eq(user.id, id))).length, 1);
  assert.equal((await db.select().from(creatorPayoutAccounts)).length, 1);
  failDelivery = true;
  const failed = await send({ confirmation: "DeleteFixture" });
  assert.equal(failed.status, 503);
  assert.equal((await json(failed)).code, "DELETE_CONFIRMATION_EMAIL_FAILED");
  assert.equal((await db.select().from(verification).where(eq(verification.value, id))).length, 1,
    "failed delivery removes only the newly created token");
  failDelivery = false;
  await db.update(user).set({ role: "admin" }).where(eq(user.id, id));
  await db.insert(deletedAccountTombstones).values({ identityHash: hashDeletedIdentity("deletion@example.test") });
  await db.insert(creatorEarnings).values({ creatorId: id, grossAmount: 100, platformFee: 10, status: "held" });
  const blocked = await send({ confirmation: "DeleteFixture" });
  assert.equal(blocked.status, 409);
  const blockers = (await json(blocked)).issues.map((issue: { code: string }) => issue.code);
  assert.deepEqual(blockers, ["LAST_ADMIN_ACCOUNT", "ACCOUNT_DELETION_COOLDOWN", "PENDING_CREATOR_EARNINGS", "BILLING_CLEANUP_UNAVAILABLE"]);
  assert.equal(delivered, 1, "all other eligibility blockers still prevent sending");
  assert.equal((await db.select().from(verification).where(eq(verification.value, id))).length, 1);
  schemaReady = false;
  const unready = await send({ confirmation: "DeleteFixture" });
  assert.equal(unready.status, 503);
  assert.equal((await json(unready)).code, "ACCOUNT_DELETION_NOT_READY");
});
