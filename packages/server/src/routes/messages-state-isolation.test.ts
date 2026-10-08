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

test("send, regenerate, swipe, and continue preserve independent reply outcomes through concurrent writes", async t => {
  const priorKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "synthetic-test-key";
  t.after(() => { env.YUMINA_OPENROUTER_KEY = priorKey; });
  const model = "google/gemini-2.5-flash";
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 1 });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: model, context_length: 1048576, architecture: { input_modalities: ["text"] } },
  ] }));
  let attempt = 0;
  let duringStream: (() => Promise<void>) | undefined;
  const directives = ["[affection: add 3]", "[affection: add 1]", "[affection: subtract 2]", "[affection: add 8]", "", "[affection: add 5]", "[affection: add 13]"];
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* () {
    yield { type: "text" as const, content: `A different outcome for this action. ${directives[attempt++]}` };
    await duringStream?.();
    yield { type: "done" as const, content: "", stopReason: "end_turn", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
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
  const assertDone = async (response: Response) => {
    const stream = await response.text();
    assert.equal(response.status, 200, stream);
    assert.match(stream, /event: done/);
    assert.doesNotMatch(stream, /event: error/);
  };
  duringStream = async () => {
    const live = structuredClone(before);
    live.variables.character = { hp: 100, panel: true };
    await db.update(playSessions).set({ state: live as unknown as Record<string, unknown> }).where(eq(playSessions.id, session!.id));
  };
  await assertDone(await post(`/sessions/${session!.id}/messages`, { content: "I greet the character.", model }));
  duringStream = undefined;
  const reply = (await db.select().from(messages).where(eq(messages.sessionId, session!.id))).find(message => message.role === "assistant");
  assert.ok(reply, "the send route persists the original reply");
  assert.deepEqual(reply.swipes![0]!.generationState!.variables, before.variables);
  const sendAudit = reply.swipes![0]!.variableAudit!;
  assert.equal(sendAudit.segments[0]!.path, "send");
  assert.equal(sendAudit.segments[0]!.changes.find(c => c.variableId === "affection")!.newValue.value, 13);
  const [sentSession] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
  assert.equal((sentSession!.state.variables as Record<string, unknown>).affection, 13);
  assert.deepEqual((sentSession!.state.variables as Record<string, unknown>).character, { hp: 100, panel: true }, "ordinary send retains concurrent UI writes without adopting them into the baseline");
  const first = structuredClone(sentSession!.state);
  const request = (action: string, body: unknown) => post(`/messages/${reply.id}/${action}`, body);
  for (const expected of [11, 8, 18, 10]) {
    const dirty = structuredClone(first);
    (dirty.variables as Record<string, unknown>).affection = 99;
    (dirty.variables as Record<string, unknown>).character = { hp: 1, panel: true };
    await db.update(playSessions).set({ state: dirty as unknown as Record<string, unknown> }).where(eq(playSessions.id, session!.id));
    const response = await request("regenerate", { model });
    await assertDone(response);
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
    assert.equal((saved!.state.variables as Record<string, unknown>).affection, expected);
    assert.deepEqual((saved!.state.variables as Record<string, unknown>).character, before.variables.character);
  }
  const outcomes = [13, 11, 8, 18, 10];
  for (const index of [0, 4, 2, 1, 3]) {
    const response = await request("swipe", { index });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { data: { state: { variables: { affection: number } } } };
    assert.equal(body.data.state.variables.affection, outcomes[index]);
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
    assert.equal((saved!.state.variables as Record<string, unknown>).affection, outcomes[index]);
  }
  for (const [direction, expected] of [["left", 8], ["right", 18]] as const) {
    const response = await request("swipe", { direction });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { state: { variables: { affection: number } } } };
    assert.equal(body.data.state.variables.affection, expected);
  }
  const [savedReply] = await db.select().from(messages).where(eq(messages.id, reply!.id));
  assert.deepEqual(savedReply!.swipes!.map(s => (s.stateSnapshot!.variables as Record<string, unknown>).affection), outcomes);
  for (const swipe of savedReply!.swipes!) assert.deepEqual(swipe.generationState!.variables, before.variables);
  assert.deepEqual(savedReply!.swipes!.map(s => s.variableAudit!.segments.map(a => a.path)),
    [["send"], ["regenerate"], ["regenerate"], ["regenerate"], ["regenerate"]]);
  assert.deepEqual(savedReply!.swipes![0]!.variableAudit, sendAudit);

  // Continue the selected +8 alternative, retaining the original message's
  // pre-reply variables rather than making its outcome the reroll baseline.
  await assertDone(await post(`/sessions/${session!.id}/continue`, { model }));
  const [continuedReply] = await db.select().from(messages).where(eq(messages.id, reply.id));
  assert.equal(continuedReply!.activeSwipeIndex, 3);
  assert.equal((continuedReply!.swipes![3]!.stateSnapshot!.variables as Record<string, unknown>).affection, 23);
  assert.deepEqual(continuedReply!.swipes![3]!.generationState!.variables, before.variables);
  const continuationAudit = continuedReply!.swipes![3]!.variableAudit!;
  assert.deepEqual(continuationAudit.segments.map(s => s.path), ["regenerate", "continue"]);
  assert.equal(continuationAudit.segments[1]!.committed.find(c => c.variableId === "affection")!.value.value, 23);
  assert.deepEqual(continuedReply!.swipes!.filter((_, index) => index !== 3), savedReply!.swipes!.filter((_, index) => index !== 3));

  // The replacement also ends at 23. A concurrent patch must not win merely
  // because the final value equals the previously selected reply's value.
  let concurrentPatchApplied = false;
  duringStream = async () => {
    const [liveSession] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
    const live = structuredClone(liveSession!.state);
    (live.variables as Record<string, unknown>).affection = 99;
    (live.variables as Record<string, unknown>).character = { hp: 1, panel: true };
    await db.update(playSessions).set({ state: live }).where(eq(playSessions.id, session!.id));
    concurrentPatchApplied = true;
  };
  await assertDone(await request("regenerate", { model }));
  const [finalSession] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
  const [finalReply] = await db.select().from(messages).where(eq(messages.id, reply.id));
  assert.equal(concurrentPatchApplied, true);
  assert.equal((finalSession!.state.variables as Record<string, unknown>).affection, 23);
  assert.deepEqual((finalSession!.state.variables as Record<string, unknown>).character, before.variables.character);
  assert.deepEqual(finalReply!.swipes!.slice(0, 5), continuedReply!.swipes);
  assert.deepEqual(finalReply!.swipes![5]!.generationState!.variables, before.variables);
  assert.deepEqual(finalReply!.swipes![5]!.variableAudit!.segments.map(s => s.path), ["regenerate"]);
  assert.equal(finalSession!.state.turnCount, 1);
  assert.equal(attempt, directives.length);
});
