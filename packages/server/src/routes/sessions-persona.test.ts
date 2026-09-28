import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, userPersonas } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { sessionRoutes } from "./sessions.js";
import type { personaIdentityReceipt } from "../lib/persona-metadata.js";
type IdentityResponse = { data: ReturnType<typeof personaIdentityReceipt> & { persona?: null } };

after(async () => { const client = (db as unknown as { $client: { closed?: boolean; close(): Promise<void> } }).$client; if (!client.closed) await client.close(); });

test("session HTTP create, lock, conflict, reload, explicit none and unlock use one committed identity", async () => {
  const uid = crypto.randomUUID();
  const [account] = await db.insert(user).values({ id: uid, name: "Account", username: `u${uid}`, email: `${uid}@test.local` }).returning();
  // Replace only proof of login; real ownership middleware, routes and DB run.
  const login = mock.method(auth.api, "getSession", async () => ({ user: account, session: { id: "test-login", userId: uid, expiresAt: new Date(Date.now() + 60000) } }));
  const request = (path: string, method = "GET", body?: object) => sessionRoutes.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Test", schema: { name: "Test", entries: [], variables: [], firstMessage: "Hello {{user}}" } }).returning();
    const [a, b] = await db.insert(userPersonas).values([{ userId: uid, name: "A", isActive: true, note: "SECRET" }, { userId: uid, name: "B", appearance: "B appearance", entries: [{ title: "Title", content: "Public" }] }]).returning();
    const created = await request("/", "POST", { worldId: world!.id, ephemeral: true });
    assert.equal(created.status, 201, await created.clone().text());
    const { data: initial } = await created.json() as IdentityResponse;
    assert.equal(initial.sessionPersona.persona?.id, a!.id);
    assert.equal(initial.state.metadata.personaName, "A");
    const id = initial.id;
    const put = await request(`/${id}/persona-lock`, "PUT", { locked: true, personaId: b!.id, expectedVersion: "" });
    assert.equal(put.status, 200);
    const { data: receipt } = await put.json() as IdentityResponse;
    assert.equal(receipt.sessionPersona.persona?.id, b!.id);
    assert.equal(receipt.state.metadata.personaAppearance, "B appearance");
    assert.ok(receipt.sessionPersona.selectionVersion);
    assert.equal((await request(`/${id}/persona-lock`, "PUT", { locked: true, personaId: a!.id, expectedVersion: "" })).status, 409);
    const loaded = await request(`/${id}`);
    assert.equal(loaded.status, 200);
    const { data: reloaded } = await loaded.json() as IdentityResponse;
    assert.deepEqual(reloaded.sessionPersona, receipt.sessionPersona);
    for (const [key, value] of Object.entries(receipt.state.metadata)) assert.deepEqual(reloaded.state.metadata[key], value);
    const none = await request(`/${id}/persona`, "PUT", { personaId: null, expectedVersion: receipt.sessionPersona.selectionVersion });
    assert.equal(none.status, 200);
    const { data: empty } = await none.json() as IdentityResponse;
    assert.equal(empty.persona, null, "legacy response shape remains available");
    assert.equal(empty.sessionPersona.persona, null);
    assert.equal(empty.state.metadata.personaName, account!.username);
    assert.deepEqual(empty.state.metadata.personaEntries, []);
    const unlock = await request(`/${id}/persona-lock`, "PUT", { locked: false, expectedVersion: empty.sessionPersona.selectionVersion });
    assert.equal(unlock.status, 200);
    const { data: following } = await unlock.json() as IdentityResponse;
    assert.equal(following.sessionPersona.persona?.id, a!.id);
    assert.equal(following.personaLocked, false);
    assert.ok(!JSON.stringify(following).includes("SECRET"));
    assert.equal((await request(`/${id}/persona-lock`, "PUT", { locked: true, personaId: a!.id, expectedVersion: 2 })).status, 400);
    assert.equal((await request(`/${crypto.randomUUID()}/persona-lock`, "PUT", { locked: false, expectedVersion: "" })).status, 404);
  } finally { login.mock.restore(); await db.delete(user).where(eq(user.id, uid)); }
});
