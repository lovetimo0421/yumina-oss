import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { AppEnv } from "../lib/types.js";

// Always use an isolated in-memory database, never a developer/production DB.
process.env.DATABASE_URL = "";
process.env.DATABASE_READ_URL = "";
process.env.REDIS_URL = "";
process.env.PGLITE_DATA_DIR = "memory://";
process.env.BETTER_AUTH_SECRET = "private-model-sync-isolated-test-secret";
const { db } = await import("../db/index.js");
const { apiKeys } = await import("../db/schema.js");
const { encryptApiKey } = await import("../lib/crypto.js");
const { apiKeyRoutes } = await import("./api-keys.js");
const originalFetch = globalThis.fetch;

// Exercise the real route handler with the identity normally supplied by auth.
// Authentication itself is covered by the middleware suite.
const handler = apiKeyRoutes.routes.find((route) => route.method === "POST" && route.path === "/:id/list-models")!.handler;
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => { c.set("user", { id: "owner" } as never); await next(); });
app.post("/:id/list-models", handler);
const request = (suffix = "?refresh=auto") => app.request(`/key/list-models${suffix}`, { method: "POST" });
const read = async (response: Response) => await response.json() as { data: { ok: boolean; models: string[]; imageCapabilities: Record<string, boolean> } };

before(async () => {
  await db.execute(sql`CREATE TABLE api_keys (
    id text PRIMARY KEY, user_id text NOT NULL, provider text NOT NULL,
    encrypted_key text NOT NULL, key_iv text NOT NULL, key_tag text NOT NULL,
    label text NOT NULL DEFAULT 'Default', base_url text, metadata jsonb,
    created_at timestamp DEFAULT now()
  )`);
});
beforeEach(async () => {
  await db.delete(apiKeys);
  const encrypted = encryptApiKey("test-only-key");
  await db.insert(apiKeys).values({
    id: "key", userId: "owner", provider: "custom", baseUrl: "https://api.example.com/v1",
    encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag,
    metadata: { models: ["old", "manual"], discoveredModels: ["old"] },
  });
});
after(async () => {
  globalThis.fetch = originalFetch;
  const client = (db as unknown as { $client?: { close?: () => Promise<void> } }).$client;
  await client?.close?.();
});

test("real list-models route persists new upstream IDs, preserves manual IDs, and honors auto TTL", async () => {
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.example.com/v1/models");
    assert.ok(new Headers(init?.headers).get("authorization")?.startsWith("Bearer "));
    return Response.json({ data: [{ id: "deepseek/new-route" }] });
  }) as typeof fetch;
  const first = await request();
  assert.equal(first.status, 200);
  const result = await read(first);
  assert.deepEqual(result.data.models, ["manual", "deepseek/new-route"]);
  const [saved] = await db.select().from(apiKeys);
  assert.ok(saved);
  assert.deepEqual(saved.metadata?.models, result.data.models);
  assert.ok(saved.metadata?.modelsSyncedAt);
  await request();
  assert.equal(calls, 1, "automatic repeat uses the server TTL");
  await request("");
  assert.equal(calls, 2, "explicit Connect bypasses the TTL");
});

test("real route keeps saved catalog after upstream auth, malformed and empty responses", async () => {
  for (const response of [new Response(null, { status: 401 }), Response.json({ data: [] }), Response.json({ data: [{ id: null }] })]) {
    globalThis.fetch = (async () => response) as typeof fetch;
    const result = await read(await request());
    assert.equal(result.data.ok, false);
    const [saved] = await db.select().from(apiKeys);
    assert.ok(saved);
    assert.deepEqual(saved.metadata?.models, ["old", "manual"]);
    assert.equal(saved.metadata?.modelsSyncedAt, undefined);
  }
});

test("fresh OpenRouter catalog retains known image capabilities without any network request", async () => {
  await db.update(apiKeys).set({ provider: "openrouter", metadata: {
    models: ["google/gemini-2.5-pro", "deepseek/deepseek-v3.2"],
    modelsSyncedAt: Date.now(),
  } }).where(eq(apiKeys.id, "key"));
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("fresh catalog must not contact upstream"); }) as typeof fetch;
  const result = await read(await request());
  assert.equal(result.data.ok, true);
  assert.deepEqual(result.data.imageCapabilities, {
    "google/gemini-2.5-pro": true,
    "deepseek/deepseek-v3.2": false,
  });
  assert.equal(calls, 0);
});

test("refresh merges against current metadata instead of overwriting concurrent edits", async () => {
  globalThis.fetch = (async () => {
    await db.update(apiKeys).set({ metadata: {
      models: ["old", "new-manual"], discoveredModels: ["old"], defaultModel: "typed-now", includeBody: { top_k: 4 },
    } }).where(eq(apiKeys.id, "key"));
    return Response.json({ data: [{ id: "new" }] });
  }) as typeof fetch;
  assert.equal((await read(await request())).data.ok, true);
  const [saved] = await db.select().from(apiKeys);
  assert.ok(saved);
  assert.deepEqual(saved.metadata?.models, ["typed-now", "new-manual", "new"]);
  assert.deepEqual(saved.metadata?.includeBody, { top_k: 4 });
});

test("changed endpoints discard an in-flight result from the previous endpoint", async () => {
  globalThis.fetch = (async () => {
    await db.update(apiKeys).set({ baseUrl: "https://other.example.com/v1" }).where(eq(apiKeys.id, "key"));
    return Response.json({ data: [{ id: "wrong-endpoint-model" }] });
  }) as typeof fetch;
  assert.equal((await read(await request())).data.ok, false);
  const [saved] = await db.select().from(apiKeys);
  assert.ok(saved);
  assert.deepEqual(saved.metadata?.models, ["old", "manual"]);
});

test("a profile owned by another user cannot trigger an upstream request", async () => {
  await db.update(apiKeys).set({ userId: "someone-else" }).where(eq(apiKeys.id, "key"));
  globalThis.fetch = (async () => { throw new Error("must not contact upstream"); }) as typeof fetch;
  assert.equal((await request()).status, 404);
});
