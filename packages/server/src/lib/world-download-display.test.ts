import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";

// Production may retain this retired flag. It must never freeze the display again.
const previousFlag = process.env.DOWNLOAD_DISPLAY_FROZEN;
process.env.DOWNLOAD_DISPLAY_FROZEN = "true";
const { aggregatedCounters, displayDownloadColumn } = await import("./world-aggregates.js");
if (previousFlag === undefined) delete process.env.DOWNLOAD_DISPLAY_FROZEN;
else process.env.DOWNLOAD_DISPLAY_FROZEN = previousFlag;

const client = new PGlite();
const db = drizzle(client);
before(async () => {
  await client.exec(`
    CREATE TABLE worlds (id text PRIMARY KEY, language_group_id text,
      download_count integer NOT NULL, display_download_count integer);
    INSERT INTO worlds VALUES
      ('solo', NULL, 1454, 1415), ('new', NULL, 12, NULL),
      ('en', 'family', 74, 60), ('zh', 'family', 12, 5);
  `);
});
after(async () => { await client.close(); });

async function counts(id: string) {
  const rows = await db.execute(sql`SELECT ${displayDownloadColumn} AS individual,
    ${aggregatedCounters.displayDownloadCount} AS displayed,
    ${aggregatedCounters.downloadCount} AS live FROM worlds WHERE id = ${id}`);
  return rows.rows[0];
}

it("shows live downloads despite a stale snapshot and legacy freeze flag", async () => {
  assert.deepEqual(await counts("solo"), { individual: 1454, displayed: 1454, live: 1454 });
});
it("shows downloads for cards without a frozen snapshot", async () => {
  assert.deepEqual(await counts("new"), { individual: 12, displayed: 12, live: 12 });
});
it("aggregates live downloads across languages while creator totals stay per-row", async () => {
  assert.deepEqual(await counts("en"), { individual: 74, displayed: 86, live: 86 });
  assert.deepEqual(await counts("zh"), { individual: 12, displayed: 86, live: 86 });
});
it("reflects subsequent downloads without updating the old snapshot", async () => {
  await db.execute(sql`UPDATE worlds SET download_count = download_count + 1 WHERE id = 'new'`);
  assert.deepEqual(await counts("new"), { individual: 13, displayed: 13, live: 13 });
});
