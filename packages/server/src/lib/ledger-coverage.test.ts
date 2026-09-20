import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ledger-coverage tripwire (owner mandate 2026-09-19: every mushie movement is a
 * credit_transactions row). The database guard enforces this at commit; this
 * test enforces it at build time so a new code path fails review before it
 * fails in production.
 *
 *  1. Every source file that writes credit_wallets.balance also appends to the
 *     ledger through insertHashedTransaction.
 *  2. The guard SQL exists and is wired into both the boot-time installer and the
 *     PGlite test fixture, so tests run under the same rule as production.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ROOT = join(SRC_ROOT, "..");

const BALANCE_WRITE = /balance:\s*sql`|SET\s+balance\s*=|set\(\{\s*balance\b|\bbalance\s*=\s*(?:balance|GREATEST|new_balance)/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

test("every file that writes a wallet balance also appends to the ledger", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    if (!/credit_wallets|creditWallets/.test(text)) continue;
    if (!BALANCE_WRITE.test(text)) continue;
    if (!/insertHashedTransaction\s*\(/.test(text)) offenders.push(file.slice(SRC_ROOT.length + 1));
  }
  assert.deepEqual(
    offenders,
    [],
    "These files change credit_wallets.balance without writing a credit_transactions row. Route the write through deductCredits/refundCredits/syncPlan, or append with insertHashedTransaction in the same transaction:\n" + offenders.join("\n"),
  );
});

test("the ledger guard is installed at boot and in the test fixture", () => {
  const guard = join(SERVER_ROOT, "scripts", "install-ledger-guard.sql");
  assert.ok(existsSync(guard), "scripts/install-ledger-guard.sql is missing");
  const guardSql = readFileSync(guard, "utf8");
  assert.match(guardSql, /CREATE CONSTRAINT TRIGGER credit_wallets_ledger_guard/);
  assert.match(guardSql, /DEFERRABLE INITIALLY DEFERRED/);

  const dbIndex = readFileSync(join(SRC_ROOT, "db", "index.ts"), "utf8");
  assert.match(dbIndex, /"install-ledger-guard\.sql"/, "db/index.ts SCHEDULED_FUNCTION_SCRIPTS must include install-ledger-guard.sql");

  const fixture = readFileSync(join(SRC_ROOT, "test", "database-fixture.ts"), "utf8");
  assert.match(fixture, /install-ledger-guard\.sql/, "the PGlite fixture must install the ledger guard");
});
