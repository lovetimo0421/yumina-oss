import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions, userPrompts, worldPendingEdits } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { completionRoutes } from "./completions.js";

after(async () => { const client = (db as unknown as { $client: { closed?: boolean; close(): Promise<void> } }).$client; if (!client.closed) await client.close(); });

const worldSchema = (content: string) => ({ version: "21.0.0", name: "Actor test", entries: [{ id: "style", name: "Style", role: "style", section: "system-presets", content, alwaysSend: true, enabled: true, conditions: [], conditionLogic: "all", keywords: [], position: 0 }], variables: [{ id: "diary", name: "Diary", type: "string", defaultValue: "", aiAccess: "none" }], settings: { playerName: "6079" } });

test("actor context authenticates, resolves current owned schema and presets, protects privacy and stays read-only", async () => {
  const uid = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const [owner, other] = await db.insert(user).values([{ id: uid, name: "REAL_NAME_SENTINEL", email: `${uid}@test.local` }, { id: otherId, name: "Other", email: `${otherId}@test.local` }]).returning();
  let account: typeof owner | null = owner;
  const login = mock.method(auth.api, "getSession", async () => account ? ({ user: account, session: { id: "test-login", userId: account.id, expiresAt: new Date(Date.now() + 60000) } }) : null);
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Actor test", status: "published", schema: worldSchema("LIVE_STYLE {{user}} {{diary}} {{persona}} {{lastMessage}}") }).returning();
    const storedState = { variables: { diary: "DIARY_SENTINEL" }, metadata: { personaName: "PERSONA_SENTINEL", lastMessage: "HIDDEN_HISTORY_SENTINEL" }, turnCount: 7 };
    const [session, foreign] = await db.insert(playSessions).values([{ userId: uid, worldId: world!.id, state: storedState }, { userId: otherId, worldId: world!.id }]).returning();
    const [preset] = await db.insert(userPrompts).values({ userId: uid, name: "Personal Style", content: "ACCOUNT_STYLE", section: "system-presets", autoModels: ["claude"] }).returning();
    const request = (body: unknown = { actor: "voice", model: "anthropic/claude-sonnet-4" }, id = session!.id) => completionRoutes.request(`/sessions/${id}/actor-context`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const response = await request({ actor: "voice", model: "anthropic/claude-sonnet-4", recentMessages: [{ role: "user", content: "PUBLIC_WORDS" }] });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const result = await response.json() as { instructions: string; receipt: { personaPolicy: string; userPromptIds: string[] } };
    assert.match(result.instructions, /LIVE_STYLE 6079/);
    assert.match(result.instructions, /PUBLIC_WORDS/);
    assert.match(result.instructions, /ACCOUNT_STYLE/);
    assert.deepEqual(result.receipt.userPromptIds, [preset!.id]);
    assert.equal(result.receipt.personaPolicy, "world-player-name-only");
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL/);
    assert.deepEqual((await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0]!.state, storedState);

    assert.equal((await request(undefined, foreign!.id)).status, 404);
    for (const body of ["{", null, {}, { actor: "other" }, { actor: "voice", state: storedState }, { actor: "voice", recentMessages: [{ role: "system", content: "private" }] }, { actor: "voice", recentMessages: [{ role: "user", content: "x".repeat(4001) }] }]) {
      assert.equal((await request(body)).status, 400);
    }
    account = null;
    assert.equal((await request()).status, 401);
    account = owner;

    await db.insert(worldPendingEdits).values({ worldId: world!.id, createdBy: uid, groupKey: world!.id, schema: worldSchema("WORKING_STYLE") });
    assert.match(await (await request()).text(), /WORKING_STYLE/);
    await db.update(worldPendingEdits).set({ schema: worldSchema("EDITED_STYLE") }).where(eq(worldPendingEdits.worldId, world!.id));
    assert.match(await (await request()).text(), /EDITED_STYLE/);
    account = other;
    const liveResult = await request(undefined, foreign!.id);
    assert.match(await liveResult.text(), /LIVE_STYLE/);
    await db.update(worlds).set({ allowCustomApi: false }).where(eq(worlds.id, world!.id));
    const protectedResult = await request(undefined, foreign!.id);
    assert.equal(protectedResult.status, 403);
    assert.equal((await protectedResult.json() as { code: string }).code, "ACTOR_CONTEXT_PROTECTED");
    account = owner;
    await db.update(worldPendingEdits).set({ schema: worldSchema("x".repeat(9001)) }).where(eq(worldPendingEdits.worldId, world!.id));
    const overflow = await request();
    assert.equal(overflow.status, 422);
    assert.equal((await overflow.json() as { code: string }).code, "ACTOR_CONTEXT_TOO_LARGE");
  } finally { login.mock.restore(); await db.delete(user).where(eq(user.id, uid)); await db.delete(user).where(eq(user.id, otherId)); }
});
