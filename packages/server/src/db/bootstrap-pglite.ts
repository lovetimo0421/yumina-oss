import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { db } from "./index.js";
import { env, IS_LOCAL_EDITION } from "../lib/env.js";

/**
 * First boot on an embedded PGlite database: create the whole schema from
 * `schema.ts` with drizzle-kit's programmatic push.
 *
 * Why not the `ensureTables()` DDL suite alone? That suite is a self-heal
 * safety net that lags the real schema (it runs ALTERs against tables it never
 * creates, e.g. world_versions), so a truly empty database dies on its first
 * statement. Hosted never hits this because Neon is provisioned by hand
 * (DB-before-code). A local install has nobody to run `drizzle-kit push`, so
 * the server does the equivalent itself, once, when `worlds` does not exist.
 *
 * drizzle-kit is a runtime dependency for exactly this call and is imported
 * lazily so the hosted boot path never loads it.
 */
export async function bootstrapPgliteSchema(): Promise<void> {
  // Hosted: the database is provisioned by hand before code deploys
  // (DB-before-code), so never touch a real Postgres there. Local edition: an
  // empty self-hosted Postgres gets the same first-boot treatment as PGlite.
  if (env.DATABASE_URL && !IS_LOCAL_EDITION) return;

  const probe = await db.execute(sql`SELECT to_regclass('public.worlds') AS t`);
  const exists = (probe.rows?.[0] as { t: unknown } | undefined)?.t;
  if (exists) return;

  console.log(`[DEV] Fresh ${env.DATABASE_URL ? "Postgres" : "PGlite"} database - creating the schema from schema.ts`);
  const t0 = Date.now();
  // pgvector must exist before push sees the `vector(...)` column types.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  const [{ pushSchema }, schema] = await Promise.all([
    import("drizzle-kit/api"),
    import("./schema.js"),
  ]);
  const { apply, warnings, statementsToExecute } = await pushSchema(
    schema as unknown as Record<string, unknown>,
    db as unknown as PgDatabase<any>,
  );
  for (const w of warnings) console.warn("[DEV] schema push warning:", w);
  await apply();
  console.log(`[DEV] schema created: ${statementsToExecute.length} statements in ${Date.now() - t0}ms`);
}
