import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { eq, asc } from "drizzle-orm";
import sharp from "sharp";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages, creditWallets, creditTransactions, usageLogs, modelPrices } from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { storeChatImages } from "../lib/chat-images.js";
import { deleteObject } from "../lib/s3.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import { env } from "../lib/env.js";
import { acquireConcurrency, releaseConcurrency } from "../middleware/rate-limit.js";
import type { AppEnv } from "../lib/types.js";

test("history-image rejection removes only the new turn, releases admission, and allows one clean resend", async t => {
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-official-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = oldKey; });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "deepseek/deepseek-v3.2", context_length: 163840, architecture: { input_modalities: ["text"] } },
    // Simulate a provider capability downgrade after the account selected it.
    { id: "anthropic/claude-sonnet-4.6", context_length: 200000, architecture: { input_modalities: ["text"] } },
    { id: "google/gemini-2.5-flash", context_length: 1048576, architecture: { input_modalities: ["text", "image"] } },
  ] }));
  const inference = t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* () {
    yield { type: "text" as const, content: "I can still see the original image." };
    yield { type: "done" as const, content: "", stopReason: "end_turn", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
  });
  await db.insert(modelPrices).values(["deepseek/deepseek-v3.2", "anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash"].map(modelId => ({ modelId, inputPricePerM: 1, outputPricePerM: 1 })));
  const id = crypto.randomUUID();
  await db.insert(user).values({ id, name: "Image route test", email: `${id}@test.local`, preferences: { preferredProvider: "official" } });
  await db.insert(creditWallets).values({ userId: id, plan: "internal", balance: 100, addonBalance: 0, grokTrialRemaining: 2,
    periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) });
  const worldId = crypto.randomUUID();
  const schema = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Image route test", description: "", author: "test", entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1, playerName: "User" } } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: id, name: schema.name, status: "draft", schema: schema as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId: id, worldId }).returning();
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const attachments = await storeChatImages(id, [{ type: "image", mimeType: "image/png", name: "original.png", data: png.toString("base64") }]);
  t.after(async () => { await deleteObject(attachments[0]!.storageKey); await db.delete(user).where(eq(user.id, id)); });
  const original = await db.insert(messages).values([
    { sessionId: session!.id, role: "user", content: "Look at this", attachments, createdAt: new Date(Date.now() - 2000) },
    { sessionId: session!.id, role: "assistant", content: "I see it", createdAt: new Date(Date.now() - 1000) },
  ]).returning();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id } as AppEnv["Variables"]["user"]); await next(); });
  const pattern = "/sessions/:sessionId/messages";
  // Include every handler at this path, including request-body validation.
  for (const route of messageRoutes.routes.filter(r => r.method === "POST" && r.path === pattern)) app.post(pattern, route.handler);
  const send = (model: string, extra = {}) => app.request(`/sessions/${session!.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "What color was it?", model, ...extra }) });
  const history = () => db.select().from(messages).where(eq(messages.sessionId, session!.id)).orderBy(asc(messages.createdAt));
  const wallet = async () => (await db.select().from(creditWallets).where(eq(creditWallets.userId, id)))[0]!;
  for (const model of ["deepseek/deepseek-v3.2", "anthropic/claude-sonnet-4.6"]) {
    const response = await send(model);
    assert.equal(response.status, 400, await response.clone().text());
    const rejected = await response.json() as { code: string };
    assert.equal(rejected.code, "IMAGE_MODEL_REQUIRED", JSON.stringify(rejected));
    assert.deepEqual((await history()).map(m => m.id), original.map(m => m.id), "rejected text followup leaves original history intact");
    assert.equal(inference.mock.callCount(), 0);
    assert.equal((await wallet()).balance, 100);
    assert.equal((await wallet()).grokTrialRemaining, 2, "claimed trial is refunded");
    assert.equal((await db.select().from(worlds).where(eq(worlds.id, worldId)))[0]!.messageCount, 0);
    assert.deepEqual((await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0]!.state, session!.state);
    assert.equal(await acquireConcurrency(id, 1), true, "failed request releases its concurrency slot");
    await releaseConcurrency(id);
  }
  assert.equal((await db.select().from(usageLogs).where(eq(usageLogs.userId, id))).length, 0);
  assert.equal((await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, (await wallet()).id))).length, 0);
  const response = await send("google/gemini-2.5-flash");
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /event: done/);
  assert.doesNotMatch(stream, /event: error/);
  assert.equal(inference.mock.callCount(), 1);
  assert.equal((await history()).filter(m => m.role === "user" && m.content === "What color was it?").length, 1);
  assert.deepEqual((await history()).slice(0, 2).map(m => m.id), original.map(m => m.id));

  const [dangling] = await db.insert(messages).values({ sessionId: session!.id, role: "user", content: "What color was it?" }).returning();
  const beforeRetry = (await history()).map(m => m.id);
  const rejectedRetry = await send("deepseek/deepseek-v3.2", { retryMessageId: dangling!.id });
  assert.equal(rejectedRetry.status, 400, await rejectedRetry.clone().text());
  assert.deepEqual((await history()).map(m => m.id), beforeRetry, "reused fallback turn must never be deleted");
});
