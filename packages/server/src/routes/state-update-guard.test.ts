import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { GameStateManager, type WorldDefinition } from "@yumina/engine";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions, userExtensions } from "../db/schema.js";
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
    // This card has no AI-writable variables, so the default does not apply.
    assert.equal((await app.request(url)).status, 403); assert.equal((await patch({ enabled: false })).status, 403);
    assert.equal((await app.request("/api/sessions/other")).status, 200, "extension gate cannot intercept other session routes");
    actor = "";
    assert.equal((await app.request(url)).status, 401);
  } finally { await db.delete(user).where(eq(user.id, owner)); await db.delete(user).where(eq(user.id, stranger)); }
});

test("never-installed players of a default-guarded card may only switch it per chat", async (t) => {
  const info = edition.info();
  t.mock.method(edition, "info", () => ({ ...info, features: { ...info.features, officialModels: true } }));
  const owner = `guard-default-owner-${crypto.randomUUID()}`;
  await db.insert(user).values({ id: owner, name: "Default owner", email: `${owner}@test.local` });
  const schema = { id: "stateful", version: "1.0.0", name: "Stateful", description: "", author: "unit",
    entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: {},
    variables: [{ id: "hp", name: "Health", type: "number", defaultValue: 100 }] };
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Stateful", schema }).returning();
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: {} }).returning();
  const resolutions: unknown[] = [];
  const app = new Hono<AppEnv>();
  app.route("/api/sessions", createStateGuardRoutes({
    authenticate: async (c, next) => { c.set("user", { id: owner } as never); await next(); },
    installed: async () => false,
    resolveModel: async (...args) => { resolutions.push(args); throw new Error("default players never pick a model"); },
  }));
  const url = `/api/sessions/${session!.id}/state-update-guard`;
  const patch = (body: unknown) => app.request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const saved = process.env.STATE_UPDATE_GUARD_DEFAULT;
  delete process.env.STATE_UPDATE_GUARD_DEFAULT;
  try {
    assert.equal((await app.request(url)).status, 403, "the guard is opt-in: no default settings unless switched on");
    process.env.STATE_UPDATE_GUARD_DEFAULT = "on";
    const read = await app.request(url);
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json() as { data: unknown }).data, { enabled: true, model: null, byDefault: true });
    const off = await patch({ enabled: false });
    assert.equal(off.status, 200);
    assert.deepEqual((await off.json() as { data: unknown }).data, { enabled: false, model: null, byDefault: true });
    assert.equal((await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0]!.stateGuardEnabled, false);
    assert.equal((await patch({ model: "official::paid/model" })).status, 403);
    assert.equal((await patch({ model: null, enabled: true })).status, 403, "the model column is an installed-extension setting");
    assert.equal(resolutions.length, 0);
    process.env.STATE_UPDATE_GUARD_DEFAULT = "off";
    assert.equal((await app.request(url)).status, 403, "kill switch removes the default settings too");
    process.env.STATE_UPDATE_GUARD_DEFAULT = "on";
    await db.insert(userExtensions).values({ userId: owner, extensionKey: "state-update-guard", status: "uninstalled", uninstalledAt: new Date() });
    assert.equal((await app.request(url)).status, 403, "an explicit uninstall is already an opt-out");
    assert.equal((await patch({ enabled: true })).status, 403);
  } finally {
    if (saved === undefined) delete process.env.STATE_UPDATE_GUARD_DEFAULT; else process.env.STATE_UPDATE_GUARD_DEFAULT = saved;
    await db.delete(user).where(eq(user.id, owner));
  }
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
    const world: WorldDefinition = { id: "settings-prompt", version: "1.0.0", name: "Settings prompt", description: "", author: "unit",
      entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 4000, temperature: 1 },
      variables: [{ id: "hp", name: "health", type: "number", defaultValue: 100 }] };
    const promptContext = { world, state: new GameStateManager(world).getSnapshot() };
    assert.equal(turnOutputInstructions(next, promptContext), "");
    const legacy = await resolveTurnHooks({ ...args, session: {} });
    assert.ok(legacy.activeExtensions.has("state-update-guard"));
    assert.ok(turnOutputInstructions(legacy, promptContext).includes("yumina-state"));
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
