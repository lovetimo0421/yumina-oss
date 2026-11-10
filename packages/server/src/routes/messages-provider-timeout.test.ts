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

import { stopSessionStream } from "../lib/stream-registry.js";

test("provider progress timeout finishes send, regenerate and continue without losing dialogue", async t => {
  const priorKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-test-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = priorKey; });
  const model = "google/gemini-3.5-flash-lite";
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 1 });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: model, context_length: 1048576, architecture: { input_modalities: ["text"] } },
  ] }));

  let calls = 0;
  const error = "DeepSeek response timeout: no model output for 90 seconds. The request was stopped and was not automatically resent.";
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* () {
    calls++;
    yield { type: "error" as const, content: error };
  });
  const uid = crypto.randomUUID(); const worldId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Isolation test", email: `${uid}@test.local`, preferences: { preferredProvider: "official" } });
  // The fixture database is isolated to this file. Keep its user alive until
  // background quest writes finish instead of racing them with row deletion.
  await db.insert(creditWallets).values({ userId: uid, plan: "internal", balance: 100, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) });
  const world = migrateWorldDefinition({ id: worldId, version: "19.0.0", name: "Independent outcomes", description: "", author: "test",
    entries: [], variables: [
      { id: "affection", name: "affection", type: "number", defaultValue: 10, aiWritable: true },
      { id: "character", name: "character", type: "json", defaultValue: { hp: 100, panel: false } },
    ], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const before = normalizeGameState(world, { turnCount: 0 });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId, state: before as unknown as Record<string, unknown> }).returning();
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const pattern of ["/sessions/:sessionId/messages", "/sessions/:sessionId/continue", "/messages/:id/regenerate", "/messages/:id/swipe"]) {
    for (const route of messageRoutes.routes.filter(r => r.method === "POST" && r.path === pattern)) app.post(pattern, route.handler);
  }
  const post = (path: string, body: unknown) => app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  const [existing] = await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content: "Existing story", status: "complete" }).returning();
  const actions = [
    [`/messages/${existing!.id}/regenerate`, { model }],
    [`/sessions/${session!.id}/continue`, { model }],
    [`/sessions/${session!.id}/messages`, { content: "Hello", model }],
  ] as const;
  for (const [path, body] of actions) {
    const response = await post(path, body);
    const output = await response.text();
    assert.equal(response.status, 200, output);
    assert.match(output, /event: error/);
    assert.ok(output.includes(error), output);
    assert.equal(stopSessionStream(session!.id), false, "terminal error unregisters the stream");
    const [saved] = await db.select().from(messages).where(eq(messages.id, existing!.id));
    assert.equal(saved!.content, "Existing story");
  }
  assert.equal(calls, 3, "each action makes exactly one model call");
});
