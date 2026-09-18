import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── Custom prompts: cross-device clobber guard pins (2026-09-01) ───────────
// Server half of the fix pinned by the app's user-prompts-sync.test.ts:
// a PATCH carrying `expectedUpdatedAt` must be refused with 409 (returning the
// current row) when another device already edited the prompt, and the list
// endpoints must never be answered by a cache.

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "user-prompts.ts"), "utf8").replace(/\r\n/g, "\n");

test("prompt reads are uncacheable", () => {
  const matches = src.match(/c\.header\("Cache-Control", "no-store"\)/g) ?? [];
  assert.ok(matches.length >= 2, `both the list and export endpoints must send no-store, found ${matches.length}`);
});

test("a stale content edit is refused with 409 + the current row", () => {
  assert.match(src, /expectedUpdatedAt/, "PATCH must honor the client's loaded updatedAt");
  assert.match(
    src,
    /\{ error: "conflict", data: current \}, 409/,
    "a mismatch must return 409 with the current row so the client can show the newer version",
  );
  // Compared in JS at ms precision — node-postgres truncates the column's
  // microseconds, so a SQL-level equality on the raw column would false-409
  // the first edit of any defaultNow() row.
  assert.match(src, /\.getTime\(\)/, "timestamps compare in JS, not in SQL");
});
