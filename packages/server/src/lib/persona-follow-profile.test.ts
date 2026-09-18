import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { sql } from "drizzle-orm";
import { captureSessionPersona } from "./session-persona.js";
import { applyPersonaMetadataToState } from "./persona-metadata.js";
import { buildPersonaSystemMessage } from "./persona-prompt.js";
import { buildSocialReplyPrompt } from "./social-reply-prompt.js";

Object.assign(process.env, { DATABASE_URL: "", DATABASE_READ_URL: "", PGLITE_DATA_DIR: "memory://",
  BETTER_AUTH_SECRET: "isolated-persona-test-secret", REDIS_URL: "", POSTHOG_API_KEY: "", NODE_ENV: "test" });
const { db } = await import("../db/index.js");
const { resolvePersonaForWorld, resolvePersonaForSession, setSessionPersona, setSessionPersonaLock } = await import("./resolve-persona.js");
const A = { id: "A", name: "Persona A", appearance: "A_LOOK", personality: "A_TRAIT", backstory: "A_STORY" };
const B = { id: "B", name: "Persona B", appearance: "B_LOOK", personality: "B_TRAIT", backstory: "B_STORY" };
async function session(id: string) {
  const result = await db.execute(sql`SELECT id, user_id AS "userId", state, session_persona AS "sessionPersona", persona_locked AS "personaLocked" FROM play_sessions WHERE id=${id}`);
  return result.rows[0] as Parameters<typeof resolvePersonaForSession>[0];
}
before(async () => {
  await db.execute(sql`CREATE TABLE play_sessions (id text PRIMARY KEY, user_id text, state jsonb, session_persona jsonb, persona_locked boolean NOT NULL DEFAULT false, updated_at timestamp)`);
  await db.execute(sql`CREATE TABLE user_personas (id text PRIMARY KEY, user_id text, name text, avatar_url text, appearance text, personality text, backstory text, note text, is_active boolean, created_at timestamp, updated_at timestamp)`);
  await db.execute(sql`CREATE TABLE user_world_personas (user_id text, world_id text, persona_id text, created_at timestamp, updated_at timestamp)`);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE play_sessions, user_personas, user_world_personas`);
  for (const p of [A, B]) {
    await db.execute(sql`INSERT INTO user_personas VALUES (${p.id}, 'tester', ${p.name}, '', ${p.appearance}, ${p.personality}, ${p.backstory}, 'PRIVATE NOTE', ${p.id === 'A'}, now(), now())`);
    await db.execute(sql`INSERT INTO play_sessions VALUES (${p.id}, 'tester', '{"variables":{"hp":9},"metadata":{"personaName":"Old"}}', ${JSON.stringify(captureSessionPersona(p))}::jsonb, false, now())`);
  }
  await db.execute(sql`INSERT INTO user_world_personas VALUES ('tester','world','B',now(),now())`);
});
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

test("profile selection controls new and existing chats despite stale pins and snapshots", async () => {
  for (const expected of [A, B, A]) {
    await db.execute(sql`UPDATE user_personas SET is_active=(id=${expected.id}) WHERE user_id='tester'`);
    assert.equal((await resolvePersonaForWorld("tester", "world"))?.id, expected.id);
    for (const id of ["A", "B"]) {
      const saved = await session(id);
      const actual = await resolvePersonaForSession(saved);
      assert.equal(actual?.id, expected.id);
      const displayed = structuredClone(saved.state);
      applyPersonaMetadataToState(displayed, actual, { username: "tester" });
      assert.equal((displayed.metadata as Record<string, unknown>).personaName, expected.name);
      assert.deepEqual(displayed.variables, { hp: 9 });
      const prompt = buildPersonaSystemMessage(actual)!;
      assert.ok(prompt.includes(expected.backstory));
      assert.ok(!prompt.includes("PRIVATE NOTE"));
      for (const kind of ["post", "message", "refresh"] as const) {
        const social = buildSocialReplyPrompt({ id: "job", targetId: "target", kind, members: ["character"], status: "running" }, [], actual);
        assert.ok(social.includes(expected.backstory));
        assert.ok(!social.includes("PRIVATE NOTE"));
      }
      assert.deepEqual(await session(id), saved, "resolution must not rewrite gameplay/history");
    }
  }
});

test("legacy and no-persona snapshots follow the current profile without migration", async () => {
  await db.execute(sql`UPDATE play_sessions SET session_persona=NULL WHERE id='A'`);
  await db.execute(sql`UPDATE play_sessions SET session_persona='{"persona":null}' WHERE id='B'`);
  assert.equal((await resolvePersonaForSession(await session("A")))?.id, "A");
  assert.equal((await resolvePersonaForSession(await session("B")))?.id, "A");
});

test("in-chat selection updates the profile and previously loaded sessions", async () => {
  const stale = await session("A");
  const result = await setSessionPersona("tester", "B", "B");
  assert.equal(result.data?.persona?.id, "B");
  assert.ok(!JSON.stringify(result).includes("PRIVATE NOTE"));
  assert.equal((await resolvePersonaForSession(stale))?.id, "B");
  assert.equal((await resolvePersonaForWorld("tester", "world"))?.id, "B");
});

test("a locked session stays on its persona while unlocked sessions follow profile changes", async () => {
  const lockResult = await setSessionPersonaLock("tester", "A", true, "B");
  assert.equal(lockResult.data?.personaLocked, true);
  assert.equal(lockResult.data?.sessionPersona.persona?.id, "B");
  assert.ok(!JSON.stringify(lockResult).includes("PRIVATE NOTE"));
  assert.equal((await resolvePersonaForSession(await session("A")))?.id, "B");

  await setSessionPersona("tester", "B", "A");
  assert.equal((await resolvePersonaForSession(await session("A")))?.id, "B", "locked session stays on B");
  assert.equal((await resolvePersonaForSession(await session("B")))?.id, "A", "unlocked session follows A");

  await db.execute(sql`UPDATE user_personas SET backstory='B_EDITED' WHERE id='B'`);
  assert.equal((await resolvePersonaForSession(await session("A")))?.backstory, "B_EDITED", "lock follows edits to the same persona ID");

  const unlocked = await setSessionPersonaLock("tester", "A", false);
  assert.equal(unlocked.data?.personaLocked, false);
  assert.equal((await resolvePersonaForSession(await session("A")))?.id, "A", "unlock immediately resumes following the profile");
});

test("locking explicit no-persona is independent from the account selection", async () => {
  await setSessionPersonaLock("tester", "A", true, null);
  assert.equal(await resolvePersonaForSession(await session("A")), null);
  assert.equal((await resolvePersonaForSession(await session("B")))?.id, "A");
});

test("selection and disabling are owner scoped; invalid selections preserve the current persona", async () => {
  await db.execute(sql`INSERT INTO user_personas (id,user_id,name,is_active) VALUES ('foreign','stranger','Foreign',true)`);
  assert.deepEqual(await setSessionPersona("stranger", "A", "B"), { error: "Session not found" });
  assert.deepEqual(await setSessionPersona("tester", "missing", null), { error: "Session not found" });
  assert.deepEqual(await setSessionPersona("tester", "A", "foreign"), { error: "Persona not found" });
  assert.deepEqual(await setSessionPersonaLock("stranger", "A", true, "foreign"), { error: "Session not found" });
  assert.deepEqual(await setSessionPersonaLock("tester", "missing", true, "A"), { error: "Session not found" });
  assert.deepEqual(await setSessionPersonaLock("tester", "A", true, "foreign"), { error: "Persona not found" });
  assert.equal((await resolvePersonaForSession(await session("A")))?.id, "A");
  assert.deepEqual(await setSessionPersona("tester", "A", null), { data: { persona: null } });
  for (const id of ["A", "B"]) assert.equal(await resolvePersonaForSession(await session(id)), null);
  assert.equal(await resolvePersonaForWorld("tester", "world"), null);
  assert.equal((await resolvePersonaForWorld("stranger", null))?.id, "foreign");
});

test("profile edits and deletion take effect without resurrecting cached details", async () => {
  await db.execute(sql`UPDATE user_personas SET backstory='CHANGED' WHERE id='A'`);
  assert.equal((await resolvePersonaForSession(await session("B")))?.backstory, "CHANGED");
  await db.execute(sql`DELETE FROM user_personas WHERE id='A'`);
  const actual = await resolvePersonaForSession(await session("A"));
  assert.equal(actual, null);
  assert.equal(buildPersonaSystemMessage(actual), null);
});

test("same-named personas switch by ID and replace the prompt's public details", async () => {
  await db.execute(sql`UPDATE user_personas SET name='月月' WHERE user_id='tester'`);
  await setSessionPersona("tester", "A", "B");
  const actual = await resolvePersonaForSession(await session("A"));
  assert.equal(actual?.id, "B");
  assert.equal(actual?.name, "月月");
  const prompt = buildPersonaSystemMessage(actual)!;
  assert.ok(prompt.includes("B_STORY"));
  assert.ok(!prompt.includes("A_STORY"));
});
