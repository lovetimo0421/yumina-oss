import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";
import { createStateGuardRoutes, stateGuardSettingsSchema } from "./state-update-guard.js";
import { registerStateUpdateGuard } from "../extensions/state-update-guard/hooks.js";
import { __setInstalledLookupForTests, resolveTurnHooks, turnOutputInstructions } from "../lib/extension-hooks.js";
import { edition } from "../edition/index.js";

test("settings validate explicit false and reset model but reject malformed/unknown fields", () => {
  assert.deepEqual(stateGuardSettingsSchema.parse({ model: "official::x-ai/grok-4.1" }), { model: "official::x-ai/grok-4.20" });
  assert.equal(stateGuardSettingsSchema.safeParse({ model: "private::custom/deepseek-v4-flash" }).success, true);
  for (const model of ["official::", "private::", "official::private::a", "unknown::a"]) assert.equal(stateGuardSettingsSchema.safeParse({ model }).success, false);
  for (const value of [{ enabled: false }, { model: null }, { model: "custom/deepseek-v4-flash" }]) assert.ok(stateGuardSettingsSchema.safeParse(value).success);
  for (const value of [{}, null, { enabled: "false" }, { model: "" }, { model: "a".repeat(200) }, { state: {} }, { model: "../ bad" }, { enabled: true, officialModels: true }]) assert.equal(stateGuardSettingsSchema.safeParse(value).success, false);
});

test("settings API persists per-chat choices without touching game state and guards owner/model access", async () => {
  const owner = `guard-owner-${crypto.randomUUID()}`;
  const stranger = `guard-other-${crypto.randomUUID()}`;
  let actor = owner; let installed = true; let available = true;
  const resolutions: unknown[][] = [];
  await db.insert(user).values([{ id: owner, name: "Owner", email: `${owner}@test.local` }, { id: stranger, name: "Other", email: `${stranger}@test.local` }]);
  const [world] = await db.insert(worlds).values({ creatorId: stranger, name: "Protected", allowCustomApi: false }).returning();
  const state = { variables: { hp: 81, energy: 63 } };
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state }).returning();
  const [otherChat] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state }).returning();
  const app = new Hono<AppEnv>();
  app.route("/api/sessions", createStateGuardRoutes({
    authenticate: async (c, next) => { if (!actor) return c.json({ error: "Unauthorized" }, 401); c.set("user", { id: actor } as never); await next(); },
    installed: async () => installed,
    resolveModel: async (...args) => { resolutions.push(args); if (!available) throw new Error("private secret must not escape"); return { model: args[1], apiKeyTier: "regular", maxContext: 32_000, provider: { async *generateStream() { throw new Error("settings never generate"); }, async listModels() { return []; } } }; },
  }));
  app.get("/api/sessions/other", (c) => c.json({ ok: true }));
  const url = `/api/sessions/${session!.id}/state-update-guard`;
  const patch = (body: unknown) => app.request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const read = async () => {
    const { data } = await (await app.request(url)).json() as { data: { enabled: boolean; model: string | null; officialModels?: boolean } };
    assert.equal(data.officialModels, edition.info().features.officialModels ? undefined : false);
    return { enabled: data.enabled, model: data.model };
  };
  try {
    assert.deepEqual(await read(), { enabled: true, model: null });
    assert.equal((await patch({ enabled: false })).status, 200);
    assert.equal(resolutions.length, 0, "turning off must not depend on a working provider");
    assert.equal((await patch({ model: "custom/repair" })).status, 200);
    assert.deepEqual(resolutions[0], [owner, "custom/repair", true], "protected world forces official routing");
    assert.deepEqual(await read(), { enabled: false, model: "custom/repair" });
    const [stored] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
    assert.deepEqual(stored!.state, state);
    assert.equal((await db.select().from(playSessions).where(eq(playSessions.id, otherChat!.id)))[0]!.stateGuardEnabled, true);
    available = false;
    const denied = await patch({ model: "unavailable/model", enabled: true });
    assert.equal(denied.status, 400); assert.doesNotMatch(await denied.text(), /private secret/);
    assert.deepEqual(await read(), { enabled: false, model: "custom/repair" }, "failed model selection is atomic");
    assert.equal((await patch({ model: null, enabled: true })).status, 200, "same-model reset needs no credentials");
    actor = stranger;
    assert.equal((await app.request(url)).status, 404); assert.equal((await patch({ enabled: false })).status, 404);
    actor = owner; installed = false;
    assert.equal((await app.request(url)).status, 403); assert.equal((await patch({ enabled: false })).status, 403);
    assert.equal((await app.request("/api/sessions/other")).status, 200, "extension gate cannot intercept other session routes");
    actor = "";
    assert.equal((await app.request(url)).status, 401);
  } finally { await db.delete(user).where(eq(user.id, owner)); await db.delete(user).where(eq(user.id, stranger)); }
});

test("guard off removes prompt and validation dispatch; old chats stay enabled; settings snapshot is immutable", async () => {
  registerStateUpdateGuard();
  __setInstalledLookupForTests(async () => new Set(["state-update-guard"]));
  try {
    const session = { stateGuardEnabled: true, stateGuardModel: "custom/correction" };
    const args = { ownerUserId: "owner", sessionId: "chat", session };
    const running = await resolveTurnHooks(args);
    session.stateGuardEnabled = false; session.stateGuardModel = "custom/new";
    assert.ok(running.activeExtensions.has("state-update-guard"));
    assert.equal(running.outputModels?.get("state-update-guard"), "custom/correction");
    const next = await resolveTurnHooks(args);
    assert.equal(next.activeExtensions.has("state-update-guard"), false);
    assert.equal(turnOutputInstructions(next), "");
    const legacy = await resolveTurnHooks({ ...args, session: {} });
    assert.ok(legacy.activeExtensions.has("state-update-guard"));
    assert.ok(turnOutputInstructions(legacy).includes("yumina-state"));
  } finally { __setInstalledLookupForTests(null); }
});

test("local settings responses expose BYOK-only capability without making it user-writable", async (t) => {
  const info = edition.info();
  t.mock.method(edition, "info", () => ({ ...info, features: { ...info.features, officialModels: false, billing: false } }));
  const owner = `guard-local-settings-${crypto.randomUUID()}`;
  await db.insert(user).values({ id: owner, name: "Local owner", email: `${owner}@test.local` });
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Local card" }).returning();
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: {} }).returning();
  const app = new Hono<AppEnv>();
  app.route("/api/sessions", createStateGuardRoutes({
    authenticate: async (c, next) => { c.set("user", { id: owner } as never); await next(); },
    installed: async () => true,
    resolveModel: async () => { throw new Error("toggle must not resolve a provider"); },
  }));
  const url = `/api/sessions/${session!.id}/state-update-guard`;
  try {
    assert.deepEqual(await (await app.request(url)).json(), { data: { enabled: true, model: null, officialModels: false } });
    const off = await app.request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await off.json(), { data: { enabled: false, model: null, officialModels: false } });
    const spoof = await app.request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, officialModels: true }) });
    assert.equal(spoof.status, 400);
  } finally { await db.delete(user).where(eq(user.id, owner)); }
});
