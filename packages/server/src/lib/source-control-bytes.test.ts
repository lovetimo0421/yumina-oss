import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

// A `\b` typed through a tool that unescaped it once lands in the file as a backspace byte (0x08). The regex still
// parses, it just never matches: isTruncation in card-translate.ts never saw a cut-off reply (2026-11-21), and the
// same bytes sat in enhance.ts, models.ts, studio-web-fetch.ts and a quest test. No source file needs one.
const packagesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKIP = new Set(["node_modules", "dist", "public", ".turbo", "coverage", "src-tauri", "target"]);
const SOURCE = /\.(?:[cm]?[jt]sx?|json|css|html|sql)$/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name), out); }
    else if (SOURCE.test(entry.name)) out.push(join(dir, entry.name));
  }
}

test("no source file holds a backspace byte where a regex meant \\b", () => {
  const files: string[] = [];
  walk(packagesRoot, files);
  assert.ok(files.length > 500, "walked the packages");
  const hits = files.filter((f) => readFileSync(f).includes(0x08)).map((f) => relative(packagesRoot, f));
  assert.deepEqual(hits, []);
});
