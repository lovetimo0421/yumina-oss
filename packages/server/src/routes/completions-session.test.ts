import assert from "node:assert/strict";
import test, { before } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { migrateWorldDefinition, type WorldDefinition, type WorldEntry } from "@yumina/engine";
import { db } from "../db/index.js";
import { apiKeys, messages, playSessions, promptFolders, user, userPersonas, userPrompts, worlds, worldPendingEdits } from "../db/schema.js";
import { encryptApiKey } from "../lib/crypto.js";
import { OpenRouterProvider } from "../lib/llm/openrouter.js";
import type { GenerateParams, StreamChunk } from "../lib/llm/types.js";
import { captureSessionPersona } from "../lib/session-persona.js";
import type { AppEnv } from "../lib/types.js";
import { completionRoutes } from "./completions.js";

before(async () => { await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href); });

test("session side completions share narrative context without changing gameplay", async t => {
  const userId = crypto.randomUUID(), worldId = crypto.randomUUID();
  const account = { id: userId, name: "Account", username: "player_handle" };
  await db.insert(user).values({ ...account, email: `${userId}@test.local`, preferences: { preferredProvider: "private", contentLevel: "safe" } });
  const key = encryptApiKey("synthetic-session-test-key");
  await db.insert(apiKeys).values({ userId, provider: "openrouter", encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
  const entry = (id: string, extra: Partial<WorldEntry> = {}): WorldEntry => ({ id, name: id, content: id, role: "custom", position: 0, section: "system-presets", enabled: true, alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all", ...extra });
  const schema = migrateWorldDefinition({ id: worldId, version: "1.0.0", name: "Stage", description: "", author: "test", entries: [
    entry("CORE", { content: "CORE {{user}} {{score}} {{lastUserMessage}}" }),
    entry("DRAWING", { alwaysSend: false, keywords: ["drawing"], content: "DRAWING {{score}}" }),
    entry("ACTIVE_CONDITION", { conditions: [{ variableId: "score", operator: "eq", value: 7 }] }),
    entry("INACTIVE_CONDITION", { conditions: [{ variableId: "score", operator: "eq", value: 99 }] }),
    entry("INACTIVE_BOOK", { worldbookId: "closed" }),
    entry("DISABLED", { enabled: false }),
    entry("EXAMPLE", { role: "example", content: "<START>\n{{user}}: example question\n{{char}}: example answer" }),
    entry("DEPTH", { section: "chat-history", depth: 1, apiRole: "assistant" }),
    entry("POST", { section: "post-history", apiRole: "user" }),
    entry("ROLE_E", { worldbookId: "actor-e", role: "character", name: "Estragon", content: "ROLE_E {{char}}" }),
    entry("ROLE_V", { worldbookId: "actor-v", role: "character", name: "Vladimir", content: "ROLE_V {{char}}" }),
    entry("ROLE_V_EXAMPLE", { worldbookId: "actor-v", role: "example", content: "<START>\n{{user}}: ROLE_V_EXAMPLE\n{{char}}: ROLE_V_ANSWER" }),
    entry("ROLE_V_DEPTH", { worldbookId: "actor-v", section: "chat-history", depth: 1 }),
    entry("ROLE_V_POST", { worldbookId: "actor-v", section: "post-history" }),
    entry("ROLE_E_CLOSED_ENTRY", { worldbookId: "actor-e", conditions: [{ variableId: "score", operator: "eq", value: 99 }] }),
    entry("DISABLED_BOOK", { worldbookId: "disabled-book" }),
    entry("HIDDEN_MACROS", { content: "HIDDEN_MACROS {{private_thoughts}} / {{internal_notes}} / {{sleeping_value}}" }),
    entry("HIDDEN_CONDITION_PASSED", { conditions: [{ variableId: "internal_notes", operator: "eq", value: "INTERNAL_CANARY" }] }),
    entry("PUBLIC_SYSTEM", { content: "PUBLIC_SYSTEM {{public_active}} / {{public_inactive}}" }),
    entry("PUBLIC_DEPTH", { section: "chat-history", depth: 1, content: "PUBLIC_DEPTH {{public_active}} / {{public_inactive}}" }),
    entry("PUBLIC_POST", { section: "post-history", content: "PUBLIC_POST {{public_active}} / {{public_inactive}}" }),
    entry("PUBLIC_EXAMPLE", { role: "example", content: "<START>\n{{user}}: PUBLIC_EXAMPLE {{public_active}}\n{{char}}: {{public_inactive}}" }),
  ], worldbooks: [
    { id: "closed", name: "Closed", order: 0, activation: { mode: "conditions", conditions: [{ variableId: "score", operator: "eq", value: 99 }], conditionLogic: "all" } },
    { id: "actor-e", name: "Estragon", order: 1, activation: { mode: "conditions", conditions: [{ variableId: "internal_notes", operator: "eq", value: "INTERNAL_CANARY" }], conditionLogic: "all" } },
    { id: "actor-v", name: "Vladimir", order: 2, activation: { mode: "always" } },
    { id: "disabled-book", name: "Disabled", order: 3, enabled: false, activation: { mode: "always" } },
  ], variables: [
    { id: "private_thoughts", name: "Private", type: "json", defaultValue: [], aiAccess: "none" },
    { id: "internal_notes", name: "Internal", type: "string", defaultValue: "", internal: true },
    { id: "sleeping_value", name: "Inactive", type: "string", defaultValue: "", enabled: false },
    { id: "public_active", name: "Visible dependent", type: "string", defaultValue: "PUBLIC_CANARY", aiAccess: "read", activation: { mode: "conditions", conditions: [{ variableId: "internal_notes", operator: "eq", value: "INTERNAL_CANARY" }], conditionLogic: "all" } },
    { id: "public_inactive", name: "Hidden dependent", type: "string", defaultValue: "CLOSED_PUBLIC_CANARY", aiAccess: "read", activation: { mode: "conditions", conditions: [{ variableId: "internal_notes", operator: "eq", value: "" }], conditionLogic: "all" } },
  ], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 1800, temperature: 0.7, topP: 0.8 } } as unknown as WorldDefinition);
  await db.insert(worlds).values({ id: worldId, creatorId: userId, name: schema.name, status: "draft", schema: schema as unknown as Record<string, unknown> });
  const [personaA, personaB] = await db.insert(userPersonas).values([
    { userId, name: "Persona A", isActive: true, backstory: "A_STORY", note: "PRIVATE_A" },
    { userId, name: "Persona B", isActive: false, backstory: "B_STORY", note: "PRIVATE_B" },
  ]).returning();
  const savedState = { worldId, variables: { score: 7, private_thoughts: ["PRIVATE_THOUGHT_CANARY"], internal_notes: "INTERNAL_CANARY", sleeping_value: "INACTIVE_CANARY" }, turnCount: 11, metadata: { personaName: "STALE", personaBackstory: "STALE_STORY" } };
  const [session] = await db.insert(playSessions).values({ userId, worldId, state: savedState, sessionPersona: captureSessionPersona(personaB!) }).returning();
  const [folder] = await db.insert(promptFolders).values({ userId, name: "Disabled", enabled: false }).returning();
  await db.insert(userPrompts).values([
    { userId, name: "style", content: "PREFERENCE {{user}}" },
    { userId, name: "claude", content: "CLAUDE_ONLY", autoModels: ["claude"] },
    { userId, name: "gemini", content: "GEMINI_ONLY", autoModels: ["gemini"] },
    { userId, name: "folder", content: "DISABLED_FOLDER", folderId: folder!.id },
    { userId, name: "off", content: "DISABLED_PROMPT", enabled: false },
    { userId, name: "restricted", content: "INELIGIBLE_PROMPT", kind: "unrestrict" },
    { userId, name: "prose", content: "PROSE_OVERRIDE: output Markdown prose instead of JSON.", section: "post-history" },
  ]);
  const observed: GenerateParams[] = [];
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (params: GenerateParams): AsyncGenerator<StreamChunk> {
    observed.push(params);
    yield { type: "text", content: '{"actions":[],"line":"[score: +1]"}' };
    yield { type: "done", content: "", usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } };
  });
  const app = new Hono<AppEnv>();
  let requestAccount = account;
  app.use("*", async (c, next) => { c.set("user", requestAccount as AppEnv["Variables"]["user"]); await next(); });
  const route = "/sessions/:sessionId/completions";
  for (const { handler } of completionRoutes.routes.filter(item => item.method === "POST" && item.path === route)) app.post(route, handler);
  const callerMessages = [{ role: "system", content: "CALLER_PROTOCOL: return an object with actions and line only." }, { role: "user", content: "Observe drawing on the ground." }];
  const request = async (extra: Record<string, unknown> = {}, id = session!.id) => {
    const response = await app.request(`/sessions/${id}/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "anthropic/claude-sonnet-4.6", messages: callerMessages, ...extra }) });
    const body = await response.text();
    return { status: response.status, body, params: observed.at(-1)! };
  };
  const text = (params: GenerateParams) => params.messages.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");

  await t.test("omitting context retains raw messages and defaults even with overrides", async () => {
    const result = await request({ overrides: { maxTokens: 3500, temperature: 0.4 } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.params.messages, callerMessages);
    assert.equal(result.params.maxTokens, 2048); assert.equal(result.params.temperature, 1);
  });
  await t.test("follows current persona, shared prompt selection, and saved-state native lore", async () => {
    const result = await request({ context: "session", responseFormat: { type: "json_object" } });
    assert.equal(result.status, 200);
    const prompt = text(result.params);
    for (const value of ["Persona A", "A_STORY", "PREFERENCE Persona A", "CLAUDE_ONLY", "CORE Persona A 7", "DRAWING 7", "ACTIVE_CONDITION"]) assert.ok(prompt.includes(value), value);
    for (const value of ["PRIVATE_A", "PRIVATE_B", "STALE", "B_STORY", "GEMINI_ONLY", "DISABLED_FOLDER", "DISABLED_PROMPT", "INELIGIBLE_PROMPT", "INACTIVE_CONDITION", "INACTIVE_BOOK", "{{"]) assert.ok(!prompt.includes(value), value);
    assert.ok(result.params.messages.some(m => m.role === "user" && m.content === "example question"), JSON.stringify(result.params.messages));
    assert.ok(result.params.messages.some(m => m.role === "assistant" && m.content === "example answer"));
    const depth = result.params.messages.findIndex(m => m.content === "DEPTH");
    const observation = result.params.messages.findIndex(m => m.content === callerMessages[1]!.content);
    const post = result.params.messages.findIndex(m => m.content === "POST");
    assert.ok(depth < observation && post > observation);
    assert.equal(result.params.messages[depth]?.role, "assistant");
    assert.equal(result.params.messages[post]?.role, "user");
    const tail = result.params.messages.at(-1)!;
    assert.equal(tail.role, "system"); assert.match(String(tail.content), /JSON/);
    assert.ok(prompt.lastIndexOf("CALLER_PROTOCOL") > prompt.lastIndexOf("PROSE_OVERRIDE"));
    assert.deepEqual(result.params.responseFormat, { type: "json_object" });
    assert.equal(result.params.maxTokens, 1800); assert.equal(result.params.temperature, 0.7); assert.equal(result.params.topP, 0.8);
  });
  await t.test("repair retains lore from the initial observation and selects model-bound prompts", async () => {
    const result = await request({ context: "session", model: "google/gemini-2.5-flash", messages: [...callerMessages, { role: "assistant", content: "invalid" }, { role: "user", content: "Repair the invalid JSON." }] });
    assert.match(text(result.params), /DRAWING 7/); assert.match(text(result.params), /GEMINI_ONLY/); assert.doesNotMatch(text(result.params), /CLAUDE_ONLY/);
  });
  await t.test("all bypasses keywords while honoring conditions, disabled entries and worldbook gates", async () => {
    const result = await request({ context: "session", includeLorebook: "all", messages: [{ role: "user", content: "Nothing matches." }] });
    assert.match(text(result.params), /DRAWING 7/);
    assert.match(text(result.params), /ACTIVE_CONDITION/);
    assert.doesNotMatch(text(result.params), /INACTIVE_CONDITION|INACTIVE_BOOK|DISABLED/);
  });
  await t.test("each call selects native actor lore in every prompt zone while retaining core and player preferences", async () => {
    for (const [id, own, other, includeLorebook] of [["actor-e", "ROLE_E Estragon", "ROLE_V", "matched"], ["actor-v", "ROLE_V Vladimir", "ROLE_E", "all"]]) {
      const result = await request({ context: "session", includeLorebook, worldbookIds: [id] });
      assert.equal(result.status, 200);
      const prompt = text(result.params);
      for (const value of [own!, "CORE Persona A 7", "PREFERENCE Persona A", "A_STORY", "CLAUDE_ONLY"]) assert.ok(prompt.includes(value), value);
      assert.ok(!prompt.includes(other!), prompt);
      assert.doesNotMatch(prompt, /ROLE_E_CLOSED_ENTRY|INACTIVE_BOOK|DISABLED_BOOK/);
    }
    const unscoped = await request({ context: "session" });
    assert.match(text(unscoped.params), /ROLE_E/);
    assert.match(text(unscoped.params), /ROLE_V/);
  });
  await t.test("empty scope is core only and selecting an inactive book does not activate it", async () => {
    for (const worldbookIds of [[], ["closed", "disabled-book"]]) {
      const result = await request({ context: "session", includeLorebook: "all", worldbookIds });
      assert.equal(result.status, 200);
      assert.match(text(result.params), /CORE Persona A 7/);
      assert.doesNotMatch(text(result.params), /ROLE_E|ROLE_V|INACTIVE_BOOK|DISABLED_BOOK/);
    }
  });
  await t.test("private or inactive saved variables cannot leak through native lore macros", async () => {
    const result = await request({ context: "session", worldbookIds: ["actor-e"] });
    assert.equal(result.status, 200);
    assert.match(text(result.params), /HIDDEN_MACROS/);
    assert.doesNotMatch(text(result.params), /PRIVATE_THOUGHT_CANARY|INTERNAL_CANARY|INACTIVE_CANARY/);
    assert.match(text(result.params), /ACTIVE_CONDITION/);
    assert.match(text(result.params), /HIDDEN_CONDITION_PASSED/);
    assert.match(text(result.params), /CORE Persona A 7/);
  });
  await t.test("hidden values retain their real activation semantics for public variables in every prompt zone", async () => {
    const result = await request({ context: "session", worldbookIds: ["actor-e"] });
    assert.equal(result.status, 200);
    const prompt = text(result.params);
    for (const zone of ["SYSTEM", "DEPTH", "POST", "EXAMPLE"]) assert.ok(prompt.includes(`PUBLIC_${zone} PUBLIC_CANARY`), zone);
    assert.match(prompt, /ROLE_E Estragon/);
    assert.match(prompt, /HIDDEN_CONDITION_PASSED/);
    assert.doesNotMatch(prompt, /CLOSED_PUBLIC_CANARY|PRIVATE_THOUGHT_CANARY|INTERNAL_CANARY/);
  });
  await t.test("upstream conversation identity isolates book sets and core-only calls while remaining stable", async () => {
    const conversation = async (extra: Record<string, unknown>) => {
      const result = await request({ context: "session", ...extra });
      assert.equal(result.status, 200);
      assert.ok(result.params.conversationId);
      return result.params.conversationId;
    };
    const main = await conversation({});
    const estragon = await conversation({ worldbookIds: ["actor-e"] });
    const vladimir = await conversation({ worldbookIds: ["actor-v"] });
    const core = await conversation({ worldbookIds: [] });
    const both = await conversation({ worldbookIds: ["actor-e", "actor-v"] });
    assert.equal(main, `play:${session!.id}`);
    assert.equal((await request()).params.conversationId, main);
    assert.equal(new Set([main, estragon, vladimir, core, both]).size, 5);
    assert.equal(await conversation({ worldbookIds: ["actor-e"] }), estragon);
    assert.equal(await conversation({ worldbookIds: [] }), core);
    assert.equal(await conversation({ worldbookIds: ["actor-v", "actor-e"] }), both);
    assert.match(estragon, /:side-books:[a-f0-9]{64}$/);
  });
  await t.test("invalid or unknown book scopes reject before inference instead of falling back to all lore", async () => {
    const count = observed.length;
    const invalid = [null, "actor-e", [1], [""], ["actor-e", "actor-e"], ["missing"], ["x".repeat(129)], Array.from({ length: 33 }, (_, i) => `book-${i}`)];
    for (const worldbookIds of invalid) assert.equal((await request({ context: "session", worldbookIds })).status, 400, JSON.stringify(worldbookIds));
    assert.equal((await request({ worldbookIds: ["actor-e"] })).status, 400);
    assert.equal((await request({ context: "session", includeLorebook: false, worldbookIds: ["missing"] })).status, 400);
    assert.equal(observed.length, count);
  });
  await t.test("locks persona by live ID and clears stale description for explicit no-persona", async () => {
    await db.update(playSessions).set({ personaLocked: true }).where(eq(playSessions.id, session!.id));
    await db.update(userPersonas).set({ backstory: "B_EDITED" }).where(eq(userPersonas.id, personaB!.id));
    const locked = await request({ context: "session", includeLorebook: false });
    assert.match(text(locked.params), /Persona B/); assert.match(text(locked.params), /B_EDITED/); assert.doesNotMatch(text(locked.params), /A_STORY|PRIVATE_|CORE/);
    await db.update(playSessions).set({ sessionPersona: captureSessionPersona(null) }).where(eq(playSessions.id, session!.id));
    const none = await request({ context: "session" });
    assert.match(text(none.params), /CORE player_handle 7/); assert.doesNotMatch(text(none.params), /\[User Persona\]|STORY|PRIVATE_/);
    await db.update(playSessions).set({ personaLocked: false }).where(eq(playSessions.id, session!.id));
    await db.update(userPersonas).set({ isActive: false }).where(eq(userPersonas.id, personaA!.id));
    assert.doesNotMatch(text((await request({ context: "session" })).params), /\[User Persona\]|STORY/);
  });
  await t.test("explicit call settings win, session settings forward sampling and remain capped", async () => {
    const overrides = { maxTokens: 12000, temperature: 0.5, topP: 0.6, frequencyPenalty: 0.2, presencePenalty: -0.3, topK: 40, minP: 0.1, reasoningEffort: "high", streaming: false };
    const inherited = (await request({ context: "session", overrides })).params;
    assert.equal(inherited.maxTokens, 8192); assert.equal(inherited.temperature, 0.5);
    for (const key of ["topP", "frequencyPenalty", "presencePenalty", "topK", "minP", "reasoningEffort"] as const) assert.equal(inherited[key], overrides[key]);
    assert.equal(inherited.stream, false);
    const explicit = (await request({ context: "session", overrides, maxTokens: 900, temperature: 0.2 })).params;
    assert.equal(explicit.maxTokens, 900); assert.equal(explicit.temperature, 0.2);
  });
  await t.test("validates session settings and ownership before inference", async () => {
    const count = observed.length;
    for (const extra of [{ context: "other" }, { context: null }, { context: "session", maxTokens: -1 }, { context: "session", maxTokens: null }, { context: "session", temperature: "hot" }, { context: "session", temperature: Infinity }, { context: "session", overrides: { topP: 2 } }, { context: "session", overrides: { maxTokens: Infinity } }, { context: "session", overrides: { reasoningEffort: "invalid" } }, { context: "session", overrides: [] }]) assert.equal((await request(extra)).status, 400, JSON.stringify(extra));
    assert.equal((await request({ context: "session" }, crypto.randomUUID())).status, 404);
    assert.equal(observed.length, count);
  });
  await t.test("a draft lore edit takes effect on the next side call without waiting for cache expiry", async () => {
    const revised = { ...schema, entries: [entry("DRAFT_REVISION_TWO")] };
    await db.update(worlds).set({ schema: revised as unknown as Record<string, unknown>, updatedAt: new Date("2030-01-01T00:00:01Z") }).where(eq(worlds.id, worldId));
    const result = await request({ context: "session" });
    assert.equal(result.status, 200);
    assert.match(text(result.params), /DRAFT_REVISION_TWO/);
    assert.doesNotMatch(text(result.params), /CORE player_handle/);
  });
  await t.test("creator working lore stays current and never leaks through cache to another player", async () => {
    const approved = { ...schema, entries: [entry("APPROVED_LIVE")] };
    const pending = { ...schema, entries: [entry("PRIVATE_WORKING_ONE")] };
    await db.update(worlds).set({ status: "published", isPublished: true, allowEdit: true, schema: approved as unknown as Record<string, unknown>, updatedAt: new Date("2030-01-01T00:00:02Z") }).where(eq(worlds.id, worldId));
    await db.insert(worldPendingEdits).values({ worldId, groupKey: worldId, createdBy: userId, schema: pending as unknown as Record<string, unknown>, updatedAt: new Date("2030-01-01T00:00:03Z") });
    assert.match(text((await request({ context: "session" })).params), /PRIVATE_WORKING_ONE/);
    const pendingTwo = { ...schema, entries: [entry("PRIVATE_WORKING_TWO")] };
    await db.update(worldPendingEdits).set({ schema: pendingTwo as unknown as Record<string, unknown>, updatedAt: new Date("2030-01-01T00:00:04Z") }).where(eq(worldPendingEdits.worldId, worldId));
    const owner = await request({ context: "session" });
    assert.match(text(owner.params), /PRIVATE_WORKING_TWO/);
    assert.doesNotMatch(text(owner.params), /PRIVATE_WORKING_ONE|APPROVED_LIVE/);
    assert.match(text((await request({ includeLorebook: "all" })).params), /PRIVATE_WORKING_TWO/);
    const visitor = { id: crypto.randomUUID(), name: "Visitor", username: "another_player" };
    await db.insert(user).values({ ...visitor, email: `${visitor.id}@test.local`, preferences: { preferredProvider: "private" } });
    await db.insert(apiKeys).values({ userId: visitor.id, provider: "openrouter", encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
    const [visitorSession] = await db.insert(playSessions).values({ userId: visitor.id, worldId }).returning();
    requestAccount = visitor;
    try {
      const player = await request({ context: "session" }, visitorSession!.id);
      assert.equal(player.status, 200);
      assert.match(text(player.params), /APPROVED_LIVE/);
      assert.doesNotMatch(text(player.params), /PRIVATE_WORKING/);
      const rawPlayer = await request({ includeLorebook: "all" }, visitorSession!.id);
      assert.match(text(rawPlayer.params), /APPROVED_LIVE/);
      assert.doesNotMatch(text(rawPlayer.params), /PRIVATE_WORKING/);
    } finally { requestAccount = account; }
    await db.delete(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId));
    const removed = await request({ context: "session" });
    assert.match(text(removed.params), /APPROVED_LIVE/);
    assert.doesNotMatch(text(removed.params), /PRIVATE_WORKING/);
  });
  const [after] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
  assert.deepEqual(after!.state, savedState, "context construction and returned directives cannot persist effects");
  assert.equal((await db.select().from(messages).where(eq(messages.sessionId, session!.id))).length, 0);
});
