/**
 * Idempotent migration — add the official Claude Sonnet 5 / Claude Opus 5
 * models to the `model_prices` table without disturbing existing rows.
 *
 * Run with: pnpm --filter @yumina/server exec tsx src/db/add-claude-5.ts
 *
 * Env: DATABASE_URL must point at the target Postgres instance.
 * Apply to DEV first, then PROD (railway run …), BEFORE deploying the code
 * that lists the models — `isOfficialModel()` reads this table, so the rows
 * must exist before any user can pick them.
 *
 * Safe to re-run — for each model id we DELETE any existing rows first
 * (the table has no unique constraint on model_id alone), then INSERT a
 * fresh active row. Other model rows are untouched.
 *
 * Pricing (raw upstream, $ per million tokens). Both models are added as
 * ADDITIONAL choices alongside Sonnet 4.6 / Opus 4.7 — same tier, same plan
 * gate, same markup, so the mushie cost per reply is unchanged:
 *   - anthropic/claude-sonnet-5 : $3 in / $15 out  (ultra tier, plus+, 1.25× markup)
 *   - anthropic/claude-opus-5   : $5 in / $25 out  (ultra tier, plus+, 1.25× markup)
 *
 * Note on Sonnet 5: OpenRouter currently lists it at the $2/$10 introductory
 * rate, which reverts to the $3/$15 sticker price on 2026-08-31. We bill at the
 * sticker price from day one so nothing has to change when the intro ends.
 */

import { config } from "dotenv";
config({ path: "../../.env" });

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Refusing to run.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString });
const db = drizzle(pool);

interface ModelRow {
  modelId: string;
  inputPricePerM: number;
  outputPricePerM: number;
  minPlan: string;
  markup: number;
}

const NEW_MODELS: ModelRow[] = [
  { modelId: "anthropic/claude-sonnet-5", inputPricePerM: 3.0, outputPricePerM: 15.0, minPlan: "plus", markup: 1.25 },
  { modelId: "anthropic/claude-opus-5",   inputPricePerM: 5.0, outputPricePerM: 25.0, minPlan: "plus", markup: 1.25 },
];

async function main() {
  console.log("=== add-claude-5: upserting Claude Sonnet 5 / Opus 5 model prices ===\n");

  for (const m of NEW_MODELS) {
    const existing = await db.execute(sql`
      SELECT id, input_price_per_m, output_price_per_m, min_plan, markup_multiplier, is_active
      FROM model_prices WHERE model_id = ${m.modelId}
    `);

    if (existing.rows.length > 0) {
      console.log(`• ${m.modelId} — found ${existing.rows.length} existing row(s), replacing.`);
      await db.execute(sql`DELETE FROM model_prices WHERE model_id = ${m.modelId}`);
    } else {
      console.log(`• ${m.modelId} — new row.`);
    }

    await db.execute(sql`
      INSERT INTO model_prices (
        id, model_id, input_price_per_m, output_price_per_m,
        context_threshold, input_price_above_threshold, output_price_above_threshold,
        min_plan, markup_multiplier, is_active, updated_at
      ) VALUES (
        gen_random_uuid(), ${m.modelId}, ${m.inputPricePerM}, ${m.outputPricePerM},
        NULL, NULL, NULL,
        ${m.minPlan}, ${m.markup}, TRUE, NOW()
      )
    `);
    console.log(`  → seeded $${m.inputPricePerM}/$${m.outputPricePerM} per M, ${m.minPlan}+, ${m.markup}× markup`);
  }

  // Verify both rows are present and active.
  const verify = await db.execute(sql`
    SELECT model_id, input_price_per_m, output_price_per_m, min_plan, markup_multiplier, is_active
    FROM model_prices
    WHERE model_id IN ('anthropic/claude-sonnet-5', 'anthropic/claude-opus-5')
    ORDER BY model_id
  `);
  console.log("\nFinal state:");
  for (const row of verify.rows) {
    console.log(`  ${JSON.stringify(row)}`);
  }
  if (verify.rows.length !== NEW_MODELS.length) {
    console.error(`\n!! Expected ${NEW_MODELS.length} rows, found ${verify.rows.length}.`);
    await pool.end();
    process.exit(1);
  }

  await pool.end();
  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  pool.end().finally(() => process.exit(1));
});
