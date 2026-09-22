import assert from "node:assert/strict";
import { before, beforeEach, afterEach, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { env } from "./env.js";
import { __setEmbeddingProviderForTests, embedAndStoreWorld } from "./embeddings.js";
import { buildWorldEmbeddingInput } from "./embedding-content.js";

const published = { worldId: "story", name: "Published title", description: "Public summary",
  tags: ["Fantasy"], announcement: null,
  schema: { entries: [{ role: "greeting", enabled: true, content: "Published opening" }] } };
const vec = Array.from({ length: 1536 }, () => 0.5);
const originalApiKey = env.OPENAI_API_KEY;
let inputs: string[] = [];

describe("published embedding writes", { concurrency: false }, () => {
  before(async () => {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await db.execute(sql`CREATE TABLE worlds (id text PRIMARY KEY, name text, description text,
      tags jsonb, announcement text, schema jsonb, is_published boolean, status text,
      embedding vector(1536), embedding_updated_at timestamp)`);
  });
  beforeEach(async () => {
    inputs = [];
    await db.execute(sql`TRUNCATE worlds`);
    await db.execute(sql`INSERT INTO worlds (id, name, description, tags, announcement, schema, is_published, status)
      VALUES (${published.worldId}, ${published.name}, ${published.description}, ${JSON.stringify(published.tags)}::jsonb,
      NULL, ${JSON.stringify(published.schema)}::jsonb, true, 'published')`);
    // Isolated launcher strips credentials and blocks external fetch. This fake
    // provider is the only embedding implementation these tests can call.
    env.OPENAI_API_KEY = "local-embedding-test-not-a-real-key";
    __setEmbeddingProviderForTests({ embed: async (input) => { inputs.push(input); return vec; }, embedBatch: async () => [] });
  });
  afterEach(() => { __setEmbeddingProviderForTests(null); env.OPENAI_API_KEY = originalApiKey; });

  async function stored() {
    const result = await db.execute(sql`SELECT embedding IS NOT NULL AS stored FROM worlds WHERE id = 'story'`);
    return (result as unknown as { rows: { stored: boolean }[] }).rows[0]!.stored;
  }

  it("sends canonical live greetings and stores their vector", async () => {
    await embedAndStoreWorld(published);
    assert.deepEqual(inputs, [buildWorldEmbeddingInput(published).text]);
    assert.equal(await stored(), true);
  });

  it("does not overwrite newer content after a slow API response", async () => {
    __setEmbeddingProviderForTests({ embed: async () => {
      await db.execute(sql`UPDATE worlds SET schema = '{"entries":[]}'::jsonb WHERE id = 'story'`);
      return vec;
    }, embedBatch: async () => [] });
    await embedAndStoreWorld(published);
    assert.equal(await stored(), false);
  });

  it("does not write after unpublication or metadata changes", async () => {
    for (const change of [sql`UPDATE worlds SET is_published = false WHERE id = 'story'`,
      sql`UPDATE worlds SET is_published = true, status = 'draft' WHERE id = 'story'`,
      sql`UPDATE worlds SET status = 'published', name = 'New title' WHERE id = 'story'`]) {
      __setEmbeddingProviderForTests({ embed: async () => { await db.execute(change); return vec; }, embedBatch: async () => [] });
      await embedAndStoreWorld(published);
      assert.equal(await stored(), false);
    }
  });

  it("rejects malformed vectors and does not log story text from provider errors", async (t) => {
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
    for (const value of [[], Array(1536).fill(NaN), Array(1536).fill(Infinity)]) {
      __setEmbeddingProviderForTests({ embed: async () => value, embedBatch: async () => [] });
      await embedAndStoreWorld(published);
      assert.equal(await stored(), false);
    }
    __setEmbeddingProviderForTests({ embed: async () => { throw new Error("Provider echoed Published opening"); }, embedBatch: async () => [] });
    await embedAndStoreWorld(published);
    assert.ok(!JSON.stringify(warnings).includes("Published opening"));
  });
});
