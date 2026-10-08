import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import "../../scripts/test-local-schema.mjs";
import { db } from "./index.js";
import { sql } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
test("bounded native catalog seed is idempotent without model_id uniqueness or unrelated repricing", async () => {
  await db.execute(
    sql`INSERT INTO model_prices(id,model_id,input_price_per_m,output_price_per_m,markup_multiplier) VALUES('unrelated','text-unchanged',9,10,8),('old-r1','gpt-realtime-2.1',1,1,1),('old-r2','gpt-realtime-2.1',1,1,1)`,
  );
  const ddl = await readFile(
    new URL("../../scripts/prepare-native-voice-prices.sql", import.meta.url),
    "utf8",
  ).catch(() => "");
  assert.ok(ddl, "bounded native catalog SQL is missing");
  const client = db.$client;
  assert.ok(client instanceof PGlite);
  await client.exec(ddl);
  await client.exec(ddl);
  const rows = (
    await db.execute(sql`SELECT * FROM model_prices ORDER BY model_id`)
  ).rows;
  assert.equal(rows.length, 3);
  assert.equal(
    rows.find((r) => r.model_id === "text-unchanged")!.markup_multiplier,
    8,
  );
  for (const model of ["gpt-realtime-2.1", "gpt-4o-transcribe"])
    assert.equal(rows.filter((r) => r.model_id === model).length, 1);
});
