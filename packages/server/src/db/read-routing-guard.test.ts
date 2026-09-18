import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

// ─── Read-routing guard ─────────────────────────────────────────────────────
// Guards against the 2026-06-05 read-replica incident class. The raw `dbRead`
// replica handle must NEVER be imported or used outside db/index.ts. Routes and
// lib must go through the intent-revealing helpers:
//   readOwn(userId)   -> primary  (a user's OWN mutable state + read-before-write guards)
//   readPublic()      -> replica  (public/browse/aggregate reads)
//   readForEdit(v,o)  -> primary iff viewer owns the content
//   readDb(userId?)   -> flag-aware (replica, primary for 5s after the user's own write)
// This keeps own-state reads off the lagging replica and makes the "force all
// reads to primary" sledgehammer impossible to reintroduce piecemeal.
// See CLAUDE.md "DB Read Routing & Connection Safety".

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, ".."); // packages/server/src

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

test("raw `dbRead` handle is used only in db/index.ts — everything else uses readOwn/readPublic/readDb", () => {
  const allowed = new Set([
    join("db", "index.ts"),
    join("db", "read-routing-guard.test.ts"), // this file references dbRead in strings/comments
    // health.ts legitimately needs the raw handle: it pings the replica
    // SPECIFICALLY (dbRead !== db ? probe replica) as an infra health check,
    // which is not a data read. New data reads must still use the helpers.
    join("routes", "health.ts"),
  ]);
  const rawHandle = /\bdbRead\b/; // word boundary so readDb / readPublic never match

  const offenders: string[] = [];
  for (const file of walkTsFiles(srcRoot)) {
    const rel = relative(srcRoot, file);
    if (allowed.has(rel)) continue;
    if (rawHandle.test(readFileSync(file, "utf8"))) offenders.push(rel.split(sep).join("/"));
  }

  assert.deepEqual(
    offenders,
    [],
    `Raw \`dbRead\` replica handle found outside db/index.ts: ${offenders.join(", ")}. ` +
      `Use a routing helper instead — readOwn(userId) for a user's own state, ` +
      `readPublic() for public browse (see CLAUDE.md "DB Read Routing & Connection Safety").`,
  );
});
