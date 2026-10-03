import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema.js";
import type { DrizzleDB } from "../db/index.js";
import { evaluateUnrestrictEligibility } from "./unrestrict.js";
import { loadUserPrompts, selectUserPrompts } from "./user-prompts.js";

const thisYear = new Date().getFullYear();

test("eligibility: adult content level + known adult birth year only", () => {
  const e = evaluateUnrestrictEligibility;
  assert.deepEqual(e({ contentLevel: "sensitive", birthYear: thisYear - 30 }), { eligible: true, reason: null });
  assert.deepEqual(e({ contentLevel: "r18", birthYear: thisYear - 18 }), { eligible: true, reason: null });
  assert.deepEqual(e({ contentLevel: "r18g", birthYear: thisYear - 40 }), { eligible: true, reason: null });
  assert.deepEqual(e({ contentLevel: "safe", birthYear: thisYear - 30 }), { eligible: false, reason: "safe-mode" });
  assert.deepEqual(e({ contentLevel: null, birthYear: thisYear - 30 }), { eligible: false, reason: "safe-mode" });
  assert.deepEqual(e({ contentLevel: "sensitive", birthYear: null }), { eligible: false, reason: "no-birth-year" });
  assert.deepEqual(e({ contentLevel: "safe", birthYear: null }), { eligible: false, reason: "safe-mode" });
  assert.deepEqual(e({ contentLevel: "sensitive", birthYear: thisYear - 15 }), { eligible: false, reason: "minor" });
  assert.deepEqual(e({ contentLevel: "safe", birthYear: thisYear - 15 }), { eligible: false, reason: "minor" });
  assert.deepEqual(e(null), { eligible: false, reason: "safe-mode" });
});

// selectUserPrompts is the pure core: enabled + folder + eligibility gate + per-model binding.
type Row = Parameters<typeof selectUserPrompts>[0][number];
function row(p: Partial<Row> & { id: string }): Row {
  return {
    id: p.id, name: p.name ?? p.id, content: p.content ?? "x",
    section: p.section ?? "system-presets", enabled: p.enabled ?? true,
    depth: p.depth ?? null, position: p.position ?? null, folderId: p.folderId ?? null,
    kind: p.kind ?? null, apiRole: p.apiRole ?? null, autoModels: p.autoModels ?? null,
  } as Row;
}
const ids = (ps: { id: string }[]) => ps.map((p) => p.id).sort();

test("no binding = always-on; a binding applies only on its model family", () => {
  const prompts = [
    row({ id: "always" }),
    row({ id: "gem", autoModels: ["gemini"] }),
    row({ id: "cl", autoModels: ["claude", "openai"] }),
  ];
  assert.deepEqual(ids(selectUserPrompts(prompts, [], true, { modelId: "google/gemini-2.5-flash" })), ["always", "gem"]);
  assert.deepEqual(ids(selectUserPrompts(prompts, [], true, { modelId: "openai/gpt-5" })), ["always", "cl"]);
  assert.deepEqual(ids(selectUserPrompts(prompts, [], true, { modelId: "deepseek/deepseek-v3.2" })), ["always"]);
  // No model id → family "other" → only unbound prompts.
  assert.deepEqual(ids(selectUserPrompts(prompts, [], true, {})), ["always"]);
});

test("an empty autoModels array is treated as no binding (always-on)", () => {
  const prompts = [row({ id: "empty", autoModels: [] })];
  assert.deepEqual(ids(selectUserPrompts(prompts, [], true, { modelId: "deepseek/deepseek-v3.2" })), ["empty"]);
});

test("eligibility gate: kind='unrestrict' rows dropped when not eligible", () => {
  const prompts = [row({ id: "plain" }), row({ id: "ur", kind: "unrestrict" })];
  assert.deepEqual(ids(selectUserPrompts(prompts, [], true, { modelId: "google/gemini-2.5-flash" })), ["plain", "ur"]);
  assert.deepEqual(ids(selectUserPrompts(prompts, [], false, { modelId: "google/gemini-2.5-flash" })), ["plain"]);
});

test("disabled prompt / disabled folder / apiRole mapping", () => {
  const prompts = [
    row({ id: "off", enabled: false }),
    row({ id: "inOff", folderId: "f1" }),
    row({ id: "post", section: "post-history", apiRole: "user" }),
    row({ id: "sys", apiRole: "system" }),
  ];
  const out = selectUserPrompts(prompts, [{ id: "f1", enabled: false }], true, {});
  assert.deepEqual(ids(out), ["post", "sys"]);
  assert.equal(out.find((p) => p.id === "post")!.apiRole, "user");
  // system apiRole is the default and is not carried through as an override.
  assert.equal(out.find((p) => p.id === "sys")!.apiRole, undefined);
});

async function withDb(fn: (db: DrizzleDB, pg: PGlite) => Promise<void>) {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE TABLE "user"(id text PRIMARY KEY, birth_year int, preferences jsonb DEFAULT '{}'::jsonb);
      CREATE TABLE prompt_folders(id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, enabled boolean NOT NULL DEFAULT true,
        source_pack_id text, created_at timestamp DEFAULT now());
      CREATE TABLE user_prompts(id text PRIMARY KEY, user_id text NOT NULL, folder_id text, name text NOT NULL, content text NOT NULL DEFAULT '',
        section text NOT NULL DEFAULT 'system-presets', enabled boolean NOT NULL DEFAULT true, depth int, position real,
        kind text, source_type text, source_id text, source_version int, api_role text, auto_models jsonb,
        created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
    `);
    await fn(drizzle(pg, { schema }) as unknown as DrizzleDB, pg);
  } finally {
    await pg.close();
  }
}

async function seed(pg: PGlite, opts: { contentLevel: string; birthYear: number | null }) {
  await pg.query(`INSERT INTO "user"(id, birth_year, preferences) VALUES ('u', $1, $2::jsonb)`,
    [opts.birthYear, JSON.stringify({ contentLevel: opts.contentLevel })]);
  await pg.exec(`
    INSERT INTO user_prompts(id, user_id, name, content, kind, api_role, section, auto_models, enabled) VALUES
      ('plain', 'u', 'plain', 'hello', NULL, 'user', 'post-history', NULL, true),
      ('gem', 'u', 'gem jb', 'x', 'unrestrict', NULL, 'system-presets', '["gemini"]'::jsonb, true),
      ('cl', 'u', 'claude jb', 'x', 'unrestrict', NULL, 'system-presets', '["claude"]'::jsonb, true),
      ('other-user', 'someone', 'x', 'x', NULL, NULL, 'system-presets', NULL, true);
  `);
}

test("loadUserPrompts: per-model binding reads auto_models and applies the age gate", async () => {
  await withDb(async (db, pg) => {
    await seed(pg, { contentLevel: "sensitive", birthYear: thisYear - 30 });
    assert.deepEqual(ids(await loadUserPrompts("u", { modelId: "google/gemini-2.5-flash" }, db)), ["gem", "plain"]);
    assert.deepEqual(ids(await loadUserPrompts("u", { modelId: "anthropic/claude-sonnet-4.6" }, db)), ["cl", "plain"]);
    assert.deepEqual(ids(await loadUserPrompts("u", {}, db)), ["plain"]);
  });
});

test("loadUserPrompts: safe-mode account never gets kind='unrestrict' rows", async () => {
  await withDb(async (db, pg) => {
    await seed(pg, { contentLevel: "safe", birthYear: thisYear - 30 });
    // gem/cl are kind='unrestrict' → dropped for a safe-mode account even on their model.
    assert.deepEqual(ids(await loadUserPrompts("u", { modelId: "google/gemini-2.5-flash" }, db)), ["plain"]);
  });
});
