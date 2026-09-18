/**
 * Idempotent migration — add the 2026-09 official model intake to `model_prices`.
 *
 * Run with: pnpm --filter @yumina/server exec tsx src/db/add-models-2026-09.ts
 * Env: DATABASE_URL must point at the target Postgres instance.
 * Apply to DEV first, then PROD (`railway run …`), BEFORE deploying the code that
 * lists these models — `isOfficialModel()` reads this table, so the rows must exist
 * before any user can pick them.
 *
 * Safe to re-run: for each model id we DELETE existing rows first (the table has no
 * unique constraint on model_id alone), then INSERT one fresh active row. Other rows
 * are untouched.
 *
 * Prices are `max(OpenRouter catalog headline, cheapest LIVE endpoint)` as measured
 * 2026-09-06. We pin `provider.sort: "price"`, so the live cheapest is our real unit
 * cost; taking the max of the two means a provider going dark can never flip a model
 * into billing below cost. Note tencent/hy3: its catalog headline ($0.0825/$0.33)
 * is BELOW every live endpoint ($0.126/$0.522 at GMICloud), so the live price wins.
 *
 * Markup follows the existing tier convention: budget 1.15× / standard 1.1× /
 * premium 1.2× / ultra 1.25×.
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
  note: string;
}

const NEW_MODELS: ModelRow[] = [
  // ── budget ────────────────────────────────────────────────────────────────
  { modelId: "z-ai/glm-5.3-flash",             inputPricePerM: 0.075, outputPricePerM: 0.25,  minPlan: "free", markup: 1.15, note: "cheapest strong Chinese; 71% variable compliance" },
  { modelId: "tencent/hy3",                    inputPricePerM: 0.126, outputPricePerM: 0.522, minPlan: "free", markup: 1.15, note: "live price beats catalog headline; explicit-capable" },
  { modelId: "openai/gpt-5.6-luna",            inputPricePerM: 0.20,  outputPricePerM: 1.20,  minPlan: "free", markup: 1.15, note: "no explicit prose — annotated in the picker" },
  // ── standard ──────────────────────────────────────────────────────────────
  { modelId: "google/gemini-3.5-flash-lite",   inputPricePerM: 0.30,  outputPricePerM: 2.50,  minPlan: "free", markup: 1.1,  note: "fastest first token measured (0.5s)" },
  { modelId: "meituan/longcat-2.0",            inputPricePerM: 0.30,  outputPricePerM: 1.20,  minPlan: "free", markup: 1.1,  note: "explicit-capable, no language drift" },
  { modelId: "minimax/minimax-m3",             inputPricePerM: 0.30,  outputPricePerM: 1.20,  minPlan: "free", markup: 1.1,  note: "multilingual prose; in the new default pool" },
  { modelId: "stepfun/step-3.7-flash",         inputPricePerM: 0.20,  outputPricePerM: 1.15,  minPlan: "free", markup: 1.1,  note: "69% variable compliance" },
  { modelId: "mistralai/mistral-large-2512",   inputPricePerM: 0.50,  outputPricePerM: 1.50,  minPlan: "free", markup: 1.1,  note: "76% variable compliance; verbose" },
  { modelId: "thinkingmachines/inkling-small", inputPricePerM: 0.45,  outputPricePerM: 1.20,  minPlan: "free", markup: 1.1,  note: "87% variable compliance, 2nd highest tested" },
  { modelId: "google/gemini-3.7-flash",        inputPricePerM: 0.75,  outputPricePerM: 3.75,  minPlan: "free", markup: 1.1,  note: "the Gemini successor that does NOT refuse (3.6/3.8 do)" },
  // ── premium ───────────────────────────────────────────────────────────────
  { modelId: "openai/gpt-5.4-mini",            inputPricePerM: 0.75,  outputPricePerM: 4.50,  minPlan: "go",   markup: 1.2,  note: "more permissive than the 5.6 family" },
  { modelId: "google/gemini-3.8-flash",        inputPricePerM: 0.75,  outputPricePerM: 3.75,  minPlan: "go",   markup: 1.2,  note: "refuses Japanese adult — annotated in the picker" },
  { modelId: "moonshotai/kimi-k2.6",           inputPricePerM: 0.95,  outputPricePerM: 4.00,  minPlan: "go",   markup: 1.2,  note: "only model explicit on 4/4 turns; 18s to first token" },
  // ── ultra ─────────────────────────────────────────────────────────────────
  { modelId: "openai/gpt-5.6-sol",             inputPricePerM: 2.00,  outputPricePerM: 10.00, minPlan: "plus", markup: 1.25, note: "no explicit prose — annotated in the picker" },
  // ── studio-only ───────────────────────────────────────────────────────────
  { modelId: "openai/gpt-6-astra",             inputPricePerM: 10.00, outputPricePerM: 50.00, minPlan: "plus", markup: 1.25, note: "Studio authoring only; best lorebook prose tested" },
];

async function main() {
  console.log("=== add-models-2026-09: upserting the September model intake ===\n");

  for (const m of NEW_MODELS) {
    const existing = await db.execute(sql`
      SELECT id, input_price_per_m, output_price_per_m FROM model_prices WHERE model_id = ${m.modelId}
    `);

    if (existing.rows.length > 0) {
      const r = existing.rows[0] as Record<string, unknown>;
      console.log(`• ${m.modelId} — replacing ${existing.rows.length} row(s) (was $${r.input_price_per_m}/$${r.output_price_per_m}).`);
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
    console.log(`    → $${m.inputPricePerM}/$${m.outputPricePerM} · ${m.minPlan}+ · ${m.markup}×  (${m.note})`);
  }

  const ids = sql.join(NEW_MODELS.map((m) => sql`${m.modelId}`), sql`, `);
  const after = await db.execute(sql`
    SELECT model_id, input_price_per_m, output_price_per_m, min_plan, markup_multiplier
    FROM model_prices WHERE model_id IN (${ids}) ORDER BY input_price_per_m
  `);
  console.log(`\nVerified ${after.rows.length}/${NEW_MODELS.length} rows present:`);
  for (const row of after.rows) {
    const r = row as Record<string, unknown>;
    console.log(`  ${String(r.model_id).padEnd(34)} $${r.input_price_per_m}/$${r.output_price_per_m}  ${r.min_plan}  ${r.markup_multiplier}×`);
  }

  const total = await db.execute(sql`SELECT count(*)::int AS n FROM model_prices WHERE is_active = TRUE`);
  console.log(`\nActive model_prices rows: ${(total.rows[0] as Record<string, unknown>).n}`);

  await pool.end();
}

main().catch((err) => {
  console.error("Model intake failed:", err);
  process.exit(1);
});
