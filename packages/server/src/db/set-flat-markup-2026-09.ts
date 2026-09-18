/**
 * Idempotent migration — one flat platform fee on the currency.
 *
 * Owner decision 2026-09-14: every official model charges the same 1.20×
 * multiplier on OpenRouter's reported (post-cache) cost, for every plan.
 * Margin lives in mushies-per-dollar of each product, never in per-model
 * multipliers. `openrouter/free` stays at 1.0 (its cost is zero anyway).
 *
 * Run with: pnpm --filter @yumina/server exec tsx src/db/set-flat-markup-2026-09.ts
 * Env: DATABASE_URL must point at the target Postgres instance.
 * Apply to DEV first, then PROD (`railway run …`). Safe to re-run: only rows
 * whose multiplier differs are touched. Pass --dry-run to print without writing.
 *
 * The model-price cache (lib/model-price-cache.ts) refreshes on its own TTL,
 * so the new multiplier reaches charging within minutes of the update.
 */

import { config } from "dotenv";
config({ path: "../../.env" });

import pg from "pg";

const FLAT_MARKUP = 1.2;
const EXEMPT = ["openrouter/free"];

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Refusing to run.");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const pool = new pg.Pool({ connectionString });
try {
  const before = await pool.query(
    `SELECT model_id, markup_multiplier FROM model_prices
      WHERE markup_multiplier IS DISTINCT FROM $1 AND NOT (model_id = ANY($2::text[]))
      ORDER BY model_id`,
    [FLAT_MARKUP, EXEMPT],
  );
  console.log(`${before.rowCount} model(s) not at ${FLAT_MARKUP}×:`);
  for (const r of before.rows) console.log(`  ${r.model_id}: ${r.markup_multiplier} → ${FLAT_MARKUP}`);
  if (dryRun || before.rowCount === 0) {
    console.log(dryRun ? "dry run — nothing written" : "nothing to do");
  } else {
    const res = await pool.query(
      `UPDATE model_prices SET markup_multiplier = $1, updated_at = NOW()
        WHERE markup_multiplier IS DISTINCT FROM $1 AND NOT (model_id = ANY($2::text[]))`,
      [FLAT_MARKUP, EXEMPT],
    );
    console.log(`updated ${res.rowCount} row(s)`);
  }
  const after = await pool.query(`SELECT markup_multiplier, COUNT(*)::int n FROM model_prices GROUP BY 1 ORDER BY 1`);
  console.log("markup distribution now:", after.rows);
} finally {
  await pool.end();
}
