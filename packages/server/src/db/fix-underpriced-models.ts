/**
 * Idempotent price correction — two official models are billed BELOW what
 * OpenRouter actually charges us, so every turn on them loses money.
 *
 * Run with: pnpm --filter @yumina/server exec tsx src/db/fix-underpriced-models.ts
 * Env: DATABASE_URL must point at the target Postgres instance (dev first, then
 * prod via `railway run …`).
 *
 * Verified 2026-09-06 against `GET /api/v1/models/{id}/endpoints`, taking the
 * CHEAPEST live endpoint — that is what `provider: { sort: "price" }` selects,
 * so it is our real unit cost, not the catalog headline.
 *
 *   deepseek/deepseek-v4-pro
 *     stored  $0.435 in / $0.870 out
 *     real    $0.870 in / $1.740 out   (DigitalOcean, cheapest of 17 endpoints)
 *     → we were billing exactly HALF of cost on ~55K turns/month.
 *
 *   anthropic/claude-3-haiku
 *     stored  $0.250 in / $1.000 out
 *     real    $0.250 in / $1.250 out   (Amazon Bedrock, the only endpoint)
 *     → output undercharged by 25%.
 *
 * Everything else in `model_prices` was audited at the same time and is either
 * exact or deliberately marked up; this script touches nothing else.
 * Markup multipliers and min_plan are preserved from the existing rows.
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

const CORRECTIONS: Array<{ modelId: string; inputPricePerM: number; outputPricePerM: number; note: string }> = [
  { modelId: "deepseek/deepseek-v4-pro", inputPricePerM: 0.87, outputPricePerM: 1.74, note: "DigitalOcean cheapest endpoint" },
  { modelId: "anthropic/claude-3-haiku", inputPricePerM: 0.25, outputPricePerM: 1.25, note: "Amazon Bedrock, sole endpoint" },
];

async function main() {
  console.log("=== fix-underpriced-models ===\n");

  for (const c of CORRECTIONS) {
    const existing = await db.execute(sql`
      SELECT id, input_price_per_m, output_price_per_m, min_plan, markup_multiplier, is_active
      FROM model_prices WHERE model_id = ${c.modelId}
    `);

    if (existing.rows.length === 0) {
      console.log(`• ${c.modelId} — NOT FOUND in model_prices, skipping (nothing to correct).`);
      continue;
    }

    for (const row of existing.rows) {
      const r = row as Record<string, unknown>;
      const oldIn = Number(r.input_price_per_m);
      const oldOut = Number(r.output_price_per_m);
      if (oldIn === c.inputPricePerM && oldOut === c.outputPricePerM) {
        console.log(`• ${c.modelId} — already $${oldIn}/$${oldOut}, no change.`);
        continue;
      }
      await db.execute(sql`
        UPDATE model_prices
        SET input_price_per_m = ${c.inputPricePerM},
            output_price_per_m = ${c.outputPricePerM},
            updated_at = NOW()
        WHERE id = ${r.id as string}
      `);
      console.log(
        `• ${c.modelId} — $${oldIn}/$${oldOut} → $${c.inputPricePerM}/$${c.outputPricePerM}` +
        ` (min_plan=${r.min_plan}, markup=${r.markup_multiplier}× preserved) [${c.note}]`
      );
    }
  }

  console.log("\nFinal state:");
  const after = await db.execute(sql`
    SELECT model_id, input_price_per_m, output_price_per_m, min_plan, markup_multiplier, is_active
    FROM model_prices
    WHERE model_id IN ('deepseek/deepseek-v4-pro', 'anthropic/claude-3-haiku')
    ORDER BY model_id
  `);
  for (const row of after.rows) {
    const r = row as Record<string, unknown>;
    console.log(`  ${r.model_id}  $${r.input_price_per_m}/$${r.output_price_per_m}  ${r.min_plan}  ${r.markup_multiplier}×  active=${r.is_active}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Price correction failed:", err);
  process.exit(1);
});
