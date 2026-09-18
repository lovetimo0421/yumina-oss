/**
 * Credit System Migration Script
 *
 * Run with: npx tsx packages/server/src/db/seed-credits.ts
 *
 * This script:
 * 1. Creates the credit system tables (credit_wallets, credit_transactions, model_prices)
 * 2. Seeds model_prices with all 11 models and their pricing
 * 3. Migrates existing user tiers: "regular" → "free", "invited" → "go"
 * 4. Creates credit wallets for all existing users with initial plan grants
 */

import { config } from "dotenv";
config({ path: "../../.env" });

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const db = drizzle(pool);

async function migrate() {
  console.log("=== Credit System Migration ===\n");

  // ─── Step 1: Create tables ──────────────────────────────────────────
  console.log("1. Creating credit system tables...");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS credit_wallets (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
      balance         REAL NOT NULL DEFAULT 0,
      plan            TEXT NOT NULL DEFAULT 'free',
      monthly_credits INTEGER NOT NULL DEFAULT 1000,
      memory_cap      INTEGER,
      period_start    TIMESTAMP NOT NULL DEFAULT NOW(),
      period_end      TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
      created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS credit_wallets_user_id_idx ON credit_wallets(user_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id       TEXT NOT NULL REFERENCES credit_wallets(id) ON DELETE CASCADE,
      amount          REAL NOT NULL,
      type            TEXT NOT NULL,
      reference_id    TEXT,
      balance_after   REAL NOT NULL,
      description     TEXT,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS credit_txn_wallet_idx ON credit_transactions(wallet_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS credit_txn_ref_idx ON credit_transactions(reference_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS model_prices (
      id                            TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      model_id                      TEXT NOT NULL,
      input_price_per_m             REAL NOT NULL,
      output_price_per_m            REAL NOT NULL,
      context_threshold             INTEGER,
      input_price_above_threshold   REAL,
      output_price_above_threshold  REAL,
      min_plan                      TEXT NOT NULL DEFAULT 'free',
      is_active                     BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at                    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  console.log("   ✓ Tables created\n");

  // ─── Step 2: Seed model prices ────────────────────────────────────
  console.log("2. Seeding model prices...");

  // Clear existing prices and re-seed
  await db.execute(sql`DELETE FROM model_prices`);

  // Markup tiers (applied on top of raw upstream price):
  //   1.0×  cheap (free-tier models)
  //   1.1×  standard (Gemini Flash family)
  //   1.2×  premium (Haiku, Grok 4.20, Gemini 3.1 Pro)
  //   1.25× top tier (Sonnet, Opus)
  const models = [
    // model_id, input_price, output_price, threshold, input_above, output_above, min_plan, markup
    ["deepseek/deepseek-v4-flash",            0.112, 0.224, null,   null, null, "free", 1.0],
    ["qwen/qwen3-vl-235b-a22b-instruct",     0.20,  0.88,  null,   null, null, "free", 1.0],
    ["anthropic/claude-3-haiku",              0.25,  1.25,  null,   null, null, "free", 1.0],
    // retired models — kept for historical cost accuracy
    ["google/gemini-2.5-flash-lite",          0.05,  0.20,  null,   null, null, "free", 1.0],
    ["google/gemini-2.5-flash-lite-preview-09-2025", 0.05, 0.20, null, null, null, "free", 1.0],
    ["deepseek/deepseek-v3.2",                0.252, 0.378, null,   null, null, "free", 1.0],
    // Cheap concise-reply models (added 2026-08-03) — raw OpenRouter rates, 1.15× margin.
    ["mistralai/mistral-nemo",                0.019, 0.030, null,   null, null, "free", 1.15],
    ["mistralai/mistral-small-3.2-24b-instruct", 0.075, 0.200, null, null, null, "free", 1.15],
    ["nousresearch/hermes-4-70b",             0.130, 0.400, null,   null, null, "free", 1.15],
    ["x-ai/grok-4.1-fast",                    0.10,  0.25,  null,   null, null, "free", 1.0],
    ["moonshotai/kimi-k2-0905",               0.60,  2.50,  null,   null, null, "free", 1.1],
    ["z-ai/glm-4.6",                         0.43,  1.75,  null,   null, null, "free", 1.2],
    ["google/gemini-3.1-flash-lite-preview",   0.25,  1.50,  null,   null, null, "free", 1.1],
    ["google/gemini-3.1-flash-lite",           0.25,  1.50,  null,   null, null, "free", 1.1],
    ["google/gemini-2.5-flash",               0.30,  2.50,  null,   null, null, "free", 1.1],
    ["google/gemini-3-flash-preview",          0.50,  3.00,  null,   null, null, "free", 1.1],
    ["deepseek/deepseek-v4-pro",              0.87,  1.74,  null,   null, null, "free", 1.1],
    ["google/gemini-3-pro-preview",            2.00, 12.00,  null,   null, null, "go",   1.2],
    ["anthropic/claude-haiku-4.5",             1.00,  5.00,  null,   null, null, "go",   1.2],
    ["x-ai/grok-4.3",                         1.25,  2.50,  null,   null, null, "go",   1.2],
    ["x-ai/grok-4.20",                        2.00,  6.00,  null,   null, null, "go",   1.2],
    ["google/gemini-3.1-pro-preview",          2.00, 12.00,  null,   null, null, "go",   1.2],
    ["anthropic/claude-sonnet-4.6",            3.00, 15.00,  null,   null, null, "plus", 1.25],
    ["anthropic/claude-sonnet-5",              3.00, 15.00,  null,   null, null, "plus", 1.25],
    ["anthropic/claude-opus-4.7",              5.00, 25.00,  null,   null, null, "plus", 1.25],
    ["anthropic/claude-opus-5",                5.00, 25.00,  null,   null, null, "plus", 1.25],
    // 2026-09 intake. Prices are max(catalog headline, cheapest LIVE endpoint) —
    // we pin provider.sort:"price", so the live cheapest is the real unit cost.
    // tencent/hy3 is the case that matters: its headline ($0.0825/$0.33) sits
    // BELOW every live endpoint, so the live price is stored instead.
    ["z-ai/glm-5.3-flash",                     0.075, 0.25,  null,   null, null, "free", 1.15],
    ["tencent/hy3",                            0.126, 0.522, null,   null, null, "free", 1.15],
    ["openai/gpt-5.6-luna",                    0.20,  1.20,  null,   null, null, "free", 1.15],
    ["stepfun/step-3.7-flash",                 0.20,  1.15,  null,   null, null, "free", 1.1],
    ["meituan/longcat-2.0",                    0.30,  1.20,  null,   null, null, "free", 1.1],
    ["minimax/minimax-m3",                     0.30,  1.20,  null,   null, null, "free", 1.1],
    ["google/gemini-3.5-flash-lite",           0.30,  2.50,  null,   null, null, "free", 1.1],
    ["thinkingmachines/inkling-small",         0.45,  1.20,  null,   null, null, "free", 1.1],
    ["mistralai/mistral-large-2512",           0.50,  1.50,  null,   null, null, "free", 1.1],
    ["google/gemini-3.7-flash",                0.75,  3.75,  null,   null, null, "free", 1.1],
    ["openai/gpt-5.4-mini",                    0.75,  4.50,  null,   null, null, "go",   1.2],
    ["google/gemini-3.8-flash",                0.75,  3.75,  null,   null, null, "go",   1.2],
    ["moonshotai/kimi-k2.6",                   0.95,  4.00,  null,   null, null, "go",   1.2],
    ["openai/gpt-5.6-sol",                     2.00, 10.00,  null,   null, null, "plus", 1.25],
    ["openai/gpt-6-astra",                    10.00, 50.00,  null,   null, null, "plus", 1.25],
    // Free-tier model — costs $0 upstream, available to everyone. Routing to
    // the actual OpenRouter free-tier model is wired separately (see resolve-provider).
    ["openrouter/free",                        0.00,  0.00,  null,   null, null, "free", 1.0],
  ] as const;

  for (const [modelId, inputPrice, outputPrice, threshold, inputAbove, outputAbove, minPlan, markup] of models) {
    await db.execute(sql`
      INSERT INTO model_prices (id, model_id, input_price_per_m, output_price_per_m, context_threshold, input_price_above_threshold, output_price_above_threshold, min_plan, markup_multiplier)
      VALUES (gen_random_uuid(), ${modelId}, ${inputPrice}, ${outputPrice}, ${threshold}, ${inputAbove}, ${outputAbove}, ${minPlan}, ${markup})
    `);
    console.log(`   ✓ ${modelId} — $${inputPrice}/$${outputPrice} per M tokens (${minPlan}+, ${markup}×)`);
  }
  console.log();

  // ─── Step 3: Migrate user tiers ───────────────────────────────────
  // All existing users get "internal" (unlimited) — they're beta testers.
  // New signups without invite code will get "free".
  console.log("3. Migrating user tiers to internal...");

  const migratedResult = await db.execute(sql`
    UPDATE "user" SET tier = 'internal' WHERE tier IN ('regular', 'invited')
  `);
  console.log(`   ✓ ${migratedResult.rowCount ?? 0} users → "internal" (unlimited)`);
  console.log();

  // ─── Step 4: Create wallets for existing users ────────────────────
  console.log("4. Creating credit wallets for existing users...");

  // Get all users who don't have wallets yet
  const usersWithoutWallets = await db.execute(sql`
    SELECT u.id, u.tier FROM "user" u
    LEFT JOIN credit_wallets cw ON cw.user_id = u.id
    WHERE cw.id IS NULL
  `);

  let created = 0;
  for (const row of usersWithoutWallets.rows) {
    const userId = row.id as string;
    const tier = (row.tier as string) || "internal";
    // All existing users are internal (unlimited) — credits don't matter but set 0
    const credits = 0;
    const memoryCap = null;

    // Create wallet
    const walletResult = await db.execute(sql`
      INSERT INTO credit_wallets (id, user_id, balance, plan, monthly_credits, memory_cap, period_end)
      VALUES (gen_random_uuid(), ${userId}, ${credits}, ${tier}, ${credits}, ${memoryCap}, NOW() + INTERVAL '30 days')
      ON CONFLICT (user_id) DO NOTHING
      RETURNING id
    `);

    if (walletResult.rows.length > 0) {
      const walletId = (walletResult.rows[0] as Record<string, unknown>).id as string;
      // Record initial grant in ledger
      await db.execute(sql`
        INSERT INTO credit_transactions (id, wallet_id, amount, type, balance_after, description)
        VALUES (gen_random_uuid(), ${walletId}, ${credits}, 'plan_grant', ${credits}, ${`Initial ${tier} plan grant (migration)`})
      `);
      created++;
    }
  }

  console.log(`   ✓ Created ${created} wallets\n`);

  // ─── Done ─────────────────────────────────────────────────────────
  console.log("=== Migration complete! ===");

  // Summary
  const walletCount = await db.execute(sql`SELECT COUNT(*) as count FROM credit_wallets`);
  const modelCount = await db.execute(sql`SELECT COUNT(*) as count FROM model_prices WHERE is_active = true`);
  console.log(`\nSummary:`);
  console.log(`  - ${(modelCount.rows[0] as Record<string, unknown>)?.count} active model prices`);
  console.log(`  - ${(walletCount.rows[0] as Record<string, unknown>)?.count} credit wallets`);

  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
