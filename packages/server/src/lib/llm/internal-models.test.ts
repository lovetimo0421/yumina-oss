import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  INTERNAL_PERMISSIVE_FALLBACK_MODEL,
  INTERNAL_PINNED_MODELS,
  INTERNAL_PRIMARY_MODEL,
} from "./internal-models.js";

const LIB = dirname(dirname(fileURLToPath(import.meta.url)));

/** Any OpenRouter-style `vendor/model-id` string literal. */
const MODEL_LITERAL = /["'`]([a-z0-9-]+\/[a-z0-9][a-z0-9._:-]{2,})["'`]/g;

/**
 * `vendor/thing` is also the shape of a MIME type, so the pattern above matches
 * the `application/json` in a fetch header. Model vendors are never these.
 */
const NOT_A_VENDOR = new Set([
  "application",
  "audio",
  "font",
  "image",
  "message",
  "multipart",
  "text",
  "video",
]);

test("the guard's list covers every id this module pins", () => {
  // check-models.mts verifies INTERNAL_PINNED_MODELS, not the individual
  // constants. A constant added above but left out of the list would be
  // unguarded — exactly the state the retired fallback id was in.
  assert.deepEqual(
    [...INTERNAL_PINNED_MODELS].sort(),
    [INTERNAL_PRIMARY_MODEL, INTERNAL_PERMISSIVE_FALLBACK_MODEL].sort(),
  );
});

test("primary and fallback are different models", () => {
  // A fallback equal to the primary re-sends the request the primary just
  // refused, turning the retry into a guaranteed second refusal.
  assert.notEqual(INTERNAL_PRIMARY_MODEL, INTERNAL_PERMISSIVE_FALLBACK_MODEL);
});

// Both call sites used to carry their own copies of these two literals. That
// duplication is why `google/gemini-2.0-flash-lite-001` stayed named in the
// code for months after OpenRouter retired it: fixing one file would have left
// the other pointing at a dead id. These tests fail the moment a literal comes
// back, rather than waiting for the two copies to drift.
for (const relPath of ["translate.ts"]) {
  test(`${relPath} names no model id inline`, () => {
    const src = readFileSync(join(LIB, relPath), "utf8");
    const found = [...src.matchAll(MODEL_LITERAL)]
      .map((m) => m[1] ?? "")
      .filter((id) => id !== "" && !NOT_A_VENDOR.has(id.split("/")[0] ?? ""));
    assert.deepEqual(
      found,
      [],
      `${relPath} hardcodes model id(s) ${found.join(", ")} — import them from lib/llm/internal-models.ts instead so check:models covers them.`,
    );
  });
}
