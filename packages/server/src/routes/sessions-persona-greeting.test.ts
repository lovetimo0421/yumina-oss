import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions, user, userPersonas, worlds } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { sessionRoutes } from "./sessions.js";

after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

test("HTTP create, persona change and restart render every opening from its own preset", async t => {
  const uid = crypto.randomUUID();
  const [account] = await db.insert(user).values({ id: uid, name: "Account", email: `${uid}@example.test` }).returning();
  t.mock.method(auth.api, "getSession", async () => ({ user: account,
    session: { id: "greeting-login", userId: uid, expiresAt: new Date(Date.now() + 60_000) } }));
  const request = (path: string, method = "GET", body?: object) => sessionRoutes.request(path, {
    method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Preset opening", schema: {
      name: "Preset opening", variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 10 }],
      entries: [20, 30].map((hp, index) => ({ id: `opening-${index}`, role: "greeting", enabled: true,
        position: index, content: "{{user}}: {{persona_backstory}} / HP {{hp}}", initialVariables: { hp } })),
    } }).returning();
    const [, replacement] = await db.insert(userPersonas).values([
      { userId: uid, name: "A", backstory: "OldMarker", isActive: true },
      { userId: uid, name: "B", backstory: "NewMarker" },
    ]).returning();
    const created = await request("/", "POST", { worldId: world!.id, ephemeral: true });
    assert.equal(created.status, 201, await created.clone().text());
    const sessionId = (await created.json() as { data: { id: string } }).data.id;
    const assertOpening = async (persona: "A" | "B") => {
      const rows = await db.select().from(messages).where(eq(messages.sessionId, sessionId));
      assert.equal(rows.length, 1);
      const opening = rows[0]!;
      const marker = persona === "A" ? "OldMarker" : "NewMarker";
      assert.equal(opening.content, `${persona}: ${marker} / HP 20`);
      assert.deepEqual(opening.swipes?.map(swipe => swipe.content), [20, 30].map(hp => `${persona}: ${marker} / HP ${hp}`));
      assert.deepEqual(opening.swipes?.map(swipe => (swipe.stateSnapshot?.variables as Record<string, unknown>)?.hp), [20, 30]);
      const [session] = await db.select().from(playSessions).where(eq(playSessions.id, sessionId));
      assert.equal((session!.state.variables as Record<string, unknown>).hp, 20);
      assert.equal((session!.state.metadata as Record<string, unknown>).personaName, persona);
    };
    await assertOpening("A");
    const changed = await request(`/${sessionId}/persona-lock`, "PUT", { locked: true, personaId: replacement!.id, expectedVersion: "" });
    assert.equal(changed.status, 200, await changed.clone().text());
    const receipt = await changed.json() as { data: { greeting: { content: string } } };
    assert.equal(receipt.data.greeting.content, "B: NewMarker / HP 20");
    await assertOpening("B");
    const reloaded = await request(`/${sessionId}`);
    assert.equal(reloaded.status, 200, await reloaded.clone().text());
    assert.equal((await reloaded.json() as { data: { messages: { content: string }[] } }).data.messages[0]!.content, "B: NewMarker / HP 20");
    await db.insert(messages).values({ sessionId, role: "user", content: "Played history before restart" });
    const restarted = await request(`/${sessionId}/restart`, "POST");
    assert.equal(restarted.status, 200, await restarted.clone().text());
    await assertOpening("B");
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});
