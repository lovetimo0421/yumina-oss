import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions, userPersonas } from "../db/schema.js";
import { setSessionPersonaLock, resolvePersonaForSession } from "./resolve-persona.js";
import { personaIdentityReceipt, applyPersonaMetadataToState } from "./persona-metadata.js";

test("committed persona receipts match resolved identity; stale and concurrent writes cannot overwrite newer choices", async () => {
  const uid = crypto.randomUUID();
  const account = { username: "account", image: "account.png" };
  await db.insert(user).values({ id: uid, name: "Test", email: `${uid}@test.local`, ...account });
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Test", schema: {} }).returning();
    const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: { variables: { hp: 9 } } }).returning();
    const [a, b] = await db.insert(userPersonas).values([
      { userId: uid, name: "Same", isActive: true, note: "PRIVATE", appearance: "A", entries: [{ title: "Skill", content: "Fire" }] },
      { userId: uid, name: "Same", note: "PRIVATE B" },
    ]).returning();
    let version = "";
    for (const [locked, target] of [[true, b!.id], [true, null], [false, null]] as const) {
      const result = await setSessionPersonaLock(uid, session!.id, locked, target, version);
      assert.ok(result.data);
      const receipt = personaIdentityReceipt(session!.id, result.data, account);
      assert.equal(receipt.personaLocked, locked);
      assert.equal(receipt.sessionPersona.persona?.id ?? null, locked ? target : a!.id);
      assert.ok(receipt.sessionPersona.selectionVersion);
      assert.notEqual(receipt.sessionPersona.selectionVersion, version);
      version = receipt.sessionPersona.selectionVersion!;
      const [row] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
      const expected = { metadata: {} };
      applyPersonaMetadataToState(expected, await resolvePersonaForSession(row!), account);
      assert.deepEqual(receipt.state, expected);
      assert.equal(Object.keys(receipt.state.metadata).length, 7);
      assert.ok(!JSON.stringify(receipt).includes("PRIVATE"));
      assert.deepEqual(row!.state, { variables: { hp: 9 } });
    }
    // A request begun before those commits arrives late (e.g. after a timeout).
    assert.equal((await setSessionPersonaLock(uid, session!.id, true, b!.id, "")).error, "Persona selection changed");
    const concurrent = await Promise.all([
      setSessionPersonaLock(uid, session!.id, true, a!.id, version),
      setSessionPersonaLock(uid, session!.id, true, b!.id, version),
    ]);
    assert.equal(concurrent.filter((r) => r.data).length, 1);
    assert.equal(concurrent.filter((r) => r.error === "Persona selection changed").length, 1);
    const winner = concurrent.find((r) => r.data)!.data!;
    const [row] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
    assert.equal(row!.sessionPersona?.selectionVersion, winner.sessionPersona.selectionVersion);
    assert.equal((await resolvePersonaForSession(row!))?.id, winner.sessionPersona.persona?.id);
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});
