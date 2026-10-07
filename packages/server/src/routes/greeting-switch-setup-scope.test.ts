import "../test/database-fixture.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions, user, worlds } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import type { AppEnv } from "../lib/types.js";
import { messageRoutes } from "./messages.js";
import { sessionRoutes } from "./sessions.js";

after(async () => {
  const client = (db as unknown as { $client: { closed?: boolean; close(): Promise<void> } }).$client;
  if (!client.closed) await client.close();
});

// Cast-picker cards (SEVENTEEN 模拟器, Stray Kids, ITZY, I-DLE…) write a
// setup-scoped variable through PATCH /sessions/:id/state and then switch the
// opening (POST /messages/:greeting/swipe {index}). The client now lands the
// PATCH first (chat-runtime.test.ts); this pins the server half of the contract:
// the switch adopts the opening's snapshot for ordinary variables but keeps the
// setup-scoped value that is already committed.
test("switching the opening keeps committed setup variables and resets the rest", { timeout: 60_000 }, async () => {
  const app = new Hono<AppEnv>();
  app.route("/api/sessions", sessionRoutes);
  app.route("/api", messageRoutes);

  const email = `${crypto.randomUUID()}@test.local`;
  const signUp = await auth.handler(new Request("http://localhost/api/auth/sign-up/email", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Cast Picker", email, password: "correct-horse-battery" }),
  }));
  assert.equal(signUp.status, 200, await signUp.clone().text());
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const [player] = await db.select().from(user).where(eq(user.email, email));

  const variables = [
    { id: "selected-members", name: "Cast", type: "json", defaultValue: [], scope: "setup" },
    { id: "affection", name: "Affection", type: "number", defaultValue: 0 },
  ];
  const [world] = await db.insert(worlds).values({
    creatorId: player!.id, name: "Cast Picker", status: "draft",
    schema: { id: "cast", name: "Cast Picker", entries: [], variables },
  }).returning();
  const opening = (affection: number) => ({ worldId: world!.id, turnCount: 0, metadata: {},
    variables: { "selected-members": [], affection } });
  const [session] = await db.insert(playSessions).values({
    userId: player!.id, worldId: world!.id, state: opening(0), name: "main",
  }).returning();
  const [greeting] = await db.insert(messages).values({
    sessionId: session!.id, role: "assistant", content: "Opening A", stateSnapshot: opening(0),
    activeSwipeIndex: 0,
    swipes: [
      { content: "Opening A", stateSnapshot: opening(0), createdAt: new Date().toISOString() },
      { content: "Opening B", stateSnapshot: opening(50), createdAt: new Date().toISOString() },
    ],
  }).returning();

  const call = (path: string, method: string, body: unknown) => app.request(path, {
    method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body),
  });

  const cast = ["S.Coups", "Jeonghan"];
  const patch = await call(`/api/sessions/${session!.id}/state`, "PATCH",
    { state: { variables: { "selected-members": cast, affection: 7 } } });
  assert.equal(patch.status, 200, await patch.clone().text());

  const swipe = await call(`/api/messages/${greeting!.id}/swipe`, "POST", { index: 1 });
  assert.equal(swipe.status, 200, await swipe.clone().text());
  const { data } = await swipe.json() as { data: { state: { variables: Record<string, unknown> } } };
  assert.deepEqual(data.state.variables["selected-members"], cast, "setup pick survives the switch");
  assert.equal(data.state.variables.affection, 50, "ordinary variables take the opening's value");

  const [stored] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
  const storedVars = (stored!.state as { variables: Record<string, unknown> }).variables;
  assert.deepEqual(storedVars["selected-members"], cast);
  assert.equal(storedVars.affection, 50);

  // Switching back keeps the pick too.
  const back = await call(`/api/messages/${greeting!.id}/swipe`, "POST", { index: 0 });
  const backData = (await back.json() as { data: { state: { variables: Record<string, unknown> } } }).data;
  assert.deepEqual(backData.state.variables["selected-members"], cast);
  assert.equal(backData.state.variables.affection, 0);

  await db.delete(user).where(eq(user.id, player!.id));
});
