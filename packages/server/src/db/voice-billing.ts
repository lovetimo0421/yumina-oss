import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { LedgerDatabase } from "../lib/transaction-hash.js";

function resource(name: string): string {
  const candidates = [
    resolve(process.cwd(), "scripts", name),
    resolve(process.cwd(), "packages/server/scripts", name),
    fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)),
  ];
  const path = candidates.find(existsSync);
  if (!path) throw Error("VOICE_SCHEMA_RESOURCE_MISSING");
  return readFileSync(path, "utf8");
}
export const voiceBillingDDL = () =>
  resource("voice-billing.sql").replace(/\r\n?/g, "\n");
export const voiceCreditHoldsProtected = () =>
  process.env.VOICE_CREDIT_HOLDS_PROTECTED === "true";
/** One byte-owned predicate serves A1 old-schema cleanup and deletion retention. */
export function legacyObservationQuery(
  root: string,
  user: string,
  world: string | null,
  call: string,
) {
  const body = voiceBillingDDL()
    .split("-- A1 proof begin\n")[1]!
    .split("-- A1 proof end")[0]!
    .replaceAll("%I.usage_logs", "usage_logs")
    .replace("FROM usage_logs", "FROM usage_logs CROSS JOIN proof_args")
    .replaceAll("$1", "p_root")
    .replaceAll("$2", "p_user")
    .replaceAll("$3", "p_world")
    .replaceAll("$4", "p_call");
  return sql`WITH proof_args AS (SELECT ${root}::text AS p_root,${user}::text AS p_user,${world}::text AS p_world,${call}::text AS p_call) ${sql.raw(body)}`;
}
export async function voiceSchemaSnapshot(database: LedgerDatabase) {
  const result = await database.execute(sql`SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname=current_schema() AND c.relname IN ('voice_calls','voice_usage_events') AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.contype,regexp_replace(pg_get_constraintdef(k.oid),current_schema()||'\\.','','g')) ORDER BY c.relname,k.contype,pg_get_constraintdef(k.oid)) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname IN ('voice_calls','voice_usage_events')),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,regexp_replace(pg_get_indexdef(c.oid),current_schema()||'\\.','','g')) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='i' AND c.relname LIKE 'voice_%' AND c.relname NOT LIKE '%_pkey'),
    'functions',(SELECT jsonb_agg(jsonb_build_array(p.proname,regexp_replace(pg_get_functiondef(p.oid),current_schema()||'\\.','','g')) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname IN ('voice_call_guard','voice_event_guard','voice_session_delete','voice_account_delete','voice_reconcile_legacy','voice_legacy_proof')),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,regexp_replace(pg_get_triggerdef(t.oid),current_schema()||'\\.','','g')) ORDER BY t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND t.tgname IN ('voice_call_guard','voice_event_guard','voice_session_delete','voice_account_delete'))
  ) AS snapshot`);
  return (result as unknown as { rows: Array<{ snapshot: unknown }> }).rows[0]!
    .snapshot;
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
export async function voiceBillingReady(
  database: LedgerDatabase,
): Promise<boolean> {
  const expected = JSON.parse(resource("voice-billing-manifest.json")) as {
    ddlSha256: string;
    snapshot: unknown;
  };
  if (
    expected.ddlSha256 !==
    createHash("sha256").update(voiceBillingDDL()).digest("hex")
  )
    throw Error("VOICE_SCHEMA_MANIFEST_STALE");
  return (
    canonical(await voiceSchemaSnapshot(database)) ===
    canonical(expected.snapshot)
  );
}
export async function requireVoiceBilling(
  database: LedgerDatabase,
): Promise<void> {
  if (!(await voiceBillingReady(database)))
    throw Error("VOICE_SCHEMA_NOT_READY");
}
/** Probe first. Never repeatedly acquire DDL locks on an already prepared DB. */
export async function installVoiceBilling(
  database: LedgerDatabase,
): Promise<void> {
  if (await voiceBillingReady(database)) return;
  const client = (
    database as unknown as {
      $client?: { exec?(script: string): Promise<unknown> };
    }
  ).$client;
  if (client?.exec) {
    await client.exec("BEGIN");
    try {
      await client.exec(voiceBillingDDL());
      await requireVoiceBilling(database);
      await client.exec("COMMIT");
    } catch (error) {
      await client.exec("ROLLBACK");
      throw error;
    }
  } else
    await database.transaction(async (tx) => {
      await tx.execute(sql.raw(voiceBillingDDL()));
      await requireVoiceBilling(tx);
    });
}
