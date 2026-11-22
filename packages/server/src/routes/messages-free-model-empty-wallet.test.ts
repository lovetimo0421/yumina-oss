import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, creditWallets, creditTransactions, modelPrices } from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import { invalidateModelPriceCache } from "../lib/model-price-cache.js";
import { env } from "../lib/env.js";
import type { AppEnv } from "../lib/types.js";

// A player who spent every mushie picked Yumina Free and was told they were out
// of mushies (2026-11-01). Free is free: an empty wallet stops priced models only.
test("an empty wallet refuses a priced model but Yumina Free still answers, for nothing", async t => {
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-official-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = oldKey; });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "openrouter/free", context_length: 200000, architecture: { input_modalities: ["text"] } },
    { id: "z-ai/glm-5.3-flash", context_length: 1310720, architecture: { input_modalities: ["text"] } },
  ] }));
  const inference = t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* () {
    yield { type: "text" as const, content: "The lantern is still lit. ".repeat(60) };
    yield { type: "done" as const, content: "", stopReason: "end_turn", usage: { promptTokens: 4000, completionTokens: 400, totalTokens: 4400 } };
  });
  await db.insert(modelPrices).values([
    { modelId: "openrouter/free", inputPricePerM: 0, outputPricePerM: 0, minPlan: "free", markupMultiplier: 1 },
    { modelId: "z-ai/glm-5.3-flash", inputPricePerM: 1, outputPricePerM: 1, minPlan: "free" },
  ]).onConflictDoNothing();
  invalidateModelPriceCache();

  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name: "Empty wallet player", email: `${id}@test.local`, preferences: { preferredProvider: "official" } });
  const [wallet] = await db.insert(creditWallets).values({ userId: id, plan: "free", planVersion: 2, balance: 0, addonBalance: 0,
    periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) }).returning();
  const worldId = crypto.randomUUID();
  const schema = migrateWorldDefinition({ id: worldId, version: "1.0.0", name: "Empty wallet test", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 2000, temperature: 1, playerName: "User" } } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: id, name: schema.name, status: "draft", schema: schema as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId: id, worldId }).returning();
  t.after(async () => { await db.delete(user).where(eq(user.id, id)); });

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id } as AppEnv["Variables"]["user"]); await next(); });
  const pattern = "/sessions/:sessionId/messages";
  for (const route of messageRoutes.routes.filter(r => r.method === "POST" && r.path === pattern)) app.post(pattern, route.handler);
  const send = (model: string) => app.request(`/sessions/${session!.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "Is the lantern lit?", model }) });
  const balance = async () => (await db.select().from(creditWallets).where(eq(creditWallets.id, wallet!.id)))[0]!.balance;

  const priced = await send("z-ai/glm-5.3-flash");
  assert.equal(priced.status, 402, await priced.clone().text());
  assert.equal((await priced.json() as { code: string }).code, "NO_CREDITS");
  assert.equal(inference.mock.callCount(), 0, "a priced model never reaches the provider on an empty wallet");

  const free = await send("openrouter/free");
  assert.equal(free.status, 200, await free.clone().text());
  const stream = await free.text();
  assert.match(stream, /event: done/);
  assert.doesNotMatch(stream, /event: error/, "no mid-stream out-of-mushies abort on a free turn");
  assert.doesNotMatch(stream, /NO_CREDITS/);
  assert.equal(inference.mock.callCount(), 1);
  assert.equal(await balance(), 0);
  const charges = await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, wallet!.id));
  assert.ok(charges.every(row => row.amount === 0), "a free turn takes no mushies");
});
