import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { sql } from "drizzle-orm";

Object.assign(process.env, { DATABASE_URL: "", DATABASE_READ_URL: "", PGLITE_DATA_DIR: "memory://",
  BETTER_AUTH_SECRET: "isolated-persona-routes-test-secret", REDIS_URL: "", POSTHOG_API_KEY: "", NODE_ENV: "test" });
const { db } = await import("../db/index.js");
const { auth } = await import("../lib/auth.js");
const { personaRoutes } = await import("./personas.js");
const { resolvePersonaForWorld } = await import("../lib/resolve-persona.js");

before(async () => {
  await db.execute(sql`CREATE TABLE "user" (id text PRIMARY KEY, name text, username text,
    display_username text, email text, email_verified boolean, image text, created_at timestamp,
    updated_at timestamp, role text, is_suspended boolean, is_muted boolean, muted_until timestamp,
    is_banned boolean, tier text, skip_review boolean)`);
  await db.execute(sql`CREATE TABLE worlds (id text PRIMARY KEY)`);
  await db.execute(sql`CREATE TABLE user_personas (id text PRIMARY KEY, user_id text, name text,
    avatar_url text, appearance text, personality text, backstory text, note text, is_active boolean,
    created_at timestamp, updated_at timestamp)`);
  await db.execute(sql`CREATE TABLE user_world_personas (user_id text REFERENCES "user"(id) ON DELETE CASCADE,
    world_id text REFERENCES worlds(id) ON DELETE CASCADE,
    persona_id text REFERENCES user_personas(id) ON DELETE CASCADE,
    created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), UNIQUE(user_id, world_id))`);
  // Stub only session verification; the actual auth middleware still loads
  // the user from the isolated DB and every route executes its real queries.
  mock.method(auth.api, "getSession", async ({ headers }: { headers: Headers }) => {
    const id = headers.get("X-Test-User");
    if (!id) return null;
    return { user: { id }, session: { id: "test-session", userId: id,
      expiresAt: new Date(Date.now() + 60_000), token: "test-token" } };
  });
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE "user", worlds, user_personas, user_world_personas`);
  await db.execute(sql`INSERT INTO "user" (id, name, role) VALUES ('tester','Tester','user'), ('stranger','Stranger','user')`);
  await db.execute(sql`INSERT INTO worlds VALUES ('world'), ('other-world')`);
  await db.execute(sql`INSERT INTO user_personas (id,user_id,name,is_active) VALUES
    ('A','tester','Persona A',true), ('B','tester','Persona B',false), ('foreign','stranger','Foreign',true)`);
});
after(async () => {
  mock.restoreAll();
  await (db as unknown as { $client: { close(): Promise<void> } }).$client.close();
});

function call(path: string, method = "GET", body?: unknown, actor = "tester") {
  return personaRoutes.request(path, {
    method, headers: { "Content-Type": "application/json", ...(actor ? { "X-Test-User": actor } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function binding(actor = "tester") {
  const res = await call("/binding/world", "GET", undefined, actor);
  assert.equal(res.status, 200);
  return (await res.json() as { data: { personaId: string | null } }).data.personaId;
}

test("settings activation and disabling control every world despite historical pins", async () => {
  await db.execute(sql`INSERT INTO user_world_personas (user_id,world_id,persona_id) VALUES ('tester','world','A')`);
  assert.equal((await call("/B/activate", "POST")).status, 200);
  for (const world of ["world", "other-world"]) assert.equal((await resolvePersonaForWorld("tester", world))?.id, "B");
  assert.equal((await call("/deactivate", "POST")).status, 200);
  assert.equal(await resolvePersonaForWorld("tester", "world"), null);
  assert.equal((await resolvePersonaForWorld("stranger", null))?.id, "foreign");
  assert.equal((await db.execute(sql`SELECT * FROM user_world_personas`)).rows.length, 1, "historical data is not deleted");
});

test("legacy world selection updates the same profile and removing a pin keeps that choice", async () => {
  assert.equal((await call("/binding/world", "PUT", { personaId: "B" })).status, 200);
  assert.equal((await resolvePersonaForWorld("tester", "other-world"))?.id, "B");
  assert.equal(await binding(), null, "legacy reads advertise following the profile");
  assert.equal((await call("/binding/world", "DELETE")).status, 200);
  assert.equal((await resolvePersonaForWorld("tester", null))?.id, "B");
});

test("invalid, foreign and malformed selections preserve the active persona", async () => {
  for (const body of [null, {}, [], { personaId: null }, { personaId: 5 }]) {
    assert.equal((await call("/binding/world", "PUT", body)).status, 400);
  }
  const malformed = await personaRoutes.request("/binding/world", {
    method: "PUT", headers: { "Content-Type": "application/json", "X-Test-User": "tester" }, body: "{",
  });
  assert.equal(malformed.status, 400);
  for (const id of ["foreign", "missing"]) {
    assert.equal((await call(`/${id}/activate`, "POST")).status, 404);
    assert.equal((await call("/binding/world", "PUT", { personaId: id })).status, 404);
  }
  assert.equal((await resolvePersonaForWorld("tester", null))?.id, "A");
});

test("settings and legacy endpoints require authentication", async () => {
  for (const [path, method] of [["/binding/world", "GET"], ["/binding/world", "PUT"], ["/binding/world", "DELETE"], ["/B/activate", "POST"], ["/deactivate", "POST"]]) {
    for (const actor of ["", "deleted-user"]) {
      assert.equal((await call(path!, method, method === "PUT" ? { personaId: "A" } : undefined, actor)).status, 401);
    }
  }
});
