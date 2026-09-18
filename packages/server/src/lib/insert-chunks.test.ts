import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { messages } from "../db/schema.js";
import { chunkRowsForInsert, INSERT_CHUNK_ROWS } from "./insert-chunks.js";

const POSTGRES_BIND_PARAMETER_LIMIT = 65_535;

function makeMessageRow(): typeof messages.$inferInsert {
  return {
    sessionId: "continued-session",
    role: "user",
    content: "message",
    status: "complete",
    errorMessage: null,
    stateChanges: null,
    swipes: [],
    activeSwipeIndex: 0,
    model: null,
    tokenCount: null,
    generationTimeMs: null,
    compacted: false,
    stateSnapshot: null,
    attachments: null,
    createdAt: new Date(0),
  };
}

test("chunks the 4,382-message production failure case into protocol-safe inserts", () => {
  const db = drizzle.mock({ schema: { messages } });
  const rows = Array.from({ length: 4_382 }, makeMessageRow);

  // This is the exact shape used by shared-playthrough continuation. Drizzle
  // adds the generated message id, producing 16 bound parameters per row.
  const unchunked = db.insert(messages).values(rows).toSQL();
  assert.equal(unchunked.params.length, 70_112);
  assert.ok(unchunked.params.length > POSTGRES_BIND_PARAMETER_LIMIT);

  const chunks = chunkRowsForInsert(rows);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [1_000, 1_000, 1_000, 1_000, 382]);
  assert.equal(chunks.flat().length, rows.length);

  for (const chunk of chunks) {
    const query = db.insert(messages).values(chunk).toSQL();
    assert.ok(query.params.length <= POSTGRES_BIND_PARAMETER_LIMIT);
    assert.ok(chunk.length <= INSERT_CHUNK_ROWS);
  }
});

test("returns no insert chunks for an empty row set", () => {
  assert.deepEqual(chunkRowsForInsert([]), []);
});

test("rejects invalid insert chunk sizes", () => {
  assert.throws(() => chunkRowsForInsert([1], 0), RangeError);
  assert.throws(() => chunkRowsForInsert([1], 1.5), RangeError);
});
