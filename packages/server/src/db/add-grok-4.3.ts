/**
 * Idempotent migration — add the official Grok 4.3 model to the
 * `model_prices` table without disturbing existing rows.
 *
 * Run with: tsx packages/server/src/db/add-grok-4.3.ts
 *
 * Env: DATABASE_URL must point at the target Postgres instance.
 * Apply to DEV first, then PROD (railway run …), BEFORE deploying the code
 * that lists the model — `isOfficialModel()` reads this table, so the row must
 * exist before any user can pick it.
 *
 * Safe to re-run — for each model id we DELETE any existing rows first
 * (the table has no unique constraint on model_id alone), then INSERT a
 * fresh active row. Other model rows are untouched.
 *
 * Pricing (raw upstream, $ per million tokens):
 *   - x-ai/grok-4.3 : $1.25 in / $2.50 out  (premium tier, go+, 1.2× markup)
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
  { modelId: "x-ai/grok-4.3", inputPricePerM: 1.25, outputPricePerM: 2.50, minPlan: "go", markup: 1.2 },
];

async function main() {
  console.log("=== add-grok-4.3: upserting Grok 4.3 model price ===\n");

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

  // Verify the row is present and active.
  const verify = await db.execute(sql`
    SELECT model_id, input_price_per_m, output_price_per_m, min_plan, markup_multiplier, is_active
    FROM model_prices
    WHERE model_id = 'x-ai/grok-4.3'
    ORDER BY model_id
  `);
  console.log("\nFinal state:");
  for (const row of verify.rows) {
    console.log(`  ${JSON.stringify(row)}`);
  }

  await pool.end();
  console.log("\n=== Done ===");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  pool.end().finally(() => process.exit(1));
});
