import "../test/database-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages, creditWallets, modelPrices } from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { normalizeGameState } from "../lib/game-state.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import { env } from "../lib/env.js";
import type { AppEnv } from "../lib/types.js";

test("deleting prior failed messages during send reproduces history conflict; retry without mutation succeeds", async t => {
  const priorKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-test-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = priorKey; });
  const model = "google/gemini-3.5-flash-lite";
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 1 });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: model, context_length: 1048576, architecture: { input_modalities: ["text"] } },
  ] }));
  let duringStream: (() => Promise<void>) | undefined;
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* () {
    yield { type: "text" as const, content: "A synthetic answer for the investigation." };
    await duringStream?.();
    yield { type: "done" as const, content: "", stopReason: "end_turn", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
  });
  const uid = crypto.randomUUID(), worldId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "History conflict test", email: `${uid}@test.local`, preferences: { preferredProvider: "official" } });
  await db.insert(creditWallets).values({ userId: uid, plan: "internal", balance: 100, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) });
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "History conflict", description: "", author: "test",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId,
    state: normalizeGameState(world, { turnCount: 1 }) as unknown as Record<string, unknown>, runMemories: { generation: "before" },
  }).returning();
  const oldRows = await db.insert(messages).values([0, 1].map(i => ({ sessionId: session!.id, role: "user" as const,
    content: `Prior failed input ${i}`, status: "failed" as const, errorMessage: "Synthetic previous failure", createdAt: new Date(Date.now() - 60000 + i),
  }))).returning();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const route of messageRoutes.routes) {
    if (route.method === "POST" && route.path === "/sessions/:sessionId/messages") app.post(route.path, route.handler);
    if (route.method === "DELETE" && route.path === "/messages/:id") app.delete(route.path, route.handler);
  }
  const send = (retryMessageId?: string) => app.request(`/sessions/${session!.id}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "Please continue.", model, ...(retryMessageId ? { retryMessageId } : {}) }),
  });
  duringStream = async () => {
    for (const old of oldRows) {
      const deleted = await app.request(`/messages/${old.id}`, { method: "DELETE" });
      assert.equal(deleted.status, 200, await deleted.text());
    }
  };
  const failed = await (await send()).text();
  assert.match(failed, /Session history changed while generating/);
  assert.match(failed, /event: error/);
  assert.doesNotMatch(failed, /event: done/);
  const remaining = await db.select().from(messages).where(eq(messages.sessionId, session!.id));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.status, "failed");
  assert.equal(remaining[0]!.role, "user");
  duringStream = undefined;
  const retry = await (await send(remaining[0]!.id)).text();
  assert.match(retry, /event: done/);
  assert.doesNotMatch(retry, /event: error/);
  const recovered = await db.select().from(messages).where(eq(messages.sessionId, session!.id));
  assert.equal(recovered.filter(row => row.role === "user").length, 1, "retry reuses the failed input");
  assert.equal(recovered.filter(row => row.role === "assistant").length, 1);
});
