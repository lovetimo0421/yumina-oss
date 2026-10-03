import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { isTtsOptedIn } from "@yumina/shared";
import { db } from "../db/index.js";
import { user, worlds, playSessions, creditWallets, creditTransactions } from "../db/schema.js";
import { ttsRoutes } from "./tts.js";
import type { AppEnv } from "../lib/types.js";

// Voice readout is opt-in: without preferences.ttsEnabled === true the server
// never synthesizes or charges.

test("tts opt-in: only an explicit true counts", () => {
  assert.equal(isTtsOptedIn(undefined), false);
  assert.equal(isTtsOptedIn({}), false);
  assert.equal(isTtsOptedIn({ ttsAutoPlay: true }), false);
  assert.equal(isTtsOptedIn({ ttsEnabled: "true" }), false);
  assert.equal(isTtsOptedIn({ ttsEnabled: false }), false);
  assert.equal(isTtsOptedIn({ ttsEnabled: true }), true);
});

async function fixture(preferences: Record<string, unknown>) {
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name: "TTS opt-in test", email: `${id}@test.local`, preferences });
  await db.insert(creditWallets).values({ userId: id, plan: "free", balance: 100, addonBalance: 0,
    periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) });
  const worldId = crypto.randomUUID();
  await db.insert(worlds).values({ id: worldId, creatorId: id, name: "TTS test", status: "draft", schema: {} });
  const [session] = await db.insert(playSessions).values({ userId: id, worldId }).returning();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id } as AppEnv["Variables"]["user"]); await next(); });
  // The handlers alone (the auth middleware is stood in for above).
  for (const route of ttsRoutes.routes) if (route.method === "POST") app.post(route.path, route.handler);
  const post = (path: string, body: Record<string, unknown>) => app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const ledger = async () => {
    const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.userId, id));
    return { balance: wallet!.balance, rows: await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, wallet!.id)) };
  };
  return { sessionId: session!.id, post, ledger };
}

test("readout and preview refuse players who haven't opted in, and charge nothing", async () => {
  for (const prefs of [{}, { ttsEnabled: false }, { ttsAutoPlay: true }]) {
    const off = await fixture(prefs);
    for (const [path, body] of [
      [`/sessions/${off.sessionId}/tts`, { text: "Hello there." }],
      ["/tts/preview", { lang: "en" }],
    ] as const) {
      const res = await off.post(path, body);
      assert.equal(res.status, 403, `${path} with ${JSON.stringify(prefs)}`);
      assert.equal(((await res.json()) as { code: string }).code, "TTS_OFF");
    }
    const { balance, rows } = await off.ledger();
    assert.equal(balance, 100);
    assert.equal(rows.length, 0);
  }
});

test("an opted-in player passes the gate", async () => {
  const on = await fixture({ ttsEnabled: true });
  // No text: the request gets past the opt-in and stops at validation, before any synth.
  const res = await on.post(`/sessions/${on.sessionId}/tts`, {});
  assert.equal(res.status, 400);
  assert.notEqual(((await res.json()) as { code?: string }).code, "TTS_OFF");
});
