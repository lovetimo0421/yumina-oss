import "../test/database-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages, creditWallets, modelPrices } from "../db/schema.js";
import { messageRoutes } from "./messages.js";
import { normalizeGameState } from "../lib/game-state.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import type { ChatMessage } from "../lib/llm/types.js";
import { env } from "../lib/env.js";
import type { AppEnv } from "../lib/types.js";

// The per-turn state block (<game-state> / <last-turn-changes> /
// <state-reminder>) rides in the player's final message for the model
// families in lib/state-block-placement.ts, and stays its own system message
// for everyone else. Same session flow, two models, compared call by call.

type Call = { messages: ChatMessage[]; cacheBreakpoints?: number[] };

const STATE_TAG = "<game-state>";
const text = (m: ChatMessage) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const isStateMessage = (m: ChatMessage) => m.role === "system" && text(m).includes(STATE_TAG);

async function runFlow(t: import("node:test").TestContext, model: string) {
  const calls: Call[] = [];
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (params: Call) {
    calls.push({ messages: structuredClone(params.messages), cacheBreakpoints: params.cacheBreakpoints });
    yield { type: "text" as const, content: `She nods and the evening goes on. [affection: add 2]` };
    yield { type: "done" as const, content: "", stopReason: "end_turn", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
  });
  const uid = crypto.randomUUID();
  const worldId = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Placement test", email: `${uid}@test.local`, preferences: { preferredProvider: "official" } });
  await db.insert(creditWallets).values({ userId: uid, plan: "internal", balance: 100, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) });
  const world = migrateWorldDefinition({
    id: worldId, version: "19.0.0", name: "State placement", description: "", author: "test",
    entries: [], variables: [{ id: "affection", name: "affection", type: "number", defaultValue: 10, aiWritable: true }],
    rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: uid, name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
  const state = normalizeGameState(world, { turnCount: 0 });
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId, state: state as unknown as Record<string, unknown> }).returning();
  // Enough earlier turns that the history cache breakpoint lands inside the conversation.
  const base = Date.now() - 60_000;
  await db.insert(messages).values(Array.from({ length: 12 }, (_, i) => ({
    sessionId: session!.id, role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: i % 2 === 0 ? `Player line ${i}.` : `Narrator line ${i}.`, createdAt: new Date(base + i * 1000),
  })));
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: uid } as AppEnv["Variables"]["user"]); await next(); });
  for (const pattern of ["/sessions/:sessionId/messages", "/sessions/:sessionId/continue", "/messages/:id/regenerate"]) {
    for (const route of messageRoutes.routes.filter((r) => r.method === "POST" && r.path === pattern)) app.post(pattern, route.handler);
  }
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const stream = await response.text();
    assert.equal(response.status, 200, stream);
    assert.match(stream, /event: done/);
    assert.doesNotMatch(stream, /event: error/);
  };
  await post(`/sessions/${session!.id}/messages`, { content: "I offer her a cup of tea.", model });
  const stored = await db.select().from(messages).where(eq(messages.sessionId, session!.id)).orderBy(asc(messages.createdAt));
  const reply = stored.at(-1)!;
  assert.equal(reply.role, "assistant");
  await post(`/messages/${reply.id}/regenerate`, { model });
  await post(`/sessions/${session!.id}/continue`, { model });
  const after = await db.select().from(messages).where(eq(messages.sessionId, session!.id)).orderBy(asc(messages.createdAt));
  return { calls, stored: after };
}

test("deepseek gets the state block in the player's final message; gemini keeps its own system message", async (t) => {
  const priorKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-test-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = priorKey; });
  const gemini = "google/gemini-3.5-flash-lite";
  const deepseek = "deepseek/deepseek-v3.2";
  for (const id of [gemini, deepseek]) await db.insert(modelPrices).values({ modelId: id, inputPricePerM: 1, outputPricePerM: 1 });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [gemini, deepseek].map((id) => (
    { id, context_length: 1048576, architecture: { input_modalities: ["text"] } }
  )) }));

  const g = await runFlow(t, gemini);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [gemini, deepseek].map((id) => (
    { id, context_length: 1048576, architecture: { input_modalities: ["text"] } }
  )) }));
  const d = await runFlow(t, deepseek);
  assert.equal(g.calls.length, 3);
  assert.equal(d.calls.length, 3);

  for (const [i, path] of ["send", "regenerate"].entries()) {
    const gm = g.calls[i]!.messages;
    const dm = d.calls[i]!.messages;
    // Gemini: one separate state system message, the player's message untouched.
    const gState = gm.findIndex(isStateMessage);
    assert.ok(gState > 0, `${path}: gemini sends the state block as a system message`);
    const gLastUser = gm.map((m) => m.role).lastIndexOf("user");
    assert.equal(text(gm[gLastUser]!), "I offer her a cup of tea.", `${path}: gemini's player message is exactly what was typed`);
    assert.ok(gLastUser < gState);

    // DeepSeek: no state system message; the final player message ends with the block.
    assert.equal(dm.findIndex(isStateMessage), -1, `${path}: deepseek has no separate state message`);
    assert.equal(dm.length, gm.length - 1);
    const dLastUser = dm.map((m) => m.role).lastIndexOf("user");
    assert.equal(text(dm[dLastUser]!), `I offer her a cup of tea.\n\n${text(gm[gState]!)}`, `${path}: block appended after a blank line`);
    // Everything else is the same messages in the same order.
    const expected = gm.filter((_, j) => j !== gState).map((m, j) => (j === dLastUser ? dm[dLastUser]! : m));
    assert.deepEqual(dm, expected, `${path}: only the state block moved`);

    // Cache breakpoints mark the same messages, all before the extended one.
    const gBp = g.calls[i]!.cacheBreakpoints ?? [];
    const dBp = d.calls[i]!.cacheBreakpoints ?? [];
    assert.equal(gBp.length, 2, `${path}: stable prefix + history breakpoint`);
    assert.deepEqual(dBp, gBp, `${path}: breakpoints sit before the moved block, so indices are unchanged`);
    for (const bp of dBp) {
      assert.ok(bp < dLastUser, `${path}: breakpoint ${bp} precedes the extended message`);
      assert.deepEqual(dm[bp], gm[bp]);
    }
  }

  // Continue ends on the assistant's partial reply: unchanged for every model.
  const gc = g.calls[2]!.messages;
  const dc = d.calls[2]!.messages;
  assert.ok(gc.some(isStateMessage) && dc.some(isStateMessage), "continue keeps the state system message");
  assert.equal(gc.filter((m) => m.role === "user").some((m) => text(m).includes(STATE_TAG)), false);
  assert.equal(dc.filter((m) => m.role === "user").some((m) => text(m).includes(STATE_TAG)), false);
  assert.deepEqual(dc, gc);
  assert.deepEqual(d.calls[2]!.cacheBreakpoints, g.calls[2]!.cacheBreakpoints);

  // Stored history never carries the block.
  for (const row of d.stored) assert.doesNotMatch(row.content, /<game-state>|<state-reminder>/);
  assert.equal(d.stored.find((r) => r.content.startsWith("I offer her"))!.content, "I offer her a cup of tea.");
  // And the turn after reads the clean player line back from history.
  assert.equal(d.calls[1]!.messages.filter((m) => m.role === "user" && text(m).includes(STATE_TAG)).length, 1);
});
