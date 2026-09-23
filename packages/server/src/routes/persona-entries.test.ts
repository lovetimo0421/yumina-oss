import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { db } from "../db/index.js";
import { user, userPersonas, worlds, playSessions } from "../db/schema.js";
import { personaRoutes } from "./personas.js";
import type { AppEnv } from "../lib/types.js";
import { buildPersonaSystemMessage } from "../lib/persona-prompt.js";
import { applyPersonaMetadataToState } from "../lib/persona-metadata.js";
import { setSessionPersona, resolvePersonaForSession } from "../lib/resolve-persona.js";
import { MAX_PERSONA_ENTRIES, MAX_PERSONA_ENTRY_CONTENT } from "@yumina/shared";

test("custom persona entries round-trip through API, preserve legacy patches, and follow the selected identity", async () => {
  const id = crypto.randomUUID();
  const other = crypto.randomUUID();
  await db.insert(user).values([id, other].map(uid => ({ id: uid, name: "Tester", email: `${uid}@test.local` })));
  let caller = id;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("user", { id: caller } as AppEnv["Variables"]["user"]); await next(); });
  // Authenticate a synthetic caller; exercise each real route's validation,
  // ownership filter and persistence without external auth/rate-limit services.
  for (const [method, path] of [["POST", "/"], ["PATCH", "/:id"], ["GET", "/:id"]]) {
    const handler = personaRoutes.routes.filter(route => route.method === method && route.path === path).at(-1)!;
    app.on(method!, path!, handler.handler);
  }
  const request = (path: string, method = "GET", body?: unknown) => app.request(path, {
    method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const read = async (response: Response) => await response.json() as { data: typeof userPersonas.$inferSelect };
  const entries = [{ title: "Abilities", content: "Fire only. Rest after three attacks." }, { title: "Weapons", content: "A steel sword." }];
  try {
    const create = await request("/", "POST", { name: "Alex", backstory: "Original story", note: "PRIVATE", entries });
    assert.equal(create.status, 201, await create.clone().text());
    const { data: persona } = await create.json() as { data: typeof userPersonas.$inferSelect };
    assert.deepEqual(persona.entries, entries);
    assert.deepEqual((await read(await request(`/${persona.id}`))).data.entries, entries);
    await request(`/${persona.id}`, "PATCH", { name: "Alex edited" });
    assert.deepEqual((await read(await request(`/${persona.id}`))).data.entries, entries, "old clients cannot erase entries by omission");
    for (const invalid of [null, {}, [{ title: "", content: "x" }], [{ title: "X", content: 12 }],
      [{ title: "X", content: "x".repeat(MAX_PERSONA_ENTRY_CONTENT + 1) }], Array(MAX_PERSONA_ENTRIES + 1).fill(entries[0]),
      Array(5).fill({ title: "X", content: "x".repeat(MAX_PERSONA_ENTRY_CONTENT) })]) {
      assert.equal((await request(`/${persona.id}`, "PATCH", { entries: invalid })).status, 400);
    }
    caller = other;
    assert.equal((await request(`/${persona.id}`, "PATCH", { entries: [] })).status, 404);
    caller = id;
    const [world] = await db.insert(worlds).values({ creatorId: id, name: "Test", schema: {} }).returning();
    const [session] = await db.insert(playSessions).values({ userId: id, worldId: world!.id }).returning();
    await setSessionPersona(id, session!.id, persona.id);
    const readSession = async () => (await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0]!;
    const selected = await resolvePersonaForSession(await readSession());
    assert.deepEqual(selected?.entries, entries);
    assert.match(buildPersonaSystemMessage(selected)!, /Weapons: A steel sword/);
    assert.doesNotMatch(buildPersonaSystemMessage(selected)!, /PRIVATE/);
    const state: { metadata?: Record<string, unknown> } = {};
    applyPersonaMetadataToState(state, selected, { username: "Tester" });
    assert.deepEqual(state.metadata?.personaEntries, entries);
    await request(`/${persona.id}`, "PATCH", { entries: [entries[1]] });
    assert.deepEqual((await resolvePersonaForSession(await readSession()))?.entries, [entries[1]], "locked sessions use current persona edits");
    await request(`/${persona.id}`, "PATCH", { entries: [] });
    assert.doesNotMatch(buildPersonaSystemMessage(await resolvePersonaForSession(await readSession()))!, /Weapons|Fire only/);
    applyPersonaMetadataToState(state, null, { username: "Tester" });
    assert.deepEqual(state.metadata?.personaEntries, [], "switching off the persona clears custom details");
    const legacy = await request("/", "POST", { name: "Legacy" });
    assert.deepEqual((await read(legacy)).data.entries, []);
  } finally {
    await db.delete(user).where(eq(user.id, id));
    await db.delete(user).where(eq(user.id, other));
  }
});

test("entries migration preserves existing personas and is safe to apply twice", async () => {
  const pg = new PGlite();
  try {
    await pg.exec("CREATE TABLE user_personas (name text, backstory text); INSERT INTO user_personas VALUES ('Existing', 'Keep me');");
    const migration = readFileSync(new URL("../../drizzle/0060_persona_entries.sql", import.meta.url), "utf8");
    await pg.exec(migration);
    await pg.exec(migration);
    assert.deepEqual((await pg.query("SELECT * FROM user_personas")).rows, [{ name: "Existing", backstory: "Keep me", entries: [] }]);
  } finally { await pg.close(); }
});
