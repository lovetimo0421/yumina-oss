/**
 * One-time script: batch-migrate all worlds in the DB to v17.
 *
 * After running, every world's schema will be at version 17.0.0 with
 * clean sequential positions (0,1,2...) per section. The migration
 * chain becomes a no-op on subsequent loads.
 *
 * Usage:
 *   pnpm db:migrate-worlds              (dev DB from .env)
 *   DATABASE_URL="postgresql://..." pnpm db:migrate-worlds   (prod DB)
 *
 * Safe to run multiple times — already-migrated worlds are unchanged.
 */
import { config } from "dotenv";
config({ path: "../../.env" });
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import { worlds } from "./schema.js";
import { migrateWorldDefinition } from "@yumina/engine";
import type { WorldDefinition, WorldEntry } from "@yumina/engine";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const db = drizzle(pool);

function normalizePositions(entries: WorldEntry[]): WorldEntry[] {
  const bySection = new Map<string, WorldEntry[]>();
  for (const entry of entries) {
    if (!bySection.has(entry.section)) bySection.set(entry.section, []);
    bySection.get(entry.section)!.push(entry);
  }
  const result: WorldEntry[] = [];
  for (const sectionEntries of bySection.values()) {
    sectionEntries.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (let i = 0; i < sectionEntries.length; i++) {
      result.push({ ...sectionEntries[i]!, position: i });
    }
  }
  return result;
}

async function migrateAllWorlds() {
  console.log("Loading all worlds...");
  const allWorlds = await db.select({ id: worlds.id, name: worlds.name, schema: worlds.schema }).from(worlds);
  console.log(`Found ${allWorlds.length} worlds.\n`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const world of allWorlds) {
    const schema = world.schema as unknown as WorldDefinition;
    const version = schema?.version;

    try {
      const draft = migrateWorldDefinition(schema);
      draft.entries = normalizePositions(draft.entries);

      // Check if anything actually changed
      const versionChanged = version !== draft.version;
      const entriesChanged = JSON.stringify(schema.entries) !== JSON.stringify(draft.entries);

      if (!versionChanged && !entriesChanged) {
        skipped++;
        continue;
      }

      await db
        .update(worlds)
        .set({ schema: draft as unknown as Record<string, unknown> })
        .where(eq(worlds.id, world.id));

      migrated++;
      console.log(`  ✓ ${world.name} (${world.id.slice(0, 8)}): ${version} → ${draft.version}`);
    } catch (err) {
      errors++;
      console.error(`  ✗ ${world.name} (${world.id.slice(0, 8)}): ${err}`);
    }
  }

  console.log(`\nDone. ${migrated} migrated, ${skipped} already up-to-date, ${errors} errors.`);
  await pool.end();
}

migrateAllWorlds().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
