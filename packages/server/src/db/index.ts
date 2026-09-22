import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { vector as pgliteVector } from "@electric-sql/pglite/vector";
import pg from "pg";
import { sql, notInArray, type SQL } from "drizzle-orm";
import { MAX_WORLD_TAGS } from "@yumina/shared";
import * as schema from "./schema.js";
import { USER_MUTES_STATEMENTS } from "./user-mutes-ddl.js";
import { WORLD_AUDIENCE_DDL } from "./world-audience-ddl.js";
import {
  PLAN_ENTITLEMENT_SOURCE_CHECK,
  PLAN_ENTITLEMENT_SOURCE_CONSTRAINT_DDL,
} from "./plan-entitlement-source-constraint.js";
import { ACHIEVEMENT_GROUPS, ACHIEVEMENTS } from "../lib/achievements/definitions.js";
import { env } from "../lib/env.js";
import { redis } from "../lib/redis.js";
import { posthog, captureServerError } from "../lib/posthog.js";
import { armConnectionErrorHandling, armReadOnlyEviction, makeReadOnlyVerify } from "./pool-guards.js";
import { armQueryDeadlines } from "./query-deadline.js";
import { runtimeIdentity } from "../lib/runtime-identity.js";
import { runExclusive } from "../lib/leader.js";
import { setReadAfterWriteFlag } from "../lib/read-after-write.js";
import { invalidateEngagementStatsCache } from "../lib/engagement.js";

// Fix: pg driver interprets `timestamp without time zone` as local time,
// but Neon stores UTC. Force UTC interpretation so timestamps are correct
// regardless of server timezone.
pg.types.setTypeParser(1114, (val: string) => new Date(val + "Z"));

const IS_PGLITE = !env.DATABASE_URL;

// ── Observability (R5, 2026-06-09) ──────────────────────────────────────────

const SLOW_QUERY_MS = 500;

// Railway sets this per replica — lets PostHog segment latency by region
// (Asia instances pay ~10x the us-west RTT to Neon; without this tag the
// regional populations blur into one misleading average).
const INSTANCE_REGION = process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? "unknown";

/**
 * Time every promise-form query on the pool and surface slow ones (>500ms) to
 * logs + PostHog. Passive: attaches a non-throwing observer to the existing
 * promise, never alters results or errors.
 */
function instrumentPool(pool: pg.Pool, label: string): void {
  const orig = pool.query.bind(pool);
  (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    if (typeof args[args.length - 1] === "function") return (orig as (...a: unknown[]) => unknown)(...args);
    const start = Date.now();
    const result = (orig as (...a: unknown[]) => unknown)(...args);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(
        () => {
          const ms = Date.now() - start;
          if (ms > SLOW_QUERY_MS) {
            const first = args[0] as string | { text?: string } | undefined;
            const text = String(typeof first === "string" ? first : first?.text ?? "").slice(0, 200);
            console.warn(`[DB] Slow query (${ms}ms, ${label}): ${text}`);
            posthog.capture({
              distinctId: "server",
              event: "slow_query",
              properties: { ...runtimeIdentity, pool: label, duration_ms: ms, query: text },
            });
          }
        },
        () => {
          /* errors are the caller's to handle; this observer must never interfere */
        },
      );
    }
    return result;
  };
}

/**
 * Connection lifecycle counter: emits one event per minute with how many NEW
 * connections each pool created. The Singapore replica's ~950ms slow-query
 * p50 matches full connection-establishment cost (5-6 cross-Pacific RTTs) —
 * this counter proves or kills that theory: high connects/min = conns are
 * being created per-burst (or dying silently) instead of staying warm.
 */
function trackPoolConnects(pool: pg.Pool, label: string): void {
  let connects = 0;
  pool.on("connect", () => {
    connects += 1;
  });
  const interval = setInterval(() => {
    if (connects === 0) return;
    const made = connects;
    connects = 0;
    console.log(`[DB] Pool ${label}: ${made} new connection(s) in the last minute (region=${INSTANCE_REGION})`);
    posthog.capture({
      distinctId: "server",
      event: "pool_connects",
      properties: { ...runtimeIdentity, pool: label, connects: made },
    });
  }, 60_000);
  interval.unref();
}

/**
 * Pool saturation gauge: every 60s, alert when a pool is ≥80% occupied or has
 * waiters. This is the measurement that GATES the idle-timeout tuning (P5) —
 * do not raise idleTimeoutMillis until this gauge shows steady headroom in
 * prod. Interval is unref()ed so it never keeps a draining process alive.
 */
function startPoolGauge(pool: pg.Pool, label: string, max: number): void {
  const interval = setInterval(() => {
    const { totalCount, idleCount, waitingCount } = pool;
    if (waitingCount > 0 || totalCount >= max * 0.8) {
      console.warn(`[DB] Pool pressure (${label}): total=${totalCount}/${max} idle=${idleCount} waiting=${waitingCount}`);
      posthog.capture({
        distinctId: "server",
        event: "pool_saturation",
        properties: { ...runtimeIdentity, pool: label, total: totalCount, idle: idleCount, waiting: waitingCount, max },
      });
    }
  }, 60_000);
  interval.unref();
}

export type DrizzleDB = ReturnType<typeof drizzlePg<typeof schema>> | ReturnType<typeof drizzlePglite<typeof schema>>;

let db: DrizzleDB;
let pgliteClient: PGlite | null = null;
let dbRead: DrizzleDB;

// Prod (Railway↔Neon, same metro) connects in well under a second, so a 5s
// cap surfaces genuinely broken paths fast. Dev machines reach the dev DB
// over long, degraded routes where the TCP+TLS+auth handshake alone measures
// ~4s — a 5s cap flaps on every pool connect there: boot self-heal dies with
// connection timeouts, sends fail as "network error", DB tests flake.
const CONNECT_TIMEOUT_MS = process.env.NODE_ENV === "production" ? 5_000 : 30_000;

if (!IS_PGLITE) {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    // Reject NEW connections that land on a read-only backend (Neon compute
    // migration glitch — 2026-08-18 incident). pg-pool supports `verify` but
    // @types/pg doesn't declare it, hence the cast below where this object is
    // passed. See db/pool-guards.ts for the full incident write-up.
    verify: makeReadOnlyVerify("primary"),
    // Raised 50→100 (2026-07-06). pool_saturation telemetry showed the primary
    // pool pegged at 50/50 with up to 66 requests WAITING during traffic peaks
    // (chronic since ~06-26) — an APP-SIDE bottleneck, not Neon: backend
    // max_connections=901 with only ~11-23 in use, and Neon's PgBouncer
    // multiplexes our client conns down to a handful of backends, so a bigger
    // client pool can't exhaust the backend. Read routing is unchanged (the
    // replica still sheds browse load — do NOT funnel reads onto primary; see
    // the 2026-06-05 incident note below). Gauge-monitored: raise further only
    // if waiters persist. The real cure is cutting hold-time (occasional ~60s
    // play_sessions holds, run_daily_credit_recovery() on the hot path).
    max: env.DATABASE_POOL_MAX,
    // 5 min, matching Neon's pooler-side connection lifetime. The original 30s
    // killed idle conns so aggressively that regional instances paid a full
    // TCP+TLS+auth handshake to us-west on a large share of queries — measured
    // 2026-06-10 as a flat ~0.9-1.3s "slow query" floor on even single-row PK
    // lookups, while warm-connection queries ran in ms (/health ≈ 0.2s total).
    // Gauge-gated change: pool_saturation showed 50 total / 18 idle / 0
    // waiting, so keeping conns warm cannot starve the pool.
    idleTimeoutMillis: 300_000,
    keepAlive: true,
    // First TCP keepalive probe after 30s idle (Node's default leaves the OS
    // 7200s TCP_KEEPIDLE, useless against ~60s NAT idle timeouts on the
    // Railway↔Neon path — a silently-dead conn costs a full re-handshake on
    // the next query, ~1s from Singapore).
    keepAliveInitialDelayMillis: 30_000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Note: statement_timeout cannot be set via connection options on Neon's
    // pooler (rejects startup parameters). Set it at the Neon role level instead.
  } as pg.PoolConfig);
  // An idle pooled client can error outside any query (Neon maintenance
  // restart, network blip). Without this listener the pool's 'error' event is
  // unhandled and crashes the entire process, killing every in-flight stream.
  pool.on("error", (err) => {
    console.error("[DB] Idle client error (primary pool):", err.message);
    captureServerError("pg-pool-primary", err);
  });
  armConnectionErrorHandling(pool, "primary");
  // A connection that turns read-only MID-LIFE (25006) must be destroyed on
  // release — the drizzle transaction path releases cleanly after ROLLBACK and
  // would otherwise recycle the poisoned client forever (2026-08-18 incident).
  armReadOnlyEviction(pool, "primary");
  armQueryDeadlines(pool, "primary", env.DATABASE_QUERY_TIMEOUT_MS, (error) => {
    console.error(`[DB] Query deadline; discarding primary connection (replica=${runtimeIdentity.replica_id}):`, error.message);
    captureServerError("pg-query-timeout", error, { pool: "primary", timeout_ms: error.timeoutMs, outcome: error.outcome });
  });
  instrumentPool(pool, "primary");
  startPoolGauge(pool, "primary", env.DATABASE_POOL_MAX);
  trackPoolConnects(pool, "primary");
  db = drizzlePg(pool, { schema });

  // Read replica — falls back to primary if DATABASE_READ_URL is not set.
  //
  // ⚠️ NEVER force `dbRead = db` unconditionally to mask a stale read. Doing so
  // disables this separate read pool and funnels ALL reads onto the primary's
  // 50-connection pool → connection exhaustion → outage (the 2026-06-05 incident).
  // Fix stale reads at the CALL SITE instead: readOwn() for a user's own state,
  // readPublic() for public browse (see CLAUDE.md "DB Read Routing & Connection
  // Safety"). The raw `dbRead` handle must stay inside this file — routes/lib use
  // the helpers; enforced by db/read-routing-guard.test.ts.
  if (env.DATABASE_READ_URL) {
    const readPool = new pg.Pool({
      connectionString: env.DATABASE_READ_URL,
      max: 80,
      // 5 min + keepalive — same churn fix as the primary pool above.
      idleTimeoutMillis: 300_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // Note: statement_timeout cannot be set via connection options on Neon's
    // pooler (rejects startup parameters). Set it at the Neon role level instead.
    });
    readPool.on("error", (err) => {
      console.error("[DB] Idle client error (read pool):", err.message);
      captureServerError("pg-pool-read", err);
    });
    armConnectionErrorHandling(readPool, "read");
    armQueryDeadlines(readPool, "read", env.DATABASE_QUERY_TIMEOUT_MS, (error) => {
      console.error(`[DB] Query deadline; discarding read connection (replica=${runtimeIdentity.replica_id}):`, error.message);
      captureServerError("pg-query-timeout", error, { pool: "read", timeout_ms: error.timeoutMs, outcome: error.outcome });
    });
    instrumentPool(readPool, "read");
    startPoolGauge(readPool, "read", 80);
    trackPoolConnects(readPool, "read");
    dbRead = drizzlePg(readPool, { schema });
    console.log("[DB] Read replica connected");
  } else {
    dbRead = db;
  }
} else {
  console.log("[DEV] No DATABASE_URL — using in-memory PGlite");
  console.log(`[DEV] PGlite data dir: ${env.PGLITE_DATA_DIR}`);
  // pgvector ships with PGlite; without it the worlds.embedding column can't
  // exist locally and every `SELECT * FROM worlds` (drizzle selects all mapped
  // columns) errors. PGlite queues queries until init completes, so the
  // fire-and-forget CREATE EXTENSION runs before any app query.
  // PGlite creates its own directory but not the parents. A fresh install has
  // no ./data yet (YUMINA_DATA_DIR/pglite), so make the parent first or the
  // embedded database dies with ENOENT before the first query.
  if (!env.PGLITE_DATA_DIR.startsWith("memory://")) {
    fs.mkdirSync(path.dirname(path.resolve(env.PGLITE_DATA_DIR)), { recursive: true });
  }
  const client = new PGlite(env.PGLITE_DATA_DIR, { extensions: { vector: pgliteVector } });
  pgliteClient = client;
  void client
    .exec("CREATE EXTENSION IF NOT EXISTS vector")
    .catch((err) => console.warn("[DEV] PGlite vector extension init failed:", err instanceof Error ? err.message : err));
  db = drizzlePglite(client, { schema });
  dbRead = db;
}

/**
 * Run a multi-statement SQL script (DO blocks, CREATE FUNCTION, several DDL
 * statements in one string). node-postgres sends a parameter-less
 * `db.execute(sql.raw(...))` over the simple protocol, which accepts that.
 * PGlite always uses the extended protocol and rejects it with "cannot insert
 * multiple commands into a prepared statement", so scripts go through its
 * simple `exec` path instead. Single-connection PGlite needs no advisory
 * locking or lock_timeout around DDL, so callers skip those there.
 */
export async function executeSqlScript(text: string): Promise<void> {
  if (pgliteClient) {
    await pgliteClient.exec(text);
    return;
  }
  await db.execute(sql.raw(text));
}

export async function ensureSessionPersonaColumn() {
  await db.execute(sql`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_persona JSONB`);
  await db.execute(sql`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS persona_locked BOOLEAN NOT NULL DEFAULT false`);
}

const TABLE_DDLS = [
  `CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    email_verified BOOLEAN NOT NULL DEFAULT false, image TEXT, banner TEXT,
    bio TEXT, location TEXT, website TEXT, username TEXT UNIQUE,
    birth_year INTEGER, featured_world_id TEXT, preferences JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  ...USER_MUTES_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS jwks (
    id TEXT PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(), expires_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY, expires_at TIMESTAMP NOT NULL, token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ip_address TEXT, user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    access_token TEXT, refresh_token TEXT, id_token TEXT,
    access_token_expires_at TIMESTAMP, refresh_token_expires_at TIMESTAMP,
    scope TEXT, password TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS deleted_account_tombstones (
    identity_hash TEXT PRIMARY KEY,
    was_banned BOOLEAN NOT NULL DEFAULT false,
    block_welcome_rewards BOOLEAN NOT NULL DEFAULT true,
    block_invite_redemption BOOLEAN NOT NULL DEFAULT true,
    last_checkin_day TEXT,
    reward_blocked_until TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS account_deletion_cleanup_jobs (
    id TEXT PRIMARY KEY,
    deleted_user_id TEXT NOT NULL,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    stripe_connect_id TEXT,
    stripe_payment_intent_ids JSONB NOT NULL DEFAULT '[]',
    stripe_checkout_session_ids JSONB NOT NULL DEFAULT '[]',
    asset_keys JSONB NOT NULL DEFAULT '[]',
    asset_prefixes JSONB NOT NULL DEFAULT '[]',
    session_tokens JSONB NOT NULL DEFAULT '[]',
    verification_identifiers JSONB NOT NULL DEFAULT '[]',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
    finalize_after TIMESTAMP NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT DEFAULT '', extended_description TEXT,
    schema JSONB NOT NULL DEFAULT '{}', thumbnail_url TEXT,
    is_published BOOLEAN DEFAULT false, status TEXT NOT NULL DEFAULT 'draft',
    is_nsfw BOOLEAN DEFAULT false, allow_edit BOOLEAN DEFAULT true,
    allow_custom_api BOOLEAN NOT NULL DEFAULT true,
    allow_reviews BOOLEAN NOT NULL DEFAULT true,
    age_rating TEXT NOT NULL DEFAULT 'all', visibility TEXT NOT NULL DEFAULT 'public',
    download_count INTEGER NOT NULL DEFAULT 0,
    tags JSONB NOT NULL DEFAULT '[]', gallery_images JSONB DEFAULT '[]',
    announcement TEXT, total_tokens INTEGER DEFAULT 0, approx_time TEXT,
    source_world_id TEXT,
    custom_ui_loc INTEGER, has_audio BOOLEAN, cover_crop JSONB, gallery_cover_crop JSONB,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT worlds_tags_max CHECK (jsonb_array_length(tags) <= 10)
  )`,
  `CREATE TABLE IF NOT EXISTS play_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    state JSONB NOT NULL DEFAULT '{}', summary TEXT,
    summary_updated_at TIMESTAMP,
    summary_model TEXT,
    summaryception_model TEXT,
    summary_implementation TEXT NOT NULL DEFAULT 'localdev',
    summary_mode TEXT NOT NULL DEFAULT 'threshold',
    summary_included BOOLEAN NOT NULL DEFAULT true,
    summary_trigger_tokens INTEGER,
    summary_recent_tail_tokens INTEGER,
    summary_status TEXT NOT NULL DEFAULT 'idle',
    summary_error TEXT,
    summary_source_hash TEXT,
    summary_covers_until_message_id TEXT,
    summary_token_count INTEGER,
    summaryception_status TEXT NOT NULL DEFAULT 'idle',
    summaryception_error TEXT,
    summaryception_updated_at TIMESTAMP,
    summaryception_source_hash TEXT,
    summaryception_covers_until_message_id TEXT,
    summaryception_token_count INTEGER,
    summaryception_included BOOLEAN NOT NULL DEFAULT false,
    session_memory JSONB, session_memory_updated_at TIMESTAMP,
    session_memory_model TEXT,
    session_memory_included BOOLEAN NOT NULL DEFAULT true,
    session_memory_status TEXT NOT NULL DEFAULT 'idle',
    session_memory_error TEXT,
    session_memory_source_hash TEXT,
    session_memory_processed_message_id TEXT,
    session_memory_retry_count INTEGER NOT NULL DEFAULT 0,
    session_memory_stale_at TIMESTAMP,
    session_memory_pinned TEXT,
    pending_since_message_id TEXT,
    pending_message_count INTEGER NOT NULL DEFAULT 0,
    playtime_seconds INTEGER NOT NULL DEFAULT 0,
    playtime_lease_id TEXT, playtime_last_seen_at TIMESTAMP, last_heartbeat_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS user_library (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    last_played_at TIMESTAMP, last_seen_update_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, world_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL,
    state_changes JSONB,
    swipes JSONB DEFAULT '[]', active_swipe_index INTEGER DEFAULT 0,
    model TEXT, token_count INTEGER, generation_time_ms INTEGER,
    compacted BOOLEAN NOT NULL DEFAULT false, summaryception_compacted BOOLEAN NOT NULL DEFAULT false, state_snapshot JSONB, attachments JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS summaryception_snippets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
    layer_index INTEGER NOT NULL DEFAULT 0,
    snippet_order INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    source_start_message_id TEXT,
    source_end_message_id TEXT,
    source_start_ordinal INTEGER,
    source_end_ordinal INTEGER,
    source_hash TEXT,
    from_layer INTEGER,
    merged_count INTEGER,
    promoted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    type TEXT NOT NULL, filename TEXT NOT NULL, url TEXT NOT NULL,
    size_bytes INTEGER, mime_type TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS world_memories (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    content TEXT NOT NULL, category TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 5, session_id TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL, messages JSONB NOT NULL, state JSONB NOT NULL, summary TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS prompt_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS user_prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    folder_id TEXT REFERENCES prompt_folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
    section TEXT NOT NULL DEFAULT 'system-presets',
    enabled BOOLEAN NOT NULL DEFAULT true, depth INTEGER, position REAL,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS user_preset_overrides (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    preset_id TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
    content TEXT, api_role TEXT,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, preset_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_personas (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    avatar_url TEXT, appearance TEXT, personality TEXT, backstory TEXT,
    note TEXT,
    is_active BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`,
  // Per-world persona pin. Dev + prod got this via explicit SQL on 2026-08-14
  // (DB-before-code); this entry keeps PGlite / fresh local DBs in sync.
  `CREATE TABLE IF NOT EXISTS user_world_personas (
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    persona_id TEXT NOT NULL REFERENCES user_personas(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT user_world_personas_user_world_uniq UNIQUE (user_id, world_id)
  )`,
  `CREATE TABLE IF NOT EXISTS asset_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL, parent_folder_id TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS user_assets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    type TEXT NOT NULL, filename TEXT NOT NULL, url TEXT NOT NULL,
    size_bytes INTEGER, mime_type TEXT,
    folder_id TEXT REFERENCES asset_folders(id) ON DELETE SET NULL,
    source_asset_id TEXT, is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS asset_references (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES user_assets(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS bundles (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT DEFAULT '',
    tags JSONB NOT NULL DEFAULT '[]', content JSONB NOT NULL DEFAULT '{}',
    is_public BOOLEAN NOT NULL DEFAULT false, is_official BOOLEAN NOT NULL DEFAULT false,
    cover_image TEXT, download_count INTEGER NOT NULL DEFAULT 0,
    like_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT bundles_tags_max CHECK (jsonb_array_length(tags) <= 10)
  )`,
  `CREATE TABLE IF NOT EXISTS tip_payment_intents (
    id TEXT PRIMARY KEY,
    stripe_payment_intent_id TEXT UNIQUE,
    sender_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    creator_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    world_id TEXT REFERENCES worlds(id) ON DELETE SET NULL,
    bundle_id TEXT REFERENCES bundles(id) ON DELETE SET NULL,
    amount INTEGER NOT NULL,
    message TEXT,
    is_anonymous BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS bundle_likes (
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT bundle_likes_uniq UNIQUE(user_id, bundle_id)
  )`,
  `CREATE TABLE IF NOT EXISTS dismissed_bundles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_id, bundle_id)
  )`,
  `CREATE TABLE IF NOT EXISTS favorites (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_id, world_id)
  )`,
  `CREATE TABLE IF NOT EXISTS follows (
    id TEXT PRIMARY KEY,
    follower_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    following_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(), UNIQUE(follower_id, following_id)
  )`,
  `CREATE TABLE IF NOT EXISTS profile_posts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS friend_invites (
    id TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    to_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    world_id TEXT REFERENCES worlds(id) ON DELETE SET NULL,
    join_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    responded_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    hide_blocked_worlds BOOLEAN NOT NULL DEFAULT true,
    hide_own_worlds BOOLEAN NOT NULL DEFAULT true,
    hide_blocked_activity BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    UNIQUE(blocker_id, blocked_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL, content TEXT,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, world_id)
  )`,
  `CREATE TABLE IF NOT EXISTS extension_stats (
    extension_key TEXT PRIMARY KEY,
    download_count INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    average_rating REAL NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS user_extensions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    extension_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'installed',
    installed_at TIMESTAMP DEFAULT NOW(),
    uninstalled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, extension_key)
  )`,
  // Comment feed: append-only, so no UNIQUE(user, extension) and rating is
  // nullable (a comment without stars). Live ratings live in extension_ratings.
  // Existing databases are reshaped by
  // scripts/2026-08-27-bundle-extension-reviews-to-comments.sql — this DDL only
  // ever builds a fresh one.
  `CREATE TABLE IF NOT EXISTS extension_reviews (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    extension_key TEXT NOT NULL,
    rating INTEGER, content TEXT,
    reply_count INTEGER NOT NULL DEFAULT 0,
    hidden_by_creator_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS extension_ratings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    extension_key TEXT NOT NULL,
    rating INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, extension_key)
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'openrouter',
    encrypted_key TEXT NOT NULL, key_iv TEXT NOT NULL, key_tag TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'Default',
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS studio_conversations (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New Conversation',
    messages JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES studio_conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running',
    messages JSONB NOT NULL DEFAULT '[]', pending_tool_calls JSONB,
    read_tool_results JSONB, text_content TEXT,
    iteration INTEGER NOT NULL DEFAULT 0, max_iterations INTEGER NOT NULL DEFAULT 10,
    model TEXT NOT NULL, context JSONB, error TEXT,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS achievements (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT, icon TEXT,
    rarity TEXT NOT NULL DEFAULT 'Common', condition JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS user_achievements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    session_id TEXT, earned_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, achievement_id)
  )`,
  `CREATE TABLE IF NOT EXISTS world_updates (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    title TEXT NOT NULL, content TEXT, is_major BOOLEAN DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    actor_user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
    type TEXT NOT NULL, dedupe_key TEXT, payload JSONB NOT NULL,
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS usage_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES play_sessions(id) ON DELETE SET NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    endpoint TEXT NOT NULL,
    api_key_tier TEXT NOT NULL DEFAULT 'regular',
    generation_time_ms INTEGER,
    provider_cost_usd NUMERIC(24,12), provider_request_id TEXT,
    analytics_world_id TEXT, token_measurement TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS world_click_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    world_name TEXT NOT NULL,
    world_thumbnail_url TEXT,
    source TEXT NOT NULL,
    interaction TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    max_redemptions INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT true,
    note TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS invite_code_redemptions (
    id TEXT PRIMARY KEY,
    invite_code_id TEXT NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    redeemed_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  // Claimed referral reward milestones (one row per user+threshold). Prod/dev
  // (Neon) get this via db:push; this keeps fresh PGlite / new-contributor DBs
  // in parity so the invite reward ladder works locally.
  `CREATE TABLE IF NOT EXISTS referral_milestones (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    milestone INTEGER NOT NULL,
    reward_type TEXT NOT NULL,
    reward_detail TEXT,
    granted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT referral_milestones_user_milestone UNIQUE (user_id, milestone)
  )`,
  `CREATE TABLE IF NOT EXISTS daily_checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    day_key TEXT NOT NULL,
    week_key TEXT NOT NULL,
    reward_index INTEGER NOT NULL,
    reward_amount INTEGER NOT NULL,
    time_zone TEXT NOT NULL,
    claimed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, day_key)
  )`,
  `CREATE TABLE IF NOT EXISTS user_checkin_stats (
    user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    time_zone TEXT,
    current_streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    total_checkins INTEGER NOT NULL DEFAULT 0,
    last_day_key TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS platform_achievement_groups (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS platform_achievements (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES platform_achievement_groups(id) ON DELETE CASCADE,
    key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    badge TEXT,
    metric_key TEXT,
    trigger_type TEXT NOT NULL DEFAULT 'event',
    is_capstone BOOLEAN NOT NULL DEFAULT false,
    tier TEXT NOT NULL DEFAULT 'Common',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS platform_achievement_tiers (
    id TEXT PRIMARY KEY,
    achievement_id TEXT NOT NULL REFERENCES platform_achievements(id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'bronze',
    threshold INTEGER NOT NULL DEFAULT 1,
    badge TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(achievement_id, level)
  )`,
  `CREATE TABLE IF NOT EXISTS user_platform_achievements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    achievement_id TEXT NOT NULL REFERENCES platform_achievements(id) ON DELETE CASCADE,
    tier_level TEXT NOT NULL DEFAULT 'bronze',
    earned_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, achievement_id, tier_level)
  )`,
  `CREATE TABLE IF NOT EXISTS user_achievement_progress (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    metric_key TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, metric_key)
  )`,
];

const INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS session_user_id_idx ON session(user_id)`,
  `CREATE INDEX IF NOT EXISTS account_user_id_idx ON account(user_id)`,
  `CREATE INDEX IF NOT EXISTS worlds_creator_id_idx ON worlds(creator_id)`,
  `CREATE INDEX IF NOT EXISTS worlds_status_idx ON worlds(status)`,
  `CREATE INDEX IF NOT EXISTS worlds_language_group_id_idx ON worlds(language_group_id)`,
  `CREATE INDEX IF NOT EXISTS play_sessions_user_id_idx ON play_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS play_sessions_world_id_idx ON play_sessions(world_id)`,
  `CREATE INDEX IF NOT EXISTS play_sessions_user_world_idx ON play_sessions(user_id, world_id)`,
  `CREATE INDEX IF NOT EXISTS user_library_user_id_idx ON user_library(user_id)`,
  `CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id)`,
  `CREATE INDEX IF NOT EXISTS messages_session_created_idx ON messages(session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS assets_world_id_idx ON assets(world_id)`,
  `CREATE INDEX IF NOT EXISTS world_memories_world_user_idx ON world_memories(world_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS checkpoints_session_id_idx ON checkpoints(session_id)`,
  `CREATE INDEX IF NOT EXISTS favorites_world_id_idx ON favorites(world_id)`,
  `CREATE INDEX IF NOT EXISTS bundle_likes_bundle_id_idx ON bundle_likes(bundle_id)`,
  `CREATE INDEX IF NOT EXISTS bundle_likes_user_id_idx ON bundle_likes(user_id)`,
  `CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_type_dedupe_uniq ON notifications(user_id, type, dedupe_key) WHERE dedupe_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS usage_logs_user_id_idx ON usage_logs(user_id)`,
  `CREATE INDEX IF NOT EXISTS usage_logs_created_at_idx ON usage_logs(created_at)`,
  `CREATE INDEX IF NOT EXISTS world_click_history_user_id_idx ON world_click_history(user_id)`,
  `CREATE INDEX IF NOT EXISTS world_click_history_world_id_idx ON world_click_history(world_id)`,
  `CREATE INDEX IF NOT EXISTS world_click_history_created_at_idx ON world_click_history(created_at)`,
  `CREATE INDEX IF NOT EXISTS tip_payment_intents_sender_idx ON tip_payment_intents(sender_id)`,
  `CREATE INDEX IF NOT EXISTS tip_payment_intents_creator_idx ON tip_payment_intents(creator_id)`,
  `CREATE INDEX IF NOT EXISTS tip_payment_intents_pi_idx ON tip_payment_intents(stripe_payment_intent_id)`,
  `CREATE INDEX IF NOT EXISTS world_updates_world_id_idx ON world_updates(world_id)`,
  `CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys(user_id)`,
  `CREATE INDEX IF NOT EXISTS reviews_world_id_idx ON reviews(world_id)`,
  `CREATE INDEX IF NOT EXISTS user_extensions_user_id_idx ON user_extensions(user_id)`,
  `CREATE INDEX IF NOT EXISTS user_extensions_key_status_idx ON user_extensions(extension_key, status)`,
  `CREATE INDEX IF NOT EXISTS extension_reviews_key_idx ON extension_reviews(extension_key)`,
  `CREATE INDEX IF NOT EXISTS extension_reviews_user_id_idx ON extension_reviews(user_id)`,
  `CREATE INDEX IF NOT EXISTS extension_ratings_key_idx ON extension_ratings(extension_key)`,
  `CREATE INDEX IF NOT EXISTS extension_ratings_user_id_idx ON extension_ratings(user_id)`,
  `CREATE INDEX IF NOT EXISTS follows_follower_id_idx ON follows(follower_id)`,
  `CREATE INDEX IF NOT EXISTS profile_posts_user_created_idx ON profile_posts(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS follows_following_id_idx ON follows(following_id)`,
  `CREATE INDEX IF NOT EXISTS user_blocks_blocker_idx ON user_blocks(blocker_id)`,
  `CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks(blocked_id)`,
  `CREATE INDEX IF NOT EXISTS favorites_user_id_idx ON favorites(user_id)`,
  `CREATE INDEX IF NOT EXISTS reviews_user_id_idx ON reviews(user_id)`,
  `CREATE INDEX IF NOT EXISTS notifications_user_read_idx ON notifications(user_id, read)`,
  `CREATE INDEX IF NOT EXISTS messages_session_compacted_idx ON messages(session_id, compacted)`,
  `CREATE INDEX IF NOT EXISTS messages_session_summaryception_compacted_idx ON messages(session_id, summaryception_compacted)`,
  `CREATE INDEX IF NOT EXISTS summaryception_snippets_session_layer_idx ON summaryception_snippets(session_id, layer_index, snippet_order)`,
  `CREATE INDEX IF NOT EXISTS summaryception_snippets_session_idx ON summaryception_snippets(session_id)`,
  // 2026-09-07 — unindexed foreign keys / lookups found via pg_stat_user_tables
  // (seq_scan counts since 07-28): user_prompts 4.4M, prompt_folders 4.4M,
  // posts 4.8M, dm read cursors 456k, bundles 286k, user_assets 233k; the
  // Better Auth OAuth lookup on account(provider_id, account_id) ran at 86ms.
  `CREATE INDEX IF NOT EXISTS user_prompts_user_id_idx ON user_prompts(user_id)`,
  `CREATE INDEX IF NOT EXISTS prompt_folders_user_id_idx ON prompt_folders(user_id)`,
  `CREATE INDEX IF NOT EXISTS user_assets_user_id_idx ON user_assets(user_id)`,
  `CREATE INDEX IF NOT EXISTS asset_folders_user_id_idx ON asset_folders(user_id)`,
  `CREATE INDEX IF NOT EXISTS posts_author_id_idx ON posts(author_id)`,
  `CREATE INDEX IF NOT EXISTS bundles_user_id_idx ON bundles(user_id)`,
  `CREATE INDEX IF NOT EXISTS dmrc_user_id_idx ON direct_message_read_cursors(user_id)`,
  `CREATE INDEX IF NOT EXISTS account_provider_account_idx ON account(provider_id, account_id)`,
  `CREATE INDEX IF NOT EXISTS support_prompt_events_session_id_idx ON support_prompt_events(session_id)`,
  `CREATE INDEX IF NOT EXISTS daily_checkins_user_week_idx ON daily_checkins(user_id, week_key)`,
  `CREATE INDEX IF NOT EXISTS platform_achievements_group_id_idx ON platform_achievements(group_id)`,
  `CREATE INDEX IF NOT EXISTS user_platform_achievements_user_id_idx ON user_platform_achievements(user_id)`,
  `CREATE INDEX IF NOT EXISTS platform_achievement_tiers_achievement_id_idx ON platform_achievement_tiers(achievement_id)`,
  `CREATE INDEX IF NOT EXISTS user_achievement_progress_user_id_idx ON user_achievement_progress(user_id)`,
  `CREATE INDEX IF NOT EXISTS user_personas_user_id_idx ON user_personas(user_id)`,
];

const COLUMN_ALTERS = [
  `ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS published_at TIMESTAMP`,
  `ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`,
  `ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS thumbnail_url TEXT`,
  `ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS age_rating TEXT`,
  `ALTER TABLE world_pending_edits ADD COLUMN IF NOT EXISTS preserve_draft BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT`,
  `ALTER TABLE account_deletion_cleanup_jobs ADD COLUMN IF NOT EXISTS verification_identifiers JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE account_deletion_cleanup_jobs ADD COLUMN IF NOT EXISTS stripe_connect_id TEXT`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS display_username TEXT`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN NOT NULL DEFAULT false`,
  // PGlite / fresh-clone self-heal only (ensureTables early-returns on Neon).
  // Prod + dev get skip_review via manual db:push BEFORE the code that reads it
  // ships — same prod-DB-first rule as is_primary_variant above.
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS skip_review BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'regular'`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS invite_code_id TEXT`,
  // Referral linkage + reward epoch. Prod/dev (Neon) get these via db:push; the
  // self-heal keeps fresh PGlite / new-contributor DBs able to run the invite
  // system locally. referred_at gates the resettable reward ladder.
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS referral_code TEXT`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS referred_by TEXT`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS referred_at TIMESTAMP`,
  `ALTER TABLE user_blocks ADD COLUMN IF NOT EXISTS hide_blocked_worlds BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE user_blocks ADD COLUMN IF NOT EXISTS hide_own_worlds BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE user_blocks ADD COLUMN IF NOT EXISTS hide_blocked_activity BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS custom_ui_loc INTEGER`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS has_audio BOOLEAN`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS cover_crop JSONB`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS gallery_cover_crop JSONB`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS playtime_lease_id TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS playtime_last_seen_at TIMESTAMP`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS name TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMP`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_model TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS state_guard_enabled BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS state_guard_model TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS state_validation JSONB`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_model TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_implementation TEXT NOT NULL DEFAULT 'localdev'`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_mode TEXT NOT NULL DEFAULT 'threshold'`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_included BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_trigger_tokens INTEGER`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_recent_tail_tokens INTEGER`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_status TEXT NOT NULL DEFAULT 'idle'`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_error TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_source_hash TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_covers_until_message_id TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_token_count INTEGER`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_status TEXT NOT NULL DEFAULT 'idle'`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_error TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_updated_at TIMESTAMP`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_source_hash TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_covers_until_message_id TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_token_count INTEGER`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory JSONB`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_updated_at TIMESTAMP`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_model TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_included BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_status TEXT NOT NULL DEFAULT 'idle'`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_error TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_source_hash TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_claimed_at TIMESTAMP`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_processed_message_id TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_retry_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_stale_at TIMESTAMP`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_pinned TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS summaryception_compacted BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE user_prompts ADD COLUMN IF NOT EXISTS position REAL`,
  `ALTER TABLE bundles ADD COLUMN IF NOT EXISTS cover_image TEXT`,
  `ALTER TABLE bundles ADD COLUMN IF NOT EXISTS like_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS multilanguage_overview JSONB`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS favorite_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS average_rating REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS moderation_note TEXT`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS moderation_action TEXT`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_reviews BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_custom_api BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS blur_cover BOOLEAN`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS language TEXT`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS language_group_id TEXT`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS variant_label TEXT`,
  // 主/副 model: every hub query references this column, so a DB missing it 500s
  // on Discover. Idempotent ADD COLUMN (bare await, like its siblings above) so
  // fresh PGlite / dev / new-contributor DBs self-provision. Prod gets the column
  // + backfill + partial unique index from _migrate_primary.mjs run BEFORE deploy
  // (this ALTER is then a no-op there); the index is intentionally NOT created here.
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS is_primary_variant BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete'`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_message TEXT`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE posts ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE posts ADD COLUMN IF NOT EXISTS reply_to_id TEXT`,
  `ALTER TABLE posts ADD COLUMN IF NOT EXISTS reply_to_author_name TEXT`,
  `ALTER TABLE posts ADD COLUMN IF NOT EXISTS reply_to_floor INTEGER`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS lifetime_playtime_seconds INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE user_checkin_stats ADD COLUMN IF NOT EXISTS time_zone TEXT`,
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS showcased_achievement_id TEXT`,
  `ALTER TABLE platform_achievements ADD COLUMN IF NOT EXISTS metric_key TEXT`,
  `ALTER TABLE platform_achievements ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'event'`,
  `ALTER TABLE platform_achievements ADD COLUMN IF NOT EXISTS is_capstone BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE user_platform_achievements ADD COLUMN IF NOT EXISTS tier_level TEXT NOT NULL DEFAULT 'bronze'`,
  `ALTER TABLE worlds ADD COLUMN IF NOT EXISTS published_at TIMESTAMP`,
  // Stripe cancel-at-period-end tracking. Prod gets this via explicit SQL before
  // deploy (DB-before-code); this entry self-heals fresh PGlite / new-contributor DBs.
  `ALTER TABLE credit_wallets ADD COLUMN IF NOT EXISTS subscription_cancel_at TIMESTAMP`,
  // Private, user-only persona note (never injected into prompts). Real
  // Postgres gets this via explicit SQL (drizzle/0047_persona_note.sql) before
  // this code deploys; this entry keeps PGlite/fresh local DBs in sync.
  `ALTER TABLE user_personas ADD COLUMN IF NOT EXISTS note TEXT`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_persona JSONB`,
  `ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS persona_locked BOOLEAN NOT NULL DEFAULT false`,
];

const EVENT_TABLE_DDLS = [
  `CREATE TABLE IF NOT EXISTS community_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    introduction TEXT NOT NULL,
    reward_description TEXT,
    lang TEXT NOT NULL DEFAULT 'zh',
    submission_type TEXT NOT NULL DEFAULT 'world',
    single_submission_per_user BOOLEAN NOT NULL DEFAULT true,
    status TEXT NOT NULL DEFAULT 'draft',
    is_cached BOOLEAN NOT NULL DEFAULT false,
    cached_at TIMESTAMP,
    promote_in_community BOOLEAN NOT NULL DEFAULT false,
    promote_in_discover BOOLEAN NOT NULL DEFAULT false,
    banner_image_url TEXT,
    poster_image_url TEXT,
    announcement_thread_id TEXT,
    created_by_admin_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    updated_by_admin_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS community_event_submissions (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
    submitter_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    world_id TEXT REFERENCES worlds(id) ON DELETE SET NULL,
    enforces_single_submission BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_comment TEXT,
    reward_type TEXT,
    reward_amount INTEGER,
    reward_plan_id TEXT,
    reward_duration_days INTEGER,
    reviewer_admin_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
];

const EVENT_COLUMN_ALTERS = [
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS submission_type TEXT NOT NULL DEFAULT 'world'`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS reward_description TEXT`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS single_submission_per_user BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'zh'`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS is_cached BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS cached_at TIMESTAMP`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS promote_in_community BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS promote_in_discover BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS banner_image_url TEXT`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS poster_image_url TEXT`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS registration_opens_at TIMESTAMPTZ`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS registration_closes_at TIMESTAMPTZ`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS final_data_opens_at TIMESTAMPTZ`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS final_data_closes_at TIMESTAMPTZ`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS settlement_deadline_at TIMESTAMPTZ`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS rules_version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS rules_config JSONB`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS rules_locked_at TIMESTAMPTZ`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS announcement_thread_id TEXT`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS created_by_admin_id TEXT`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS updated_by_admin_id TEXT`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `ALTER TABLE community_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS enforces_single_submission BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS admin_comment TEXT`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS reward_type TEXT`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS reward_amount INTEGER`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS reward_plan_id TEXT`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS reward_duration_days INTEGER`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS reviewer_admin_id TEXT`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `ALTER TABLE community_event_submissions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `WITH ranked AS (
     SELECT s.id, ROW_NUMBER() OVER (PARTITION BY s.event_id, s.submitter_id ORDER BY s.created_at ASC, s.id ASC) AS rn
     FROM community_event_submissions s
     JOIN community_events e ON e.id = s.event_id
     WHERE e.single_submission_per_user = true
   )
   UPDATE community_event_submissions s SET enforces_single_submission = true
   FROM ranked r WHERE s.id = r.id AND r.rn = 1`,
  `ALTER TABLE community_event_submissions DROP CONSTRAINT IF EXISTS community_event_submissions_event_submitter_uniq`,
  `DROP INDEX IF EXISTS community_event_submissions_event_submitter_uniq`,
];

const SOCIAL_EVENT_TABLE_DDLS = [
  `CREATE TABLE IF NOT EXISTS community_event_social_entries (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    social_handle TEXT,
    normalized_account_key TEXT,
    draft_payload JSONB,
    current_revision_id TEXT,
    replacement_count INTEGER NOT NULL DEFAULT 0 CHECK (replacement_count BETWEEN 0 AND 1),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','under_initial_review','needs_changes','initial_approved','initial_rejected','under_final_review','settled','disqualified')),
    initial_review_eligible_at TIMESTAMPTZ,
    final_data_mode TEXT CHECK (final_data_mode IS NULL OR final_data_mode IN ('user_evidence','official_link_check')),
    initial_reviewer_admin_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    initial_reviewed_at TIMESTAMPTZ,
    initial_review_reason TEXT,
    final_reviewer_admin_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    final_reviewed_at TIMESTAMPTZ,
    final_review_reason TEXT,
    risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    verified_score INTEGER CHECK (verified_score IS NULL OR verified_score >= 0),
    platform_entitlement INTEGER CHECK (platform_entitlement IS NULL OR platform_entitlement BETWEEN 0 AND 15000),
    membership_plan_id TEXT CHECK (membership_plan_id IS NULL OR membership_plan_id IN ('go','plus','pro','ultra')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, user_id, platform),
    UNIQUE(event_id, platform, normalized_account_key),
    CHECK (platform IN ('xiaohongshu','douyin','weibo','bilibili','kuaishou','tiktok','instagram','youtube','x','threads','reddit'))
  )`,
  `CREATE TABLE IF NOT EXISTS community_event_social_revisions (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES community_event_social_entries(id) ON DELETE CASCADE,
    revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
    change_kind TEXT NOT NULL CHECK (change_kind IN ('initial','correction','replacement')),
    raw_url TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    canonical_post_key TEXT NOT NULL,
    post_published_at TIMESTAMPTZ NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    superseded_at TIMESTAMPTZ,
    rules_version INTEGER NOT NULL CHECK (rules_version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(entry_id, revision_no)
  )`,
  `CREATE TABLE IF NOT EXISTS community_event_social_post_claims (
    event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
    canonical_post_key TEXT NOT NULL,
    entry_id TEXT NOT NULL REFERENCES community_event_social_entries(id) ON DELETE CASCADE,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(event_id, canonical_post_key)
  )`,
  `CREATE TABLE IF NOT EXISTS community_event_social_evidence (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    entry_id TEXT REFERENCES community_event_social_entries(id) ON DELETE CASCADE,
    revision_id TEXT REFERENCES community_event_social_revisions(id) ON DELETE SET NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('initial','final_metrics','admin_capture')),
    storage_key TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    checksum TEXT,
    status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','ready','attached','deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bound_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS community_event_social_metric_snapshots (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL REFERENCES community_event_social_entries(id) ON DELETE CASCADE,
    revision_id TEXT REFERENCES community_event_social_revisions(id) ON DELETE SET NULL,
    resolution TEXT NOT NULL CHECK (resolution IN ('user_evidence','official_link_check','unverifiable')),
    likes INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0),
    favorites INTEGER NOT NULL DEFAULT 0 CHECK (favorites >= 0),
    valid_comments INTEGER NOT NULL DEFAULT 0 CHECK (valid_comments >= 0),
    shares INTEGER NOT NULL DEFAULT 0 CHECK (shares >= 0),
    link_status TEXT NOT NULL DEFAULT 'unknown' CHECK (link_status IN ('unknown','accessible','unavailable','not_public')),
    evidence_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    reviewer_admin_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    score INTEGER NOT NULL CHECK (score >= 0),
    platform_entitlement INTEGER NOT NULL CHECK (platform_entitlement BETWEEN 0 AND 15000),
    membership_plan_id TEXT CHECK (membership_plan_id IS NULL OR membership_plan_id IN ('go','plus','pro','ultra')),
    rules_version INTEGER NOT NULL CHECK (rules_version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS community_event_social_settlements (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','processing','completed','failed','cancelled')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    total_entitlement INTEGER NOT NULL DEFAULT 0 CHECK (total_entitlement BETWEEN 0 AND 75000),
    committed_mushies INTEGER NOT NULL DEFAULT 0 CHECK (committed_mushies BETWEEN 0 AND 75000),
    final_due_mushies INTEGER NOT NULL DEFAULT 0 CHECK (final_due_mushies BETWEEN 0 AND 75000),
    highest_plan_id TEXT CHECK (highest_plan_id IS NULL OR highest_plan_id IN ('go','plus','pro','ultra')),
    membership_duration_days INTEGER NOT NULL DEFAULT 0 CHECK (membership_duration_days BETWEEN 0 AND 30),
    calculation_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    frozen_at TIMESTAMPTZ,
    approved_by_admin_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(event_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS plan_entitlements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL CHECK (plan_id IN ('go','plus','pro','ultra')),
    source TEXT NOT NULL DEFAULT 'event',
    source_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    duration_days INTEGER NOT NULL CHECK (duration_days > 0),
    remaining_duration_seconds INTEGER NOT NULL CHECK (remaining_duration_seconds >= 0),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','active','consumed','cancelled')),
    activated_at TIMESTAMPTZ,
    resumed_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT plan_entitlements_source_check CHECK (${PLAN_ENTITLEMENT_SOURCE_CHECK})
  )`,
  `CREATE TABLE IF NOT EXISTS community_event_reward_grants (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    platform TEXT,
    entry_id TEXT REFERENCES community_event_social_entries(id) ON DELETE SET NULL,
    settlement_id TEXT REFERENCES community_event_social_settlements(id) ON DELETE SET NULL,
    phase TEXT NOT NULL CHECK (phase IN ('initial','final','adjustment','reversal')),
    purpose TEXT CHECK (purpose IS NULL OR purpose IN ('verified_settlement_floor')),
    kind TEXT NOT NULL CHECK (kind IN ('mushies','plan')),
    amount INTEGER CHECK (amount IS NULL OR amount BETWEEN -75000 AND 75000),
    plan_id TEXT CHECK (plan_id IS NULL OR plan_id IN ('go','plus','pro','ultra')),
    duration_days INTEGER,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','applied','failed','cancelled','reversed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    credit_transaction_id TEXT,
    plan_entitlement_id TEXT REFERENCES plan_entitlements(id) ON DELETE SET NULL,
    applied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((kind = 'mushies' AND amount IS NOT NULL AND plan_id IS NULL AND duration_days IS NULL)
      OR (kind = 'plan' AND amount IS NULL AND plan_id IS NOT NULL AND duration_days IS NOT NULL)),
    CHECK (platform IS NULL OR platform IN ('xiaohongshu','douyin','weibo','bilibili','kuaishou','tiktok','instagram','youtube','x','threads','reddit'))
  )`,
];

const SOCIAL_EVENT_CONSTRAINT_DDLS = [
  PLAN_ENTITLEMENT_SOURCE_CONSTRAINT_DDL,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_events_submission_type_check') THEN
      ALTER TABLE community_events ADD CONSTRAINT community_events_submission_type_check
        CHECK (submission_type IN ('world','social_post')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_events_rules_version_check') THEN
      ALTER TABLE community_events ADD CONSTRAINT community_events_rules_version_check
        CHECK (rules_version >= 1) NOT VALID;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_event_social_entries_current_revision_fk') THEN
      ALTER TABLE community_event_social_entries
        ADD CONSTRAINT community_event_social_entries_current_revision_fk
        FOREIGN KEY (current_revision_id) REFERENCES community_event_social_revisions(id) ON DELETE SET NULL NOT VALID;
    END IF;
  END $$`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_event_social_metric_snapshots_rules_version_check') THEN
      ALTER TABLE community_event_social_metric_snapshots
        ADD CONSTRAINT community_event_social_metric_snapshots_rules_version_check
        CHECK (rules_version >= 1) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_event_social_metric_snapshots_unverifiable_check') THEN
      ALTER TABLE community_event_social_metric_snapshots
        ADD CONSTRAINT community_event_social_metric_snapshots_unverifiable_check
        CHECK (resolution <> 'unverifiable' OR (likes = 0 AND favorites = 0 AND valid_comments = 0 AND shares = 0 AND score = 0)) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_event_social_metric_snapshots_user_evidence_check') THEN
      ALTER TABLE community_event_social_metric_snapshots
        ADD CONSTRAINT community_event_social_metric_snapshots_user_evidence_check
        CHECK (resolution <> 'user_evidence' OR jsonb_array_length(evidence_ids) > 0) NOT VALID;
    END IF;
  END $$`,
  `DO $$
  DECLARE
    existing_name TEXT;
    kept_constraint BOOLEAN := FALSE;
  BEGIN
    FOR existing_name IN
      SELECT c.conname
      FROM pg_constraint c
      WHERE c.conrelid = 'community_event_reward_grants'::regclass
        AND c.confrelid = 'credit_transactions'::regclass
        AND c.contype = 'f'
        AND c.conkey = ARRAY[(
          SELECT a.attnum
          FROM pg_attribute a
          WHERE a.attrelid = 'community_event_reward_grants'::regclass
            AND a.attname = 'credit_transaction_id'
        )]
      ORDER BY (c.conname = 'community_event_reward_grants_credit_txn_fk') DESC, c.conname
    LOOP
      IF NOT kept_constraint THEN
        IF existing_name <> 'community_event_reward_grants_credit_txn_fk' THEN
          EXECUTE format(
            'ALTER TABLE community_event_reward_grants RENAME CONSTRAINT %I TO community_event_reward_grants_credit_txn_fk',
            existing_name
          );
        END IF;
        kept_constraint := TRUE;
      ELSE
        EXECUTE format(
          'ALTER TABLE community_event_reward_grants DROP CONSTRAINT %I',
          existing_name
        );
      END IF;
    END LOOP;

    IF NOT kept_constraint THEN
      ALTER TABLE community_event_reward_grants
        ADD CONSTRAINT community_event_reward_grants_credit_txn_fk
        FOREIGN KEY (credit_transaction_id) REFERENCES credit_transactions(id) ON DELETE SET NULL NOT VALID;
    END IF;
  END $$`,
  `ALTER TABLE community_event_reward_grants ADD COLUMN IF NOT EXISTS purpose TEXT`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_event_reward_grants_purpose_check') THEN
      ALTER TABLE community_event_reward_grants
        ADD CONSTRAINT community_event_reward_grants_purpose_check
        CHECK (purpose IS NULL OR purpose IN ('verified_settlement_floor')) NOT VALID;
    END IF;
  END $$`,
  `INSERT INTO community_event_social_post_claims (event_id, canonical_post_key, entry_id, claimed_at)
   SELECT DISTINCT ON (event_id, canonical_post_key)
     event_id, canonical_post_key, entry_id, created_at
   FROM community_event_social_revisions
   ORDER BY event_id, canonical_post_key, (superseded_at IS NULL) DESC, created_at ASC
   ON CONFLICT (event_id, canonical_post_key) DO NOTHING`,
];

const EVENT_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS community_events_status_idx ON community_events(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS community_events_lang_idx ON community_events(lang, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS community_events_cache_idx ON community_events(is_cached, cached_at, updated_at)`,
  `CREATE INDEX IF NOT EXISTS community_events_discover_idx ON community_events(promote_in_discover, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS community_events_community_idx ON community_events(promote_in_community, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_submissions_event_status_idx ON community_event_submissions(event_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_submissions_submitter_idx ON community_event_submissions(submitter_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_submissions_world_idx ON community_event_submissions(world_id)`,
  `CREATE INDEX IF NOT EXISTS community_event_submissions_reviewer_idx ON community_event_submissions(reviewer_admin_id, reviewed_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS community_event_submissions_single_user_uniq ON community_event_submissions(event_id, submitter_id) WHERE enforces_single_submission = true`,
  `CREATE INDEX IF NOT EXISTS community_events_social_timeline_idx ON community_events(submission_type, status, registration_opens_at, registration_closes_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_entries_event_status_idx ON community_event_social_entries(event_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_entries_user_idx ON community_event_social_entries(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_entries_initial_review_idx ON community_event_social_entries(event_id, initial_review_eligible_at, status)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_revisions_entry_idx ON community_event_social_revisions(entry_id, submitted_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_post_claims_entry_idx ON community_event_social_post_claims(entry_id, claimed_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS community_event_social_revisions_current_uniq ON community_event_social_revisions(entry_id) WHERE superseded_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS community_event_social_revisions_event_post_current_uniq ON community_event_social_revisions(event_id, canonical_post_key) WHERE superseded_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS community_event_social_evidence_owner_status_idx ON community_event_social_evidence(owner_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_evidence_event_idx ON community_event_social_evidence(event_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_evidence_entry_idx ON community_event_social_evidence(entry_id, purpose)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_evidence_expiry_idx ON community_event_social_evidence(status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_metric_snapshots_entry_idx ON community_event_social_metric_snapshots(entry_id, verified_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_metric_snapshots_event_idx ON community_event_social_metric_snapshots(event_id, verified_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_settlements_event_status_idx ON community_event_social_settlements(event_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_social_settlements_user_idx ON community_event_social_settlements(user_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS plan_entitlements_user_status_idx ON plan_entitlements(user_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS plan_entitlements_source_idx ON plan_entitlements(source, source_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS plan_entitlements_event_user_uniq ON plan_entitlements(source, source_id, user_id) WHERE source = 'event'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS plan_entitlements_one_active_per_user_uniq ON plan_entitlements(user_id) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS community_event_reward_grants_event_status_idx ON community_event_reward_grants(event_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_reward_grants_user_idx ON community_event_reward_grants(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS community_event_reward_grants_entry_idx ON community_event_reward_grants(entry_id, phase)`,
  `CREATE INDEX IF NOT EXISTS community_event_reward_grants_settlement_idx ON community_event_reward_grants(settlement_id, phase)`,
  `CREATE INDEX IF NOT EXISTS community_event_reward_grants_purpose_status_idx ON community_event_reward_grants(purpose, status, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS credit_txn_event_reward_ref_unique ON credit_transactions(reference_id) WHERE type = 'event_reward' AND reference_id IS NOT NULL`,
];

const DM_SCHEMA_DDLS = [
  `CREATE TABLE IF NOT EXISTS direct_conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'direct',
    title TEXT,
    image TEXT,
    created_by_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS direct_conversation_participants (
    conversation_id TEXT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMP NOT NULL DEFAULT NOW(),
    left_at TIMESTAMP,
    pinned_at TIMESTAMP,
    UNIQUE(conversation_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text',
    metadata JSONB,
    client_id TEXT,
    reply_to_message_id TEXT REFERENCES direct_messages(id) ON DELETE SET NULL,
    edited_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS direct_message_read_cursors (
    conversation_id TEXT NOT NULL REFERENCES direct_conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(conversation_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS direct_message_hidden (
    message_id TEXT NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    hidden_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(message_id, user_id)
  )`,
  `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'direct'`,
  `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS title TEXT`,
  `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS image TEXT`,
  `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS created_by_id TEXT`,
  `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `UPDATE direct_conversations SET type = 'direct' WHERE type IS NULL`,
  `ALTER TABLE direct_conversation_participants ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'`,
  `ALTER TABLE direct_conversation_participants ADD COLUMN IF NOT EXISTS joined_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `ALTER TABLE direct_conversation_participants ADD COLUMN IF NOT EXISTS left_at TIMESTAMP`,
  `ALTER TABLE direct_conversation_participants ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMP`,
  `UPDATE direct_conversation_participants SET role = 'member' WHERE role IS NULL`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'text'`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS metadata JSONB`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS client_id TEXT`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS reply_to_message_id TEXT`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP`,
  `ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `ALTER TABLE direct_message_read_cursors ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `INSERT INTO direct_message_read_cursors (conversation_id, user_id)
    SELECT dcp.conversation_id, dcp.user_id
    FROM direct_conversation_participants dcp
    LEFT JOIN direct_message_read_cursors rc
      ON rc.conversation_id = dcp.conversation_id
      AND rc.user_id = dcp.user_id
    WHERE rc.conversation_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS dcp_user_id_idx ON direct_conversation_participants(user_id)`,
  `CREATE INDEX IF NOT EXISTS dm_conversation_created_idx ON direct_messages(conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS dm_sender_id_idx ON direct_messages(sender_id)`,
  `CREATE INDEX IF NOT EXISTS dm_client_id_idx ON direct_messages(client_id)`,
  `CREATE INDEX IF NOT EXISTS dm_hidden_user_idx ON direct_message_hidden(user_id)`,
];

/**
 * When using PGlite, create all tables from DDL.
 * No-op when a real DATABASE_URL is configured.
 */
export async function ensureTables() {
  if (!IS_PGLITE) return;
  const { bootstrapPgliteSchema } = await import("./bootstrap-pglite.js");
  await bootstrapPgliteSchema();
  for (const ddl of TABLE_DDLS) {
    await db.execute(sql.raw(ddl));
  }
  for (const ddl of COLUMN_ALTERS) {
    await db.execute(sql.raw(ddl));
  }
  for (const ddl of INDEX_DDLS) {
    await db.execute(sql.raw(ddl));
  }
  await ensureWorldsSchemaDerived();
  await ensureMessagesSwipeCount();
  console.log("[DEV] PGlite tables + indexes created");
}

// Hot-path indexes for real Postgres. ensureTables() above is PGlite-only, so
// prod never received the INDEX_DDLS additions at boot. These are the 2026-09-07
// findings (pg_stat_user_tables seq_scan since 07-28): user_prompts 4.4M scans,
// prompt_folders 4.4M, posts 4.8M, dm read cursors 456k, bundles 286k,
// user_assets 233k, the Better Auth OAuth lookup on account(provider_id,
// account_id) at 86ms/call, and the play_sessions FK on support_prompt_events.
// CONCURRENTLY (no write lock; cannot run inside a transaction — each
// db.execute here is its own autocommit statement) + IF NOT EXISTS + a leader
// lock so only one replica builds. Additive and idempotent: code works with or
// without them, which is why the boot self-heal is an acceptable apply path.
const HOT_PATH_INDEX_DDLS = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS user_prompts_user_id_idx ON user_prompts(user_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS prompt_folders_user_id_idx ON prompt_folders(user_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS user_assets_user_id_idx ON user_assets(user_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS asset_folders_user_id_idx ON asset_folders(user_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS posts_author_id_idx ON posts(author_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS bundles_user_id_idx ON bundles(user_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS dmrc_user_id_idx ON direct_message_read_cursors(user_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS account_provider_account_idx ON account(provider_id, account_id)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS support_prompt_events_session_id_idx ON support_prompt_events(session_id)`,
];

export async function ensureHotPathIndexes(): Promise<void> {
  if (IS_PGLITE) return;
  await runExclusive("hot-path-indexes", 15 * 60, async () => {
    for (const ddl of HOT_PATH_INDEX_DDLS) {
      try {
        await db.execute(sql.raw(ddl));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[DB] hot-path index failed: ${ddl} :: ${message}`);
        captureServerError("hot-path-index", err, { ddl });
      }
    }
  });
}

/**
 * Derived browse columns on worlds (custom_ui_loc / has_audio / cover_crop /
 * gallery_cover_crop), maintained by a BEFORE INSERT OR UPDATE OF schema
 * trigger so EVERY writer (Studio agent, version rollback, admin scripts)
 * keeps them in sync. Reading these instead of `schema->'…'` expressions is
 * what fixed the Discover-feed latency: any jsonb extraction detoasts the
 * multi-MB schema blob per row (measured 0.6ms → 460ms over the published
 * set). Applied to dev+prod with full backfill 2026-06-10
 * (scripts/p1-apply.ts); this ensure keeps fresh DBs and PGlite in parity.
 * The EXCEPTION guard means a world save can never fail because of these.
 */
export async function ensureWorldsSchemaDerived() {
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION worlds_sync_schema_derived() RETURNS trigger AS $fn$
    BEGIN
      -- Carry the game key forward: editors rewrite the whole schema from models that do not
      -- know this key exists (a Studio rename stripped it and un-gamed the PvZ card). Only an
      -- explicit schema.game = null removes game-ness; omission never does.
      IF TG_OP = 'UPDATE' AND NOT (NEW.schema ? 'game') AND OLD.schema ? 'game' THEN
        NEW.schema := jsonb_set(NEW.schema, '{game}', OLD.schema->'game', true);
      END IF;
      NEW.custom_ui_loc := CASE
        WHEN jsonb_typeof(NEW.schema->'rootComponent'->'files') = 'object' THEN COALESCE((
          SELECT SUM(length(value) - length(replace(value, E'\\n', '')) + 1)
          FROM jsonb_each_text(NEW.schema->'rootComponent'->'files')
        ), 0)
        ELSE 0
      END;
      NEW.has_audio := CASE
        WHEN jsonb_typeof(NEW.schema->'audioTracks') = 'array'
          THEN jsonb_array_length(NEW.schema->'audioTracks') > 0
        ELSE false
      END;
      NEW.cover_crop := NEW.schema->'coverCrop';
      NEW.gallery_cover_crop := NEW.schema->'galleryCoverCrop';
      NEW.game_path := NEW.schema->'game'->>'path';
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      NEW.custom_ui_loc := COALESCE(NEW.custom_ui_loc, 0);
      NEW.has_audio := COALESCE(NEW.has_audio, false);
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql
  `));
  await db.execute(sql.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'worlds_schema_derived_trg') THEN
        CREATE TRIGGER worlds_schema_derived_trg
          BEFORE INSERT OR UPDATE OF schema ON worlds
          FOR EACH ROW EXECUTE FUNCTION worlds_sync_schema_derived();
      END IF;
    END $$
  `));
}

/**
 * messages.swipe_count = jsonb_array_length(swipes), maintained by a BEFORE
 * INSERT OR UPDATE OF swipes trigger so EVERY writer (send, regenerate, swipe
 * delete, session greetings, the raw-SQL snapshot rewrite) keeps it in sync.
 * The regen achievement metrics (max_regens_on_message / total_regenerations)
 * aggregate this tiny int instead of detoasting the multi-KB swipes jsonb per
 * row — that detoast was the 500-1200ms slow query. Per project rule the DDL is
 * applied to dev+prod manually first (scripts/install-swipe-count.sql); this
 * ensure keeps fresh DBs + PGlite in parity. The column is added nullable (no
 * table rewrite, no exclusive lock); the metric query COALESCEs to the jsonb
 * fallback so it stays correct while the batched backfill runs. The EXCEPTION
 * guard means a message write can never fail because of the trigger.
 */
export async function ensureMessagesSwipeCount() {
  await db.execute(sql.raw(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS swipe_count INTEGER`));
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION messages_set_swipe_count() RETURNS trigger AS $fn$
    BEGIN
      NEW.swipe_count := CASE
        WHEN jsonb_typeof(NEW.swipes) = 'array' THEN jsonb_array_length(NEW.swipes)
        ELSE 0
      END;
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      NEW.swipe_count := COALESCE(NEW.swipe_count, 0);
      RETURN NEW;
    END $fn$ LANGUAGE plpgsql
  `));
  await db.execute(sql.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'messages_swipe_count_trg') THEN
        CREATE TRIGGER messages_swipe_count_trg
          BEFORE INSERT OR UPDATE OF swipes ON messages
          FOR EACH ROW EXECUTE FUNCTION messages_set_swipe_count();
      END IF;
    END $$
  `));
}

/**
 * The publish-review toggle is read by the public worlds list/detail routes.
 * Keep this one additive column self-healing on real Postgres startup so a
 * deploy cannot break browsing while a manual migration is still pending.
 */
export async function ensureWorldReviewControlsColumn() {
  if (IS_PGLITE) return;
  await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_reviews BOOLEAN NOT NULL DEFAULT true`));
  await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_community_citations BOOLEAN NOT NULL DEFAULT true`));
}

/**
 * Make hard account deletion safe for ledger data.
 *
 * Most user-owned rows intentionally cascade, but payment, creator-earning,
 * and reward audit rows must survive without identifying the deleted user.
 * Older databases were created with NO ACTION (or a NOT NULL + SET NULL
 * mismatch), which either blocked deletion or let Better Auth remove login
 * credentials before the final user DELETE failed. Keep the repair idempotent
 * so the testing database upgrades itself on deploy; db:push creates the same
 * constraints from schema.ts for fresh/prod databases.
 */
// Fresh PGlite's legacy bootstrap does not yet provision every financial and
// community table touched by hard deletion. Report this honestly as
// unavailable instead of allowing a relation-not-found failure mid-request.
let accountDeletionForeignKeysReady = false;
let notificationActorSchemaReady = false;
let tipPaymentIntentSchemaReady = false;

export function isAccountDeletionSchemaReady(): boolean {
  return accountDeletionForeignKeysReady;
}

export function isNotificationActorSchemaReady(): boolean {
  return notificationActorSchemaReady;
}

export async function isTipPaymentIntentSchemaReady(): Promise<boolean> {
  if (IS_PGLITE) return true;
  if (tipPaymentIntentSchemaReady) return true;
  const result = await db.execute(sql.raw(`
    SELECT (
      to_regclass('public.tip_payment_intents') IS NOT NULL
      AND to_regclass('public.creator_earnings_pi_unique') IS NOT NULL
    ) AS ready
  `));
  tipPaymentIntentSchemaReady =
    (result.rows[0] as { ready?: boolean } | undefined)?.ready === true;
  return tipPaymentIntentSchemaReady;
}

export async function ensureAccountDeletionForeignKeys() {
  if (IS_PGLITE) {
    accountDeletionForeignKeysReady = false;
    return;
  }
  accountDeletionForeignKeysReady = false;
  notificationActorSchemaReady = false;

  // This table has no FK to the hot user table, so it is safe to create on a
  // live database. Keeping it in this readiness gate prevents billing cleanup
  // from starting before the durable anti-abuse marker can be written.
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS deleted_account_tombstones (
      identity_hash TEXT PRIMARY KEY,
      was_banned BOOLEAN NOT NULL DEFAULT false,
      block_welcome_rewards BOOLEAN NOT NULL DEFAULT true,
      block_invite_redemption BOOLEAN NOT NULL DEFAULT true,
      last_checkin_day TEXT,
      reward_blocked_until TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS account_deletion_cleanup_jobs (
      id TEXT PRIMARY KEY,
      deleted_user_id TEXT NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_connect_id TEXT,
      stripe_payment_intent_ids JSONB NOT NULL DEFAULT '[]',
      stripe_checkout_session_ids JSONB NOT NULL DEFAULT '[]',
      asset_keys JSONB NOT NULL DEFAULT '[]',
      asset_prefixes JSONB NOT NULL DEFAULT '[]',
      session_tokens JSONB NOT NULL DEFAULT '[]',
      verification_identifiers JSONB NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
      finalize_after TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS account_deletion_cleanup_jobs_next_idx ON account_deletion_cleanup_jobs (next_attempt_at)`));
  await db.execute(sql.raw(`ALTER TABLE account_deletion_cleanup_jobs ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`));
  await db.execute(sql.raw(`ALTER TABLE account_deletion_cleanup_jobs ADD COLUMN IF NOT EXISTS stripe_connect_id TEXT`));
  await db.execute(sql.raw(`ALTER TABLE account_deletion_cleanup_jobs ADD COLUMN IF NOT EXISTS stripe_payment_intent_ids JSONB NOT NULL DEFAULT '[]'`));
  await db.execute(sql.raw(`ALTER TABLE account_deletion_cleanup_jobs ADD COLUMN IF NOT EXISTS stripe_checkout_session_ids JSONB NOT NULL DEFAULT '[]'`));
  await db.execute(sql.raw(`ALTER TABLE account_deletion_cleanup_jobs ADD COLUMN IF NOT EXISTS verification_identifiers JSONB NOT NULL DEFAULT '[]'`));
  await db.execute(sql.raw(`ALTER TABLE account_deletion_cleanup_jobs ADD COLUMN IF NOT EXISTS finalize_after TIMESTAMP`));
  await db.execute(sql.raw(`UPDATE account_deletion_cleanup_jobs SET finalize_after = COALESCE(created_at, NOW()) + INTERVAL '70 minutes' WHERE finalize_after IS NULL`));
  await db.execute(sql.raw(`ALTER TABLE account_deletion_cleanup_jobs ALTER COLUMN finalize_after SET NOT NULL`));

  // The production preparation command runs before the new application code
  // is deployed, so ensureTables() has not created this additive table yet.
  // Keep this helper self-contained instead of assuming the post-deploy schema
  // self-heal has already run.
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS tip_payment_intents (
      id TEXT PRIMARY KEY,
      stripe_payment_intent_id TEXT UNIQUE,
      sender_id TEXT,
      creator_id TEXT,
      world_id TEXT,
      bundle_id TEXT,
      amount INTEGER NOT NULL,
      message TEXT,
      is_anonymous BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `));

  // Better Auth's verification table has no user FK. Serialize password-reset,
  // deletion and OAuth-link verification writes with the final user-row lock
  // so no stale credential can be written after account deletion.
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION guard_verification_user_identity()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $verification_user_identity$
    DECLARE
      candidate TEXT;
    BEGIN
      -- verification_user_identity_v2_direct_email_fail_closed
      IF NEW.identifier LIKE 'delete-account-%'
        OR NEW.identifier LIKE 'reset-password:%' THEN
        candidate := NEW.value;
      ELSE
        candidate := substring(NEW.value FROM '"userId":"([^"]+)"');
      END IF;

      IF candidate IS NULL
        AND NEW.value ~* '^[^[:space:]@]+@[^[:space:]@]+$' THEN
        SELECT account.id INTO candidate
        FROM "user" account
        WHERE lower(account.email) = lower(NEW.value)
        LIMIT 1;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Verification email owner no longer exists'
            USING ERRCODE = '23503';
        END IF;
      END IF;

      IF candidate IS NOT NULL THEN
        PERFORM id FROM "user" WHERE id = candidate FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Verification owner % no longer exists', candidate
            USING ERRCODE = '23503';
        END IF;
      END IF;
      RETURN NEW;
    END
    $verification_user_identity$;
  `));
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS verification_guard_user_identity ON verification`));
  await db.execute(sql.raw(`
    CREATE TRIGGER verification_guard_user_identity
    BEFORE INSERT OR UPDATE OF identifier, value ON verification
    FOR EACH ROW
    EXECUTE FUNCTION guard_verification_user_identity()
  `));

  // Remove the short-lived "protected history blocks deletion" experiment if
  // this database was prepared by an earlier testing build. Audit history is
  // anonymized by the deletion transaction instead of restricting eligibility.
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS admin_actions_guard_user_target ON admin_actions`));
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS guard_admin_action_user_target()`));
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS reports_guard_world_target ON reports`));
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS guard_report_world_target()`));
  await db.execute(sql.raw(`
    DO $remove_report_owner_restriction$
    DECLARE existing_fk RECORD;
    BEGIN
      FOR existing_fk IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_attribute attr
          ON attr.attrelid = con.conrelid
         AND attr.attnum = con.conkey[1]
        WHERE con.contype = 'f'
          AND con.conrelid = to_regclass('public.reports')
          AND attr.attname = 'target_owner_user_id'
      LOOP
        EXECUTE format('ALTER TABLE reports DROP CONSTRAINT %I', existing_fk.conname);
      END LOOP;
    END
    $remove_report_owner_restriction$;
  `));

  await db.execute(sql.raw(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_user_id TEXT`));
  await db.execute(sql.raw(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key TEXT`));
  const backfillNotificationActors = async () => {
    await db.execute(sql.raw(`
      UPDATE notifications notification
      SET actor_user_id = COALESCE(
        notification.payload->>'followerUserId',
        notification.payload->>'likerUserId',
        notification.payload->>'fanUserId',
        notification.payload->>'reviewerUserId',
        notification.payload->>'replierUserId',
        notification.payload->>'creatorUserId',
        notification.payload->>'senderUserId',
        notification.payload->>'creatorId',
        notification.payload->>'ownerUserId',
        notification.payload->>'authorUserId',
        notification.payload->>'submitterId',
        notification.payload->>'submitterUserId',
        notification.payload->>'adminUserId',
        notification.payload->>'moderatorUserId'
        )
      WHERE notification.actor_user_id IS NULL
        AND EXISTS (
        SELECT 1 FROM "user" actor
        WHERE actor.id = COALESCE(
          notification.payload->>'followerUserId',
          notification.payload->>'likerUserId',
          notification.payload->>'fanUserId',
          notification.payload->>'reviewerUserId',
          notification.payload->>'replierUserId',
          notification.payload->>'creatorUserId',
          notification.payload->>'senderUserId',
          notification.payload->>'creatorId',
          notification.payload->>'ownerUserId',
          notification.payload->>'authorUserId',
          notification.payload->>'submitterId',
          notification.payload->>'submitterUserId',
          notification.payload->>'adminUserId',
          notification.payload->>'moderatorUserId'
          )
        )
    `));
    await db.execute(sql.raw(`
      UPDATE notifications notification
      SET actor_user_id = source.creator_id
      FROM worlds source
      WHERE notification.actor_user_id IS NULL
        AND notification.type IN ('world_update', 'world_unpublished', 'world_republished', 'new_review_pending')
        AND notification.payload->>'worldId' = source.id
    `));
    await db.execute(sql.raw(`
      DELETE FROM notifications notification
      WHERE notification.actor_user_id IS NULL
        AND notification.type IN ('world_update', 'world_unpublished', 'world_republished', 'new_review_pending')
        AND notification.payload ? 'worldId'
        AND NOT EXISTS (
          SELECT 1 FROM worlds source WHERE source.id = notification.payload->>'worldId'
        )
    `));
    await db.execute(sql.raw(`
      UPDATE notifications notification
      SET actor_user_id = earning.sender_id
      FROM creator_earnings earning
      WHERE notification.actor_user_id IS NULL
        AND earning.sender_id IS NOT NULL
        AND notification.type = 'tip_received'
        AND earning.creator_id = notification.user_id
        AND notification.payload->>'amount' = earning.gross_amount::text
        AND COALESCE(notification.payload->>'message', '') = COALESCE(earning.message, '')
        AND notification.created_at BETWEEN earning.created_at - INTERVAL '5 minutes' AND earning.created_at + INTERVAL '5 minutes'
    `));
    await db.execute(sql.raw(`
      UPDATE notifications notification
      SET actor_user_id = gift.sender_id
      FROM mushie_gifts gift
      WHERE notification.actor_user_id IS NULL
        AND gift.sender_id IS NOT NULL
        AND notification.type = 'mushie_gift_received'
        AND gift.recipient_id = notification.user_id
        AND notification.payload->>'amount' = gift.amount::text
        AND COALESCE(notification.payload->>'message', '') = COALESCE(gift.message, '')
        AND notification.created_at BETWEEN gift.created_at - INTERVAL '5 minutes' AND gift.created_at + INTERVAL '5 minutes'
    `));
    await db.execute(sql.raw(`
      UPDATE notifications notification
      SET actor_user_id = submission.submitter_id
      FROM community_event_submissions submission
      WHERE notification.actor_user_id IS NULL
        AND notification.type = 'event_submission_pending'
        AND notification.payload->>'eventId' = submission.event_id
        AND notification.payload->>'worldId' = submission.world_id
    `));
  };
  await backfillNotificationActors();
  await db.execute(sql.raw(`
    DO $notification_actor_fk$
    DECLARE existing_fk RECORD;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = con.conkey[1]
        WHERE con.contype = 'f'
          AND con.conrelid = to_regclass('public.notifications')
          AND con.confrelid = to_regclass('public."user"')
          AND attr.attname = 'actor_user_id'
          AND con.confdeltype = 'c'
      ) THEN
        FOR existing_fk IN
          SELECT con.conname
          FROM pg_constraint con
          JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = con.conkey[1]
          WHERE con.contype = 'f'
            AND con.conrelid = to_regclass('public.notifications')
            AND attr.attname = 'actor_user_id'
        LOOP
          EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', existing_fk.conname);
        END LOOP;
        ALTER TABLE notifications
          ADD CONSTRAINT notifications_actor_user_id_user_id_fk
          FOREIGN KEY (actor_user_id) REFERENCES "user"(id) ON DELETE CASCADE;
      END IF;
    END
    $notification_actor_fk$;
  `));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS notifications_actor_user_idx ON notifications (actor_user_id)`));
  const notificationActorReady = await db.execute(sql.raw(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint con
      JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = con.conkey[1]
      WHERE con.contype = 'f'
        AND con.conrelid = to_regclass('public.notifications')
        AND con.confrelid = to_regclass('public."user"')
        AND attr.attname = 'actor_user_id'
        AND con.confdeltype = 'c'
    ) AS ready
  `));
  if ((notificationActorReady.rows[0] as { ready?: boolean } | undefined)?.ready !== true) {
    throw new Error("Account deletion notification actor FK is not ready");
  }
  // From this point onward notification writers may safely include the new
  // column even while the remaining account-deletion FKs are still healing.
  notificationActorSchemaReady = true;

  await db.execute(sql.raw(`ALTER TABLE deleted_account_tombstones ADD COLUMN IF NOT EXISTS was_banned BOOLEAN NOT NULL DEFAULT false`));
  await db.execute(sql.raw(`ALTER TABLE deleted_account_tombstones ADD COLUMN IF NOT EXISTS block_welcome_rewards BOOLEAN NOT NULL DEFAULT true`));
  await db.execute(sql.raw(`ALTER TABLE deleted_account_tombstones ADD COLUMN IF NOT EXISTS block_invite_redemption BOOLEAN NOT NULL DEFAULT true`));
  await db.execute(sql.raw(`ALTER TABLE deleted_account_tombstones ADD COLUMN IF NOT EXISTS last_checkin_day TEXT`));
  await db.execute(sql.raw(`ALTER TABLE deleted_account_tombstones ADD COLUMN IF NOT EXISTS reward_blocked_until TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE deleted_account_tombstones ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW()`));
  await db.execute(sql.raw(`ALTER TABLE deleted_account_tombstones ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`));

  // Remove legacy orphans before validating the new snapshot/self-reference
  // constraints. These statements are idempotent and run only while account
  // deletion remains unavailable.
  await db.execute(sql.raw(`
    DELETE FROM world_click_history history
    WHERE NOT EXISTS (SELECT 1 FROM worlds source WHERE source.id = history.world_id)
  `));
  await db.execute(sql.raw(`
    UPDATE posts survivor
    SET parent_id = NULL
    WHERE parent_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM posts target WHERE target.id = survivor.parent_id)
  `));
  await db.execute(sql.raw(`
    UPDATE posts survivor
    SET reply_to_id = NULL, reply_to_author_name = NULL, reply_to_floor = NULL
    WHERE reply_to_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM posts target WHERE target.id = survivor.reply_to_id)
  `));
  await db.execute(sql.raw(`
    UPDATE posts
    SET reply_to_author_name = NULL, reply_to_floor = NULL
    WHERE reply_to_id IS NULL
      AND (reply_to_author_name IS NOT NULL OR reply_to_floor IS NOT NULL)
  `));
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION clear_post_reply_snapshot_on_target_delete()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $clear_post_reply_snapshot$
    BEGIN
      IF OLD.reply_to_id IS NOT NULL AND NEW.reply_to_id IS NULL THEN
        NEW.reply_to_author_name := NULL;
        NEW.reply_to_floor := NULL;
      END IF;
      RETURN NEW;
    END
    $clear_post_reply_snapshot$
  `));
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS posts_clear_reply_snapshot ON posts`));
  await db.execute(sql.raw(`
    CREATE TRIGGER posts_clear_reply_snapshot
    BEFORE UPDATE OF reply_to_id ON posts
    FOR EACH ROW
    EXECUTE FUNCTION clear_post_reply_snapshot_on_target_delete()
  `));

  const relationships = [
    ["user", "referred_by", "user", "user_referred_by_user_id_fk", false, "SET NULL", "n"],
    ["creator_earnings", "creator_id", "user", "creator_earnings_creator_id_user_id_fk", true, "SET NULL", "n"],
    ["creator_earnings", "sender_id", "user", "creator_earnings_sender_id_user_id_fk", false, "SET NULL", "n"],
    ["creator_earnings", "world_id", "worlds", "creator_earnings_world_id_worlds_id_fk", false, "SET NULL", "n"],
    ["creator_earnings", "bundle_id", "bundles", "creator_earnings_bundle_id_bundles_id_fk", false, "SET NULL", "n"],
    ["mushie_gifts", "sender_id", "user", "mushie_gifts_sender_id_user_id_fk", true, "SET NULL", "n"],
    ["mushie_gifts", "recipient_id", "user", "mushie_gifts_recipient_id_user_id_fk", true, "SET NULL", "n"],
    ["mushie_gifts", "world_id", "worlds", "mushie_gifts_world_id_worlds_id_fk", false, "SET NULL", "n"],
    ["mushie_gifts", "bundle_id", "bundles", "mushie_gifts_bundle_id_bundles_id_fk", false, "SET NULL", "n"],
    ["thread_rewards", "admin_id", "user", "thread_rewards_admin_id_user_id_fk", true, "SET NULL", "n"],
    ["thread_rewards", "recipient_id", "user", "thread_rewards_recipient_id_user_id_fk", true, "SET NULL", "n"],
    ["invite_code_redemptions", "user_id", "user", "invite_code_redemptions_user_id_user_id_fk", true, "SET NULL", "n"],
    ["tip_payment_intents", "sender_id", "user", "tip_payment_intents_sender_id_user_id_fk", false, "SET NULL", "n"],
    ["tip_payment_intents", "creator_id", "user", "tip_payment_intents_creator_id_user_id_fk", false, "SET NULL", "n"],
    ["tip_payment_intents", "world_id", "worlds", "tip_payment_intents_world_id_worlds_id_fk", false, "SET NULL", "n"],
    ["tip_payment_intents", "bundle_id", "bundles", "tip_payment_intents_bundle_id_bundles_id_fk", false, "SET NULL", "n"],
    ["community_event_submissions", "world_id", "worlds", "community_event_submissions_world_id_worlds_id_fk", true, "SET NULL", "n"],
    ["world_review_submissions", "world_id", "worlds", "world_review_submissions_world_id_worlds_id_fk", true, "SET NULL", "n"],
    ["world_click_history", "world_id", "worlds", "world_click_history_world_id_worlds_id_fk", false, "CASCADE", "c"],
    ["posts", "parent_id", "posts", "posts_parent_id_posts_id_fk", false, "SET NULL", "n"],
    ["posts", "reply_to_id", "posts", "posts_reply_to_id_posts_id_fk", false, "SET NULL", "n"],
  ] as const;

  for (const [table, column, targetTable, constraintName, dropNotNull, onDelete, deleteCode] of relationships) {
    await db.execute(sql.raw(`
      DO $account_delete_fk$
      DECLARE
        existing_fk RECORD;
      BEGIN
        IF to_regclass('public."${table}"') IS NOT NULL
          AND to_regclass('public."${targetTable}"') IS NOT NULL THEN
          ${dropNotNull ? `ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP NOT NULL;` : ""}

          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint con
            JOIN pg_attribute attr
              ON attr.attrelid = con.conrelid
             AND attr.attnum = con.conkey[1]
            WHERE con.contype = 'f'
              AND con.conrelid = to_regclass('public."${table}"')
              AND con.confrelid = to_regclass('public."${targetTable}"')
              AND array_length(con.conkey, 1) = 1
              AND attr.attname = '${column}'
              AND con.confdeltype = '${deleteCode}'
          ) THEN
            FOR existing_fk IN
              SELECT con.conname
              FROM pg_constraint con
              JOIN pg_attribute attr
                ON attr.attrelid = con.conrelid
               AND attr.attnum = con.conkey[1]
              WHERE con.contype = 'f'
                AND con.conrelid = to_regclass('public."${table}"')
                AND array_length(con.conkey, 1) = 1
                AND attr.attname = '${column}'
            LOOP
              EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', '${table}', existing_fk.conname);
            END LOOP;

            ALTER TABLE "${table}"
              ADD CONSTRAINT "${constraintName}"
              FOREIGN KEY ("${column}") REFERENCES "${targetTable}"(id)
              ON DELETE ${onDelete};
          END IF;
        END IF;
      END
      $account_delete_fk$;
    `));

    const verification = await db.execute(sql.raw(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_attribute attr
          ON attr.attrelid = con.conrelid
         AND attr.attnum = con.conkey[1]
        WHERE con.contype = 'f'
          AND con.conrelid = to_regclass('public."${table}"')
          AND con.confrelid = to_regclass('public."${targetTable}"')
          AND array_length(con.conkey, 1) = 1
          AND attr.attname = '${column}'
          AND con.confdeltype = '${deleteCode}'
      ) AS ready
    `));
    const ready = (verification.rows[0] as { ready?: boolean } | undefined)?.ready === true;
    if (!ready) {
      throw new Error(`Account deletion FK is not ready: ${table}.${column}`);
    }
  }
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS world_click_history_world_id_idx ON world_click_history (world_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS posts_reply_to_idx ON posts (reply_to_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS tip_payment_intents_sender_idx ON tip_payment_intents (sender_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS tip_payment_intents_creator_idx ON tip_payment_intents (creator_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS tip_payment_intents_pi_idx ON tip_payment_intents (stripe_payment_intent_id)`));
  const duplicateTipEarning = await db.execute(sql.raw(`
    SELECT stripe_payment_intent_id, count(*)::int AS duplicate_count
    FROM creator_earnings
    WHERE stripe_payment_intent_id IS NOT NULL
    GROUP BY stripe_payment_intent_id
    HAVING count(*) > 1
    LIMIT 1
  `));
  if (duplicateTipEarning.rows[0]) {
    throw new Error("Duplicate creator earning PaymentIntent records require financial reconciliation before enabling account deletion");
  }
  await db.execute(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS creator_earnings_pi_unique ON creator_earnings (stripe_payment_intent_id)`));
  tipPaymentIntentSchemaReady = true;
  // Close the rolling-deploy window: notifications written before the actor
  // column became ready deliberately omitted it, so backfill once more before
  // account deletion is enabled.
  await backfillNotificationActors();
  accountDeletionForeignKeysReady = true;
}

/**
 * Cap world tags at the DB level (MAX_WORLD_TAGS in @yumina/shared).
 * The app clamps tags on every write path (clampWorldTags), but a CHECK
 * constraint is the only thing that also stops raw inserts, seed scripts and
 * bulk imports — exactly how the legacy 11–33-tag CHUB cards slipped in.
 *
 * Self-healing + idempotent so it can run on every boot:
 *   1. defensively trim any pre-existing over-limit rows (a no-op once the
 *      one-off cleanup has run) so ADD CONSTRAINT can never fail validation
 *      and break startup;
 *   2. install the CHECK constraint at the current MAX_WORLD_TAGS — when the
 *      cap changes (10→50, 2026-07), the stale-definition constraint is
 *      dropped and re-added; once the definition matches this is a no-op
 *      (matches the `worlds_tags_max` name Drizzle uses for fresh db:push,
 *      so it's never created twice).
 */
function tagsConstraintDDL(table: "worlds" | "bundles", conname: string): string {
  return `
    DO $$
    DECLARE def TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO def
      FROM pg_constraint WHERE conname = '${conname}' AND conrelid = '${table}'::regclass;
      IF def IS NOT NULL AND def NOT LIKE '%<= ${MAX_WORLD_TAGS}%' THEN
        EXECUTE 'ALTER TABLE ${table} DROP CONSTRAINT ${conname}';
        def := NULL;
      END IF;
      IF def IS NULL THEN
        EXECUTE 'ALTER TABLE ${table} ADD CONSTRAINT ${conname} CHECK (jsonb_array_length(tags) <= ${MAX_WORLD_TAGS})';
      END IF;
    END $$;
  `;
}

export async function ensureWorldTagsConstraint() {
  if (IS_PGLITE) {
    // Embedded single-connection database: no lock convoy to guard against,
    // and the extended protocol cannot run this multi-statement script.
    await executeSqlScript(WORLD_AUDIENCE_DDL);
    return;
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql.raw(WORLD_AUDIENCE_DDL));
  });
  await db.execute(sql.raw(`
    UPDATE worlds
    SET tags = (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(tags) WITH ORDINALITY AS x(elem, ord)
      WHERE ord <= ${MAX_WORLD_TAGS}
    )
    WHERE jsonb_array_length(tags) > ${MAX_WORLD_TAGS}
  `));
  await db.execute(sql.raw(tagsConstraintDDL("worlds", "worlds_tags_max")));
}

/**
 * Same tag cap for bundles (see ensureWorldTagsConstraint). Bundle
 * create/update have no Zod schema and the editor is a free-text comma input,
 * so this CHECK + the app-layer clamp are the only guards. Self-healing +
 * idempotent: defensively trim over-limit rows first (a no-op — prod has none),
 * then install/refresh the constraint.
 */
export async function ensureBundleTagsConstraint() {
  if (IS_PGLITE) return;
  await db.execute(sql.raw(`
    UPDATE bundles
    SET tags = (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(tags) WITH ORDINALITY AS x(elem, ord)
      WHERE ord <= ${MAX_WORLD_TAGS}
    )
    WHERE jsonb_array_length(tags) > ${MAX_WORLD_TAGS}
  `));
  await db.execute(sql.raw(tagsConstraintDDL("bundles", "bundles_tags_max")));
}

/**
 * Pre-publish review system. Six additive columns on `worlds` plus the
 * `world_review_submissions` history table. Keep this idempotent so it can
 * run on every boot without breaking existing prod data — matches the
 * pattern of ensureWorldReviewControlsColumn above.
 */
/** Better Auth `jwt` plugin key store. The real apply path is explicit DDL run
 *  against each DB before the code ships (dev 2026-09-12; prod pending); this is
 *  the boot safety net so a missed environment degrades to "first token call
 *  creates the table" instead of a 500. Additive + idempotent. */
export async function ensureJwksTable() {
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS jwks (
      id TEXT PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(), expires_at TIMESTAMP
    )`));
  } catch (error) {
    console.error("[db] ensureJwksTable failed:", error);
  }
}

export async function ensureWorldReviewTables() {
  if (IS_PGLITE) {
    // PGlite dev path: create columns + table directly (no IF NOT EXISTS for
    // ADD COLUMN in older pglite, but it accepts the same syntax).
    try {
      await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS review_status TEXT`));
      await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS submitted_for_review_at TIMESTAMP`));
      await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reviewed_by TEXT`));
      await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP`));
      await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS rejection_reason TEXT`));
      await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS rejection_detail TEXT`));
      await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS world_review_submissions (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        group_key TEXT NOT NULL,
        submitted_by TEXT NOT NULL,
        submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
        decision TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,
        decided_at TIMESTAMP,
        rejection_reason TEXT,
        rejection_detail TEXT,
        snapshot_age_rating TEXT,
        snapshot_is_nsfw BOOLEAN,
        snapshot_target_audience TEXT,
        snapshot_visibility TEXT,
        snapshot_allow_edit BOOLEAN,
        snapshot_allow_reviews BOOLEAN
      )`));
      // Admin "ignore" parking (decision stays 'pending' — author never sees it).
      await db.execute(sql.raw(`ALTER TABLE world_review_submissions ADD COLUMN IF NOT EXISTS ignored_at TIMESTAMP`));
      await db.execute(sql.raw(`ALTER TABLE world_review_submissions ADD COLUMN IF NOT EXISTS ignored_by TEXT`));
    } catch (err) {
      console.warn("[DEV] ensureWorldReviewTables pglite path warning:", err);
    }
    return;
  }
  await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS review_status TEXT`));
  await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS submitted_for_review_at TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES "user"(id) ON DELETE SET NULL`));
  await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS rejection_reason TEXT`));
  await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS rejection_detail TEXT`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS worlds_review_status_idx ON worlds(review_status, submitted_for_review_at)`));

  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS world_review_submissions (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    group_key TEXT NOT NULL,
    submitted_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    decision TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
    decided_at TIMESTAMP,
    rejection_reason TEXT,
    rejection_detail TEXT,
    snapshot_age_rating TEXT,
    snapshot_is_nsfw BOOLEAN,
    snapshot_target_audience TEXT,
    snapshot_visibility TEXT,
    snapshot_allow_edit BOOLEAN,
    snapshot_allow_reviews BOOLEAN
  )`));
  // Admin "ignore" parking columns — additive, decision stays 'pending' so the
  // author-facing review-history never reveals the ignore.
  await db.execute(sql.raw(`ALTER TABLE world_review_submissions ADD COLUMN IF NOT EXISTS ignored_at TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE world_review_submissions ADD COLUMN IF NOT EXISTS ignored_by TEXT REFERENCES "user"(id) ON DELETE SET NULL`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS world_review_submissions_decision_idx ON world_review_submissions(decision, submitted_at)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS world_review_submissions_group_idx ON world_review_submissions(group_key, decision)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS world_review_submissions_world_idx ON world_review_submissions(world_id, submitted_at)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS world_review_submissions_submitter_idx ON world_review_submissions(submitted_by, submitted_at)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS world_review_submissions_ignored_idx ON world_review_submissions(group_key, ignored_at)`));
}

/**
 * Extensions tables are additive and safe to self-heal on hosted Postgres, so a
 * deploy can't 500 if it serves before `0046_extensions.sql` is applied. This is
 * a fallback — per project rule the DDL is applied to each DB before code ships.
 * (PGlite dev gets these via TABLE_DDLS/INDEX_DDLS in ensureTables().)
 */
export async function ensureExtensionTables() {
  if (IS_PGLITE) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS extension_stats (
    extension_key TEXT PRIMARY KEY,
    download_count INTEGER NOT NULL DEFAULT 0,
    review_count INTEGER NOT NULL DEFAULT 0,
    average_rating REAL NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
  )`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS user_extensions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    extension_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'installed',
    installed_at TIMESTAMP DEFAULT NOW(),
    uninstalled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, extension_key)
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS user_extensions_user_id_idx ON user_extensions(user_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS user_extensions_key_status_idx ON user_extensions(extension_key, status)`));
  // Append-only comment feed (no UNIQUE(user, extension), nullable rating);
  // stars live in extension_ratings. Existing databases are reshaped by
  // scripts/2026-08-27-bundle-extension-reviews-to-comments.sql.
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS extension_reviews (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    extension_key TEXT NOT NULL,
    rating INTEGER,
    content TEXT,
    reply_count INTEGER NOT NULL DEFAULT 0,
    hidden_by_creator_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS extension_reviews_key_idx ON extension_reviews(extension_key)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS extension_reviews_user_id_idx ON extension_reviews(user_id)`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS extension_ratings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    extension_key TEXT NOT NULL,
    rating INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, extension_key)
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS extension_ratings_key_idx ON extension_ratings(extension_key)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS extension_ratings_user_id_idx ON extension_ratings(user_id)`));
}

/**
 * Session-context columns are additive and safe to self-heal on hosted
 * Postgres. This keeps testing/prod usable if a deploy starts serving before
 * `db:push` has finished or if a pre-deploy schema push is skipped.
 */
export async function ensureSessionContextColumns() {
  if (IS_PGLITE) return;
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS state_guard_enabled BOOLEAN NOT NULL DEFAULT true`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS state_guard_model TEXT`));
  await db.execute(sql.raw(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS state_validation JSONB`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_updated_at TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_model TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_model TEXT`));
  await db.execute(sql.raw(`
    UPDATE play_sessions
    SET summaryception_model = summary_model
    WHERE summaryception_model IS NULL
      AND summary_model IS NOT NULL
  `));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_implementation TEXT NOT NULL DEFAULT 'localdev'`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_mode TEXT NOT NULL DEFAULT 'threshold'`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_included BOOLEAN NOT NULL DEFAULT true`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_trigger_tokens INTEGER`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_recent_tail_tokens INTEGER`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_status TEXT NOT NULL DEFAULT 'idle'`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_error TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_source_hash TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_covers_until_message_id TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_token_count INTEGER`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_budget_window_started_at TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summary_budget_resume_pending BOOLEAN NOT NULL DEFAULT false`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_status TEXT NOT NULL DEFAULT 'idle'`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_error TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_updated_at TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_source_hash TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_covers_until_message_id TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS summaryception_token_count INTEGER`));
  await db.execute(sql.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'play_sessions' AND column_name = 'summaryception_included'
      ) THEN
        ALTER TABLE play_sessions ADD COLUMN summaryception_included BOOLEAN NOT NULL DEFAULT false;
        UPDATE play_sessions
        SET summaryception_included = true,
            summary_included = false
        WHERE summary_implementation = 'summaryception';
      END IF;
    END $$;
  `));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory JSONB`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_updated_at TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_model TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_included BOOLEAN NOT NULL DEFAULT true`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_status TEXT NOT NULL DEFAULT 'idle'`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_error TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_source_hash TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_claimed_at TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_processed_message_id TEXT`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_retry_count INTEGER NOT NULL DEFAULT 0`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_stale_at TIMESTAMP`));
  await db.execute(sql.raw(`ALTER TABLE play_sessions ADD COLUMN IF NOT EXISTS session_memory_pinned TEXT`));
  await db.execute(sql.raw(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS summaryception_compacted BOOLEAN NOT NULL DEFAULT false`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS summaryception_snippets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
    layer_index INTEGER NOT NULL DEFAULT 0,
    snippet_order INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    source_start_message_id TEXT,
    source_end_message_id TEXT,
    source_start_ordinal INTEGER,
    source_end_ordinal INTEGER,
    source_hash TEXT,
    from_layer INTEGER,
    merged_count INTEGER,
    promoted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS messages_session_summaryception_compacted_idx ON messages(session_id, summaryception_compacted)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS summaryception_snippets_session_layer_idx ON summaryception_snippets(session_id, layer_index, snippet_order)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS summaryception_snippets_session_idx ON summaryception_snippets(session_id)`));
}

/**
 * Events launched after the original production schema flow and need to be
 * available even if a deploy happens before a manual db:push. Keep this
 * additive and idempotent so startup can safely self-heal the missing tables.
 */
export async function ensureCommunityEventTables() {
  for (const ddl of EVENT_TABLE_DDLS) {
    await db.execute(sql.raw(ddl));
  }
  for (const ddl of EVENT_COLUMN_ALTERS) {
    await db.execute(sql.raw(ddl));
  }
  for (const ddl of SOCIAL_EVENT_TABLE_DDLS) {
    await db.execute(sql.raw(ddl));
  }
  for (const ddl of SOCIAL_EVENT_CONSTRAINT_DDLS) {
    await db.execute(sql.raw(ddl));
  }
  for (const ddl of EVENT_INDEX_DDLS) {
    await db.execute(sql.raw(ddl));
  }
}

/**
 * Community post images are additive JSONB columns. Keep this idempotent so a
 * deploy can read/write image attachments even before a manual db:push lands.
 */
export async function ensureCommunityImageColumns() {
  if (IS_PGLITE) return;
  await db.execute(sql.raw(`ALTER TABLE threads ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb`));
  await db.execute(sql.raw(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb`));
}

/**
 * threads.is_official — community-page official card flag, decoupled from
 * is_featured (Discover hub hero). Fallback only: the apply path is
 * scripts/add-thread-official-flag.sql run against each DB before deploy.
 */
export async function ensureCommunityOfficialColumn() {
  if (IS_PGLITE) return;
  await db.execute(sql.raw(`ALTER TABLE threads ADD COLUMN IF NOT EXISTS is_official BOOLEAN NOT NULL DEFAULT false`));
}

/**
 * Platform-achievement tables + the user.showcased_achievement_id column are
 * additive and safe to self-heal on hosted Postgres (same pattern as
 * ensureWorldReviewTables), so a deploy works even before `db:push`.
 */
export async function ensurePlatformAchievementTables() {
  if (IS_PGLITE) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS platform_achievement_groups (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  )`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS platform_achievements (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES platform_achievement_groups(id) ON DELETE CASCADE,
    key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    badge TEXT,
    tier TEXT NOT NULL DEFAULT 'Common',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  )`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS user_platform_achievements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    achievement_id TEXT NOT NULL REFERENCES platform_achievements(id) ON DELETE CASCADE,
    earned_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, achievement_id)
  )`));
  await db.execute(sql.raw(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS showcased_achievement_id TEXT`));
  await db.execute(sql.raw(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_showcased_achievement_fk') THEN
        ALTER TABLE "user" ADD CONSTRAINT user_showcased_achievement_fk
          FOREIGN KEY (showcased_achievement_id) REFERENCES platform_achievements(id) ON DELETE SET NULL;
      END IF;
    END $$;`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS platform_achievements_group_id_idx ON platform_achievements(group_id)`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS user_platform_achievements_user_id_idx ON user_platform_achievements(user_id)`));

  // ── Achievement engine additions (tiers + progress + worlds.published_at) ──
  await db.execute(sql.raw(`ALTER TABLE platform_achievements ADD COLUMN IF NOT EXISTS metric_key TEXT`));
  await db.execute(sql.raw(`ALTER TABLE platform_achievements ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'event'`));
  await db.execute(sql.raw(`ALTER TABLE platform_achievements ADD COLUMN IF NOT EXISTS is_capstone BOOLEAN NOT NULL DEFAULT false`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS platform_achievement_tiers (
    id TEXT PRIMARY KEY,
    achievement_id TEXT NOT NULL REFERENCES platform_achievements(id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'bronze',
    threshold INTEGER NOT NULL DEFAULT 1,
    badge TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(achievement_id, level)
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS platform_achievement_tiers_achievement_id_idx ON platform_achievement_tiers(achievement_id)`));
  await db.execute(sql.raw(`ALTER TABLE user_platform_achievements ADD COLUMN IF NOT EXISTS tier_level TEXT NOT NULL DEFAULT 'bronze'`));
  await db.execute(sql.raw(`DO $$
    DECLARE c text;
    BEGIN
      SELECT conname INTO c FROM pg_constraint
        WHERE conrelid = 'user_platform_achievements'::regclass AND contype = 'u' AND array_length(conkey, 1) = 2
        LIMIT 1;
      IF c IS NOT NULL THEN EXECUTE 'ALTER TABLE user_platform_achievements DROP CONSTRAINT ' || quote_ident(c); END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_platform_ach_user_ach_tier_uniq') THEN
        ALTER TABLE user_platform_achievements ADD CONSTRAINT user_platform_ach_user_ach_tier_uniq UNIQUE (user_id, achievement_id, tier_level);
      END IF;
    END $$;`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS user_achievement_progress (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    metric_key TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, metric_key)
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS user_achievement_progress_user_id_idx ON user_achievement_progress(user_id)`));
  await db.execute(sql.raw(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS published_at TIMESTAMP`));
  await db.execute(sql.raw(`UPDATE worlds SET published_at = COALESCE(reviewed_at, created_at) WHERE published_at IS NULL AND is_published = true`));
}

/**
 * Seed the achievement catalog from the registry. Idempotent (upserts by key +
 * prunes retired keys/tiers) so it runs on every boot for PGlite + hosted Postgres.
 */
export async function seedPlatformAchievements() {
  try {
    await db
      .insert(schema.platformAchievementGroups)
      .values(ACHIEVEMENT_GROUPS.map((g) => ({ key: g.key, title: g.title, description: g.description, sortOrder: g.sortOrder })))
      .onConflictDoUpdate({
        target: schema.platformAchievementGroups.key,
        set: { title: sql`excluded.title`, description: sql`excluded.description`, sortOrder: sql`excluded.sort_order` },
      });

    const groups = await db
      .select({ id: schema.platformAchievementGroups.id, key: schema.platformAchievementGroups.key })
      .from(schema.platformAchievementGroups);
    const groupIdByKey = new Map(groups.map((g) => [g.key, g.id]));

    const achRows = ACHIEVEMENTS
      .map((a, i) => {
        const groupId = groupIdByKey.get(a.groupKey);
        if (!groupId) return null;
        return {
          groupId,
          key: a.key,
          title: a.title,
          description: a.description,
          badge: a.tiers[a.tiers.length - 1]?.badge ?? null,
          metricKey: a.metricKey,
          triggerType: a.triggerType,
          isCapstone: a.isCapstone ?? false,
          sortOrder: i,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (achRows.length > 0) {
      await db
        .insert(schema.platformAchievements)
        .values(achRows)
        .onConflictDoUpdate({
          target: schema.platformAchievements.key,
          set: {
            groupId: sql`excluded.group_id`,
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            badge: sql`excluded.badge`,
            metricKey: sql`excluded.metric_key`,
            triggerType: sql`excluded.trigger_type`,
            isCapstone: sql`excluded.is_capstone`,
            sortOrder: sql`excluded.sort_order`,
          },
        });
    }

    await db.delete(schema.platformAchievements).where(notInArray(schema.platformAchievements.key, ACHIEVEMENTS.map((a) => a.key)));
    await db.delete(schema.platformAchievementGroups).where(notInArray(schema.platformAchievementGroups.key, ACHIEVEMENT_GROUPS.map((g) => g.key)));

    const achievements = await db
      .select({ id: schema.platformAchievements.id, key: schema.platformAchievements.key })
      .from(schema.platformAchievements);
    const achIdByKey = new Map(achievements.map((a) => [a.key, a.id]));
    const tierRows: {
      achievementId: string;
      level: "bronze" | "silver" | "gold" | "diamond";
      threshold: number;
      badge: string;
      sortOrder: number;
    }[] = [];
    for (const a of ACHIEVEMENTS) {
      const achId = achIdByKey.get(a.key);
      if (!achId) continue;
      a.tiers.forEach((t, idx) =>
        tierRows.push({ achievementId: achId, level: t.level, threshold: t.threshold, badge: t.badge, sortOrder: idx }),
      );
    }
    if (tierRows.length > 0) {
      await db
        .insert(schema.platformAchievementTiers)
        .values(tierRows)
        .onConflictDoUpdate({
          target: [schema.platformAchievementTiers.achievementId, schema.platformAchievementTiers.level],
          set: { threshold: sql`excluded.threshold`, badge: sql`excluded.badge`, sortOrder: sql`excluded.sort_order` },
        });
      // Remove tier rows whose (achievement, level) pair left the registry (e.g.
      // an achievement that changed its tier level). The upsert can't delete these.
      const validTierPairs = tierRows.map((t) => `${t.achievementId}:${t.level}`);
      await db.delete(schema.platformAchievementTiers).where(
        notInArray(
          sql`${schema.platformAchievementTiers.achievementId} || ':' || ${schema.platformAchievementTiers.level}`,
          validTierPairs,
        ),
      );
    }
  } catch (err) {
    console.error("[STARTUP] seedPlatformAchievements failed:", (err as Error).message);
  }
}

/**
 * Daily check-ins are additive and can safely self-heal on production startup
 * before a manual db:push has run.
 */
/**
 * Profile announcement wall (see profilePosts in schema.ts). Fallback safety
 * net only — the DDL is applied to prod explicitly first
 * (scripts/create-profile-wall.ts), per the DB-before-code rule.
 */
export async function ensureProfileWallTable() {
  if (IS_PGLITE) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS profile_posts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS profile_posts_user_created_idx ON profile_posts(user_id, created_at)`));
}

/**
 * Ledger of translation attempts that produced no cache row (see
 * lib/translate.ts and lib/translation-sweeper.ts). Safety net only — the
 * DDL ships in scripts/add-translation-attempts.sql and is applied to each
 * database before the code that reads it, per the DB-before-code policy.
 */
export async function ensureTranslationAttemptsTable() {
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS translation_attempts (
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_lang TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_reason TEXT,
    last_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_type, source_id, target_lang)
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS translation_attempts_sweep_idx ON translation_attempts(last_attempt_at)`));
}

export async function ensureCheckInTables() {
  if (IS_PGLITE) return;
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS daily_checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    day_key TEXT NOT NULL,
    week_key TEXT NOT NULL,
    reward_index INTEGER NOT NULL,
    reward_amount INTEGER NOT NULL,
    time_zone TEXT NOT NULL,
    claimed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, day_key)
  )`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS user_checkin_stats (
    user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    time_zone TEXT,
    current_streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    total_checkins INTEGER NOT NULL DEFAULT 0,
    last_day_key TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`));
  await db.execute(sql.raw(`ALTER TABLE user_checkin_stats ADD COLUMN IF NOT EXISTS time_zone TEXT`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS daily_checkins_user_week_idx ON daily_checkins(user_id, week_key)`));
}

/**
 * Billing lineup v2 (2026-09): cohort flag on wallets + scheduled drop ledger.
 * Fallback safety net only — the owner applies scripts/billing-v2.sql to each
 * target DB BEFORE deploying code that reads these (CLAUDE.md: DB leads code).
 */
export async function ensureBillingV2Schema() {
  // Runs on PGlite too. The embedded dev database is created by db:seed with a
  // base credit_wallets and grown by these ALTERs at boot (index.ts heals
  // synchronously before serving when there is no DATABASE_URL). Skipping it
  // here left plan_version missing, and since Drizzle selects every schema
  // column, EVERY wallet read failed with 'column "plan_version" does not
  // exist' — local dev without a Neon URL could not open a wallet at all.
  await db.execute(sql.raw(`ALTER TABLE credit_wallets ADD COLUMN IF NOT EXISTS plan_version INTEGER NOT NULL DEFAULT 1`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS wallet_plan_drops (
    wallet_id TEXT PRIMARY KEY REFERENCES credit_wallets(id) ON DELETE CASCADE,
    period_start TIMESTAMP NOT NULL,
    drops_released INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`));
  // Per-cycle delivery calendar (2026-09-22, scripts/paid-drops-weekly-2026-09-22.sql).
  // NULL rows are cycles that opened under the launch schedule.
  await db.execute(sql.raw(`ALTER TABLE wallet_plan_drops ADD COLUMN IF NOT EXISTS schedule TEXT`));
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS quest_claims (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    day_key TEXT NOT NULL,
    quest_key TEXT NOT NULL,
    reward_amount INTEGER NOT NULL,
    claimed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, day_key)
  )`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS quest_claims_user_claimed_idx ON quest_claims(user_id, claimed_at)`));
}

/**
 * Quest board (2026-09-15): three daily claims out of a six-quest pool plus six
 * weekly goals, so a claim is keyed by period and quest rather than by day.
 * Fallback safety net only — scripts/quest-board-v2.sql is the apply path.
 */
export async function ensureQuestBoardSchema() {
  await db.execute(sql.raw(`ALTER TABLE quest_claims ADD COLUMN IF NOT EXISTS period_kind TEXT NOT NULL DEFAULT 'day'`));
  await db.execute(sql.raw(`ALTER TABLE quest_claims ADD COLUMN IF NOT EXISTS period_key TEXT`));
  await db.execute(sql.raw(`UPDATE quest_claims SET period_key = day_key WHERE period_key IS NULL`));
  await db.execute(sql.raw(`ALTER TABLE quest_claims ALTER COLUMN period_key SET NOT NULL`));
  await db.execute(sql.raw(`ALTER TABLE quest_claims DROP CONSTRAINT IF EXISTS quest_claims_user_day_uniq`));
  await db.execute(sql.raw(`ALTER TABLE quest_claims DROP CONSTRAINT IF EXISTS quest_claims_user_id_day_key_key`));
  await db.execute(sql.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quest_claims_user_period_quest_uniq') THEN
      ALTER TABLE quest_claims ADD CONSTRAINT quest_claims_user_period_quest_uniq UNIQUE (user_id, period_kind, period_key, quest_key);
    END IF;
  END $$`));
  await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS quest_claims_user_period_idx ON quest_claims(user_id, period_kind, period_key)`));
  // Deliberately no index on `messages` or `play_sessions`: both sides of the
  // world-depth join are already covered, and `messages` is 42 GB — a plain
  // CREATE INDEX there would hold ACCESS EXCLUSIVE for minutes at boot.
}

/**
 * The DM redesign is intentionally backwards-compatible with the earlier 1:1
 * table shape. Keep the additive schema pieces self-healing so legacy profile
 * "message" buttons do not 500 if a deploy reaches testing before db:push.
 */
export async function ensureDmSchema() {
  for (const ddl of DM_SCHEMA_DDLS) {
    await db.execute(sql.raw(ddl));
  }
}

/**
 * Self-heal scheduled-job Postgres functions on startup.
 *
 * The credit-recovery, auth-cleanup, playtest-cleanup, and WeChat-renewal
 * functions live in standalone .sql files (packages/server/scripts/) and
 * were previously installed by a human running `psql -f`. That worked
 * exactly until someone forgot — which is what produced the Apr 27 2026
 * "every-day daily-supply not refilling at the promised time" report:
 * the SQL function file in main was updated to use per-user 04:00 local
 * boundaries, but the prod DB still ran the previous UTC-midnight version,
 * so the GitHub Actions hourly cron silently misfired for every Asia user.
 *
 * Running every CREATE OR REPLACE FUNCTION on every server boot is cheap
 * (idempotent, no DDL lock contention worth measuring) and guarantees the
 * deployed function body always matches the source-of-truth file under
 * git history. Tied to the deploy lifecycle = no more drift.
 *
 * Files are resolved relative to this module so the same code works in
 * dev (running .ts under tsx), prod (built .js), and tests. Errors are
 * logged but do NOT block startup — if the SQL is malformed the server
 * still comes up and the cron just keeps using the previously-installed
 * version, which is strictly better than refusing to serve traffic.
 */
const SCHEDULED_FUNCTION_SCRIPTS = [
  "install-daily-recovery-fn.sql",
  "install-cleanup-fns.sql",
  // Every mushie movement must write a ledger row (docs/billing/2026-09-19-ledger-hard-rule.md).
  "install-ledger-guard.sql",
];

export async function ensureScheduledFunctions(): Promise<void> {
  if (IS_PGLITE) return; // these jobs only run against the prod-shaped Postgres
  // Resolve packages/server/scripts/ from this module's location. The build
  // (tsup) preserves the relative directory layout so this works for both
  // src/db/index.ts (dev) and dist/db/index.js (prod).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../scripts"),  // dev: packages/server/src/db → packages/server/scripts
    path.resolve(here, "../scripts"),     // alt: packages/server/dist/db → packages/server/scripts
    path.resolve(here, "../../../scripts"),
  ];
  const scriptsDir = candidates.find((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  if (!scriptsDir) {
    console.warn("[STARTUP] scheduled-function SQL scripts dir not found; skipping install");
    return;
  }
  for (const scriptName of SCHEDULED_FUNCTION_SCRIPTS) {
    const scriptPath = path.join(scriptsDir, scriptName);
    let body: string;
    try {
      body = fs.readFileSync(scriptPath, "utf8");
    } catch (err) {
      console.warn(`[STARTUP] missing ${scriptName}, skipping`, err);
      continue;
    }
    try {
      await db.execute(sql.raw(body));
      console.log(`[STARTUP] installed ${scriptName}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[STARTUP] failed to install ${scriptName}: ${message}`);
    }
  }
}

/**
 * In-process fallback for the daily-recovery cron.
 *
 * GitHub Actions cron is the primary trigger (.github/workflows/daily-credit-recovery.yml,
 * scheduled hourly at :05). It is also _empirically unreliable_: observed in
 * prod on 2026-04-27, 6 of 12 expected hourly runs were skipped entirely and
 * the remaining ones drifted up to +36 min. The longest gap that day was 2h
 * 49m — anyone whose local 04:00 fell inside that gap saw their daily supply
 * arrive late.
 *
 * This setInterval is a redundant safety net that runs the same idempotent
 * Postgres function from inside the Railway server. It does NOT replace the
 * GitHub Actions cron — that's still the authoritative scheduler. This just
 * fills in gaps when GH Actions skips. Worst-case combined delay drops from
 * ~3h to ~30min (the interval period).
 *
 * Safety properties:
 * - The Postgres function itself is idempotent (UPDATE WHERE includes the
 *   eligibility predicate), so concurrent invocations from multiple Railway
 *   replicas + GH Actions can never double-grant.
 * - We skip in PGlite (the function isn't installed there).
 * - Logs are quiet by design: only fail / non-zero affected counts surface,
 *   so the 48 successful no-op runs/day don't drown out real errors.
 * - Returns the interval handle so the SIGTERM handler can clearInterval()
 *   and let the process exit cleanly.
 */
const DAILY_RECOVERY_INTERVAL_MS = 30 * 60 * 1000;
let dailyRecoveryIntervalHandle: ReturnType<typeof setInterval> | null = null;

async function runDailyRecoveryQuiet(): Promise<void> {
  try {
    const result = await db.execute(sql`SELECT run_daily_credit_recovery() AS affected`);
    // pg returns rows as an array; PGlite (already filtered out by caller) has the same shape.
    const affected = Number(((result as unknown as { rows?: Array<{ affected?: unknown }> }).rows?.[0]?.affected) ?? 0);
    if (affected > 0) {
      console.log(`[Cron] daily-recovery interval refreshed ${affected} wallet(s)`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Cron] daily-recovery interval failed: ${message}`);
  }
}

export function startDailyRecoveryInterval(): void {
  if (IS_PGLITE) return;
  if (dailyRecoveryIntervalHandle) return;
  // Leader-locked: one run per ~30-min window across the whole fleet (the
  // function is idempotent, so duplicates were safe — just wasted DB work).
  // TTL sits under the interval so each tick elects exactly one runner.
  void runExclusive("daily-recovery", 25 * 60, runDailyRecoveryQuiet);
  dailyRecoveryIntervalHandle = setInterval(() => {
    void runExclusive("daily-recovery", 25 * 60, runDailyRecoveryQuiet);
  }, DAILY_RECOVERY_INTERVAL_MS);
}

export function stopDailyRecoveryInterval(): void {
  if (dailyRecoveryIntervalHandle) {
    clearInterval(dailyRecoveryIntervalHandle);
    dailyRecoveryIntervalHandle = null;
  }
}

// ─── Daily user-activity rollup (analytics pre-aggregation) ──────────────────
//
// The admin retention / DAU analytics used to scan the 1.18M-row usage_logs
// with several DISTINCT + GROUP BY CTEs on every dashboard load (measured 5-22s
// in prod). This rollup pre-aggregates play activity into ONE row per
// (user, day); the analytics read this small table instead, so the queries run
// in milliseconds even cold, and the open-ended retention matrix stops getting
// more expensive as it widens.
//
// Refreshed incrementally in-process: only the trailing few days need a
// recompute because historical days are immutable (usage_logs is append-only).
// Mirrors startDailyRecoveryInterval — the upsert is idempotent (ON CONFLICT
// rewrites the same recomputed count), so concurrent runs from multiple Railway
// replicas converge to the same state and need no lock.

const PLAY_ENDPOINTS_ROLLUP = sql`('send','regenerate','continue')`;

// Must match FALLBACK_INPUT_PRICE / FALLBACK_OUTPUT_PRICE in admin-usage.ts —
// applied to the rare model without an active model_prices row.
const ROLLUP_FALLBACK_INPUT_PRICE = 3.0;
const ROLLUP_FALLBACK_OUTPUT_PRICE = 15.0;

/**
 * Self-heal the analytics rollup tables (idempotent). Prod + dev Neon also get
 * these via explicit pre-deploy SQL (DB-before-code); this keeps PGlite and
 * fresh clones in parity. All day buckets are UTC calendar days.
 *
 * No FKs on purpose: creating a table that REFERENCES a hot table takes a lock
 * on it during deploy (cf. the 2026-06-11 self-heal lock failure documented in
 * index.ts). Orphan rows after deletes are a negligible analytics over-count.
 */
export async function ensureAnalyticsRollupTables(): Promise<void> {
  await db.transaction(async (tx) => {
    // IF NOT EXISTS can still race in PostgreSQL's type catalog on a fresh DB.
    // Keep the lock and all DDL on one transaction/connection across replicas.
    if (!IS_PGLITE) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('yumina:analytics-rollup-schema'))`);
    }
    await tx.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS daily_user_activity (
        user_id       TEXT NOT NULL,
        activity_date DATE NOT NULL,
        play_messages INTEGER NOT NULL DEFAULT 0,
        krew_minutes  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, activity_date)
      )
    `));
    // krew.io play minutes (lib/krew-activity.ts). Applied by hand to dev and
    // prod 2026-09-14; this is the boot fallback for any other environment.
    await tx.execute(sql.raw(
      `ALTER TABLE daily_user_activity ADD COLUMN IF NOT EXISTS krew_minutes INTEGER NOT NULL DEFAULT 0`,
    ));
    await tx.execute(sql.raw(
      `CREATE INDEX IF NOT EXISTS daily_user_activity_date_idx ON daily_user_activity (activity_date)`,
    ));
    await tx.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS daily_platform_stats (
        stat_date           DATE PRIMARY KEY,
        signups             INTEGER NOT NULL DEFAULT 0,
        sessions            INTEGER NOT NULL DEFAULT 0,
        playtime_seconds    BIGINT NOT NULL DEFAULT 0,
        addon_purchases     INTEGER NOT NULL DEFAULT 0,
        addon_revenue_cents INTEGER NOT NULL DEFAULT 0,
        updated_at          TIMESTAMP NOT NULL DEFAULT now()
      )
    `));
    await tx.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS daily_model_stats (
        stat_date              DATE NOT NULL,
        model                  TEXT NOT NULL,
        category               TEXT NOT NULL,
        messages               INTEGER NOT NULL DEFAULT 0,
        prompt_tokens          BIGINT NOT NULL DEFAULT 0,
        completion_tokens      BIGINT NOT NULL DEFAULT 0,
        byok_messages          INTEGER NOT NULL DEFAULT 0,
        byok_prompt_tokens     BIGINT NOT NULL DEFAULT 0,
        byok_completion_tokens BIGINT NOT NULL DEFAULT 0,
        cost                   NUMERIC(14,6) NOT NULL DEFAULT 0,
        input_cost             NUMERIC(14,6) NOT NULL DEFAULT 0,
        output_cost            NUMERIC(14,6) NOT NULL DEFAULT 0,
        updated_at             TIMESTAMP NOT NULL DEFAULT now(),
        PRIMARY KEY (stat_date, model, category)
      )
    `));
    await tx.execute(sql.raw(
      `CREATE INDEX IF NOT EXISTS daily_model_stats_date_idx ON daily_model_stats (stat_date)`,
    ));
  });
}

/**
 * Upsert the trailing `days` days of play activity into the rollup. Idempotent:
 * ON CONFLICT recomputes the same per-day count. A huge `days` = full backfill.
 *
 * `${days}` MUST be cast: bare `CURRENT_DATE - $1` resolves as date - date →
 * integer, making the comparison `timestamp >= integer` blow up. This exact
 * bug silently killed every refresh tick from 2026-06-29 to 2026-07-24. The
 * predicate is also deliberately on raw `created_at` (not `created_at::date`)
 * so the created_at index is used instead of a full seq scan.
 */
async function refreshDailyUserActivity(days: number): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO daily_user_activity (user_id, activity_date, play_messages)
    SELECT user_id, created_at::date, COUNT(*)::int
    FROM usage_logs
    WHERE endpoint IN ${PLAY_ENDPOINTS_ROLLUP}
      AND created_at >= CURRENT_DATE - (${days}::int)
    GROUP BY user_id, created_at::date
    ON CONFLICT (user_id, activity_date)
    DO UPDATE SET play_messages = EXCLUDED.play_messages
  `);
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Per-day platform aggregates: signups, sessions + playtime, addon revenue.
 * Three idempotent upserts; a day's row is created by whichever source fires
 * first and enriched by the rest. Sessions/playtime are attributed to the
 * session's creation day (same semantics the live sparkline queries used).
 * Rolling up from mutable play_sessions also FREEZES history at refresh time —
 * user deletions stop silently rewriting old analytics.
 */
async function refreshDailyPlatformStats(days: number): Promise<number> {
  let total = 0;
  const count = (r: unknown) => (r as { rowCount?: number }).rowCount ?? 0;
  total += count(await db.execute(sql`
    INSERT INTO daily_platform_stats (stat_date, signups)
    SELECT created_at::date, COUNT(*)::int
    FROM "user"
    WHERE created_at >= CURRENT_DATE - (${days}::int)
    GROUP BY 1
    ON CONFLICT (stat_date) DO UPDATE SET
      signups = EXCLUDED.signups, updated_at = now()
  `));
  total += count(await db.execute(sql`
    INSERT INTO daily_platform_stats (stat_date, sessions, playtime_seconds)
    SELECT created_at::date, COUNT(*)::int, COALESCE(SUM(playtime_seconds), 0)::bigint
    FROM play_sessions
    WHERE created_at >= CURRENT_DATE - (${days}::int)
    GROUP BY 1
    ON CONFLICT (stat_date) DO UPDATE SET
      sessions = EXCLUDED.sessions,
      playtime_seconds = EXCLUDED.playtime_seconds,
      updated_at = now()
  `));
  // Addon price mapping mirrors the (legacy) hardcoded amount→price table the
  // revenue KPI always used. Snapshotting it per-day here means a future
  // mapping change won't silently rewrite revenue history.
  total += count(await db.execute(sql`
    INSERT INTO daily_platform_stats (stat_date, addon_purchases, addon_revenue_cents)
    SELECT created_at::date, COUNT(*)::int,
      COALESCE(SUM(CASE
        WHEN amount IN (750, 1000) THEN 299 WHEN amount IN (2250, 3000) THEN 699
        WHEN amount IN (7500, 10000) THEN 1999 WHEN amount IN (15000, 20000) THEN 3499
        WHEN amount IN (33000, 44000) THEN 6899 WHEN amount IN (87000, 116000) THEN 16899
        ELSE ROUND(amount * 0.2)
      END), 0)::int
    FROM credit_transactions
    WHERE type = 'addon' AND created_at >= CURRENT_DATE - (${days}::int)
    GROUP BY 1
    ON CONFLICT (stat_date) DO UPDATE SET
      addon_purchases = EXCLUDED.addon_purchases,
      addon_revenue_cents = EXCLUDED.addon_revenue_cents,
      updated_at = now()
  `));
  return total;
}

/**
 * Per-day × model × category (play/studio/other) usage rollup. Token columns
 * count ALL traffic; the byok_* columns are the BYOK subset (subtract for
 * platform-paid). `cost` is non-BYOK only, priced with the model_prices rows
 * active at refresh time — freezing cost history against later price edits.
 */
async function refreshDailyModelStats(days: number): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO daily_model_stats (
      stat_date, model, category, messages, prompt_tokens, completion_tokens,
      byok_messages, byok_prompt_tokens, byok_completion_tokens, cost, input_cost, output_cost
    )
    SELECT
      ul.created_at::date,
      COALESCE(ul.model, 'unknown'),
      CASE
        WHEN ul.endpoint IN ${PLAY_ENDPOINTS_ROLLUP} THEN 'play'
        WHEN ul.endpoint IN ('studio-agent','studio-playtest') THEN 'studio'
        ELSE 'other'
      END,
      COUNT(*)::int,
      COALESCE(SUM(ul.prompt_tokens), 0)::bigint,
      COALESCE(SUM(ul.completion_tokens), 0)::bigint,
      COUNT(*) FILTER (WHERE ul.api_key_tier = 'byok')::int,
      COALESCE(SUM(ul.prompt_tokens) FILTER (WHERE ul.api_key_tier = 'byok'), 0)::bigint,
      COALESCE(SUM(ul.completion_tokens) FILTER (WHERE ul.api_key_tier = 'byok'), 0)::bigint,
      COALESCE(SUM(CASE WHEN ul.api_key_tier = 'byok' THEN 0 ELSE
        (ul.prompt_tokens * COALESCE(mp.input_price_per_m, ${ROLLUP_FALLBACK_INPUT_PRICE})
         + ul.completion_tokens * COALESCE(mp.output_price_per_m, ${ROLLUP_FALLBACK_OUTPUT_PRICE})) / 1000000.0
      END), 0),
      COALESCE(SUM(CASE WHEN ul.api_key_tier = 'byok' THEN 0 ELSE
        ul.prompt_tokens * COALESCE(mp.input_price_per_m, ${ROLLUP_FALLBACK_INPUT_PRICE}) / 1000000.0
      END), 0),
      COALESCE(SUM(CASE WHEN ul.api_key_tier = 'byok' THEN 0 ELSE
        ul.completion_tokens * COALESCE(mp.output_price_per_m, ${ROLLUP_FALLBACK_OUTPUT_PRICE}) / 1000000.0
      END), 0)
    FROM usage_logs ul
    LEFT JOIN model_prices mp ON mp.model_id = ul.model AND mp.is_active = true
    WHERE ul.created_at >= CURRENT_DATE - (${days}::int)
    GROUP BY 1, 2, 3
    ON CONFLICT (stat_date, model, category) DO UPDATE SET
      messages = EXCLUDED.messages,
      prompt_tokens = EXCLUDED.prompt_tokens,
      completion_tokens = EXCLUDED.completion_tokens,
      byok_messages = EXCLUDED.byok_messages,
      byok_prompt_tokens = EXCLUDED.byok_prompt_tokens,
      byok_completion_tokens = EXCLUDED.byok_completion_tokens,
      cost = EXCLUDED.cost,
      input_cost = EXCLUDED.input_cost,
      output_cost = EXCLUDED.output_cost,
      updated_at = now()
  `);
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

// ─── Feed training log + engagement stats (recsys Ship 1) ──────────────────

/** Self-heal fallback for the Ship-1 tables. The real apply path is the
 * explicit DDL in scripts/recsys-ship1.sql run against each DB BEFORE the
 * code deploys (CLAUDE.md: DB leads code); this exists so a fresh dev
 * database boots working. Mirrors packages/server/src/db/schema.ts. */
export async function ensureFeedTrainingTables(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS feed_serves (
      id         TEXT PRIMARY KEY,
      user_id    TEXT,
      surface    TEXT NOT NULL,
      feed       TEXT NOT NULL,
      tier       TEXT,
      variant    TEXT NOT NULL DEFAULT 'control',
      lang       TEXT,
      "offset"   INTEGER NOT NULL DEFAULT 0,
      world_ids  JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    )
  `));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS feed_serves_created_idx ON feed_serves (created_at)`,
  ));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS feed_serves_user_idx ON feed_serves (user_id, created_at)`,
  ));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS feed_events (
      id              BIGSERIAL PRIMARY KEY,
      feed_request_id TEXT,
      user_id         TEXT,
      world_id        TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      position        INTEGER,
      surface         TEXT,
      created_at      TIMESTAMP NOT NULL DEFAULT now()
    )
  `));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS feed_events_world_idx ON feed_events (world_id, created_at)`,
  ));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS feed_events_user_idx ON feed_events (user_id, created_at)`,
  ));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS feed_events_created_idx ON feed_events (created_at)`,
  ));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS world_engagement_stats (
      world_id           TEXT PRIMARY KEY,
      impressions_7d     INTEGER NOT NULL DEFAULT 0,
      clicks_7d          INTEGER NOT NULL DEFAULT 0,
      plays_started_7d   INTEGER NOT NULL DEFAULT 0,
      qualified_plays_7d INTEGER NOT NULL DEFAULT 0,
      plays_prev_7d      INTEGER NOT NULL DEFAULT 0,
      impressions_total  INTEGER NOT NULL DEFAULT 0,
      clicks_total       INTEGER NOT NULL DEFAULT 0,
      returners_30d          INTEGER NOT NULL DEFAULT 0,
      total_play_minutes_30d INTEGER NOT NULL DEFAULT 0,
      updated_at         TIMESTAMP NOT NULL DEFAULT now()
    )
  `));
  // Retention-proven cold-start columns (added 2026-08-22). ADD COLUMN for
  // DBs whose table predates them — prod got these via explicit DDL before
  // this shipped; this is the dev self-heal (CLAUDE.md: DB leads code).
  await db.execute(sql.raw(
    `ALTER TABLE world_engagement_stats ADD COLUMN IF NOT EXISTS returners_30d integer NOT NULL DEFAULT 0`,
  ));
  await db.execute(sql.raw(
    `ALTER TABLE world_engagement_stats ADD COLUMN IF NOT EXISTS total_play_minutes_30d integer NOT NULL DEFAULT 0`,
  ));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS world_dismissals (
      user_id    TEXT NOT NULL,
      world_id   TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, world_id)
    )
  `));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS world_dismissals_user_idx ON world_dismissals (user_id)`,
  ));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS ranker_models (
      id            BIGSERIAL PRIMARY KEY,
      status        TEXT NOT NULL DEFAULT 'published',
      model         JSONB NOT NULL,
      feature_names JSONB NOT NULL,
      metrics       JSONB NOT NULL,
      trained_at    TIMESTAMP NOT NULL DEFAULT now(),
      created_at    TIMESTAMP NOT NULL DEFAULT now()
    )
  `));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS ranker_models_status_idx ON ranker_models (status, id)`,
  ));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS world_similarities (
      world_id         TEXT NOT NULL,
      similar_world_id TEXT NOT NULL,
      score            REAL NOT NULL,
      rank             INTEGER NOT NULL,
      updated_at       TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (world_id, similar_world_id)
    )
  `));
  await db.execute(sql.raw(
    `CREATE INDEX IF NOT EXISTS world_similarities_world_idx ON world_similarities (world_id, rank)`,
  ));
  // ALS latent-factor vectors (Ship 4). Prod got these via explicit DDL before
  // the serving code shipped; this is the dev self-heal.
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS world_latent_factors (
      world_id   TEXT PRIMARY KEY,
      factors    JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `));
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS user_latent_factors (
      user_id    TEXT PRIMARY KEY,
      factors    JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `));
}

/** Sessions reaching this playtime count as a "qualified play" (the
 * anti-clickbait bar — mirrors Roblox's qualified-play-through framing). */
const QUALIFIED_PLAY_SECONDS = 300;

/** Once feed_events has this much history, its impression/click columns
 * take over from the PostHog-backfilled seed. Before that a 7d window
 * would be a partial-week undercount and CTRs would skew low. */
const FEED_EVENTS_READY_DAYS = 3;

/**
 * Refresh `world_engagement_stats`. Play-side columns (starts, qualified,
 * prev-week) recompute from play_sessions every tick — live from day one.
 * Feed-side columns (impressions/clicks) recompute from feed_events only
 * once that log is mature (see FEED_EVENTS_READY_DAYS); until then they
 * keep the seeded values. Ends by dropping the Redis snapshot so feeds
 * pick up fresh numbers within one profile TTL.
 */
/** Postgres cancels a standby query whose snapshot blocks WAL replay with
 *  SQLSTATE 40001 "canceling statement due to conflict with recovery". Drizzle
 *  may surface the driver error directly or wrapped as `cause`. */
function isRecoveryConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  const message = `${String(e?.message ?? "")} ${String(e?.cause?.message ?? "")}`;
  return code === "40001" || /conflict with recovery/i.test(message);
}

/**
 * Run a heavy aggregate on the read replica, surviving recovery conflicts.
 * The 30-day play_sessions / feed_events scans below take seconds, and the
 * Neon replica cancels them whenever replay needs to reclaim rows they still
 * see. From 2026-09-11 that killed the world_engagement_stats refresh ~75×
 * a day (PostHog `rollup_refresh_failed`), so ranking signals went stale.
 * A retry gets a fresh snapshot and usually completes; if the replica keeps
 * cancelling, run the statement once on the primary rather than skip the tick.
 */
async function executeReplicaAggregate(query: SQL): Promise<Awaited<ReturnType<DrizzleDB["execute"]>>> {
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await dbRead.execute(query);
    } catch (err) {
      if (!isRecoveryConflict(err)) throw err;
      if (attempt >= attempts) {
        console.warn(`[Rollup] replica cancelled the aggregate ${attempts}× (recovery conflict); running once on the primary`);
        return await db.execute(query);
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
}

/**
 * Upsert precomputed engagement rows in ONE statement. The aggregates are
 * computed on the read replica (they scan 30 days of play_sessions and the
 * feed logs — the feed-side INSERT…SELECT averaged 9.1s on the primary, 4.4k
 * runs since 07-28) and only the ~15k result rows touch the primary, carried
 * as a single jsonb parameter. `columns` are compile-time constants, hence
 * sql.raw is safe here.
 */
async function upsertEngagementStats(
  rows: Array<Record<string, unknown>>,
  columns: readonly string[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const colList = sql.raw(columns.join(", "));
  const selectList = sql.raw(columns.map((c) => `x.${c}`).join(", "));
  const recordDef = sql.raw(columns.map((c) => `${c} int`).join(", "));
  const setList = sql.raw(columns.map((c) => `${c} = EXCLUDED.${c}`).join(", "));
  const r = await db.execute(sql`
    INSERT INTO world_engagement_stats (world_id, ${colList}, updated_at)
    SELECT x.world_id, ${selectList}, now()
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(world_id text, ${recordDef})
    ON CONFLICT (world_id) DO UPDATE SET ${setList}, updated_at = now()`);
  return (r as { rowCount?: number }).rowCount ?? 0;
}

async function refreshWorldEngagementStats(): Promise<number> {
  let total = 0;
  const rowsOf = (r: unknown) => ((r as { rows?: Array<Record<string, unknown>> }).rows ?? []);

  const playRows = rowsOf(await executeReplicaAggregate(sql`
    SELECT w.id AS world_id,
           COALESCE(cur.starts, 0)::int AS plays_started_7d,
           COALESCE(cur.qualified, 0)::int AS qualified_plays_7d,
           COALESCE(prev.starts, 0)::int AS plays_prev_7d,
           COALESCE(ret.returners, 0)::int AS returners_30d,
           COALESCE(ret.total_minutes, 0)::int AS total_play_minutes_30d
    FROM worlds w
    LEFT JOIN (
      SELECT world_id, COUNT(*)::int AS starts,
             (COUNT(*) FILTER (WHERE playtime_seconds >= ${QUALIFIED_PLAY_SECONDS}))::int AS qualified
      FROM play_sessions
      WHERE created_at >= now() - interval '7 days'
      GROUP BY world_id
    ) cur ON cur.world_id = w.id
    LEFT JOIN (
      SELECT world_id, COUNT(*)::int AS starts
      FROM play_sessions
      WHERE created_at >= now() - interval '14 days'
        AND created_at < now() - interval '7 days'
      GROUP BY world_id
    ) prev ON prev.world_id = w.id
    LEFT JOIN (
      -- Retention-proven cold-start signal: how many distinct users came
      -- BACK to this world (>=2 sessions) and the total capped minutes it
      -- generated, over 30 days. Feeds composeColdStartSlate so new users
      -- see worlds that many people actually returned to — not just the
      -- most-downloaded. Playtime capped per session (tab-left-open guard).
      SELECT world_id,
             (COUNT(*) FILTER (WHERE sessions >= 2))::int AS returners,
             (SUM(mins) / 60.0)::int AS total_minutes
      FROM (
        SELECT world_id, user_id, COUNT(*) AS sessions,
               SUM(LEAST(playtime_seconds, 3600)) AS mins
        FROM play_sessions
        WHERE created_at >= now() - interval '30 days'
          AND user_id IS NOT NULL AND COALESCE(ephemeral, false) = false
        GROUP BY world_id, user_id
      ) uw
      GROUP BY world_id
    ) ret ON ret.world_id = w.id
    WHERE w.is_published = true AND w.status = 'published'
  `));
  total += await upsertEngagementStats(playRows, [
    "plays_started_7d",
    "qualified_plays_7d",
    "plays_prev_7d",
    "returners_30d",
    "total_play_minutes_30d",
  ]);

  const readiness = await executeReplicaAggregate(sql`
    SELECT MIN(created_at) <= now() - (${FEED_EVENTS_READY_DAYS}::int * interval '1 day') AS ready
    FROM feed_events
  `);
  const ready = Boolean(
    (readiness as unknown as { rows?: Array<{ ready?: boolean }> }).rows?.[0]?.ready,
  );
  if (ready) {
    // 30d bound keeps this a rolling "recent lifetime": the explore gate
    // only needs to know whether a world crossed ~500 impressions, and an
    // unbounded scan would grow forever.
    const feedRows = rowsOf(await executeReplicaAggregate(sql`
      -- Anti-forgery: feed_events is a CLIENT-supplied beacon, so raw counts
      -- are forgeable (a creator could POST fake impressions/clicks for their
      -- own world, or click-less impressions on a rival to tank its CTR and
      -- burn its explore budget). feed_serves is SERVER-authoritative — its
      -- world_ids are exactly the slate the server emitted and cannot be
      -- forged. So we only count an event when (a) its feed_request_id
      -- matches a real serve and (b) the world was actually in that served
      -- slate, then dedup to ONE event per (serve, world, type) so replaying
      -- the same slate can't inflate. Phantom/unpublished worldIds are
      -- dropped by the worlds join. This is the ranking signal, so it must be
      -- trustworthy; the client-side surfaces without a serve (Continue row,
      -- deep links) are re-engagement, not discovery CTR, and drop out here
      -- by design. (No active abuse seen as of 2026-08-21; this hardens
      -- before the growth campaign makes it worth attacking.)
      WITH valid AS (
        SELECT fe.feed_request_id, fe.world_id, fe.event_type,
               MIN(fe.created_at) AS created_at
        FROM feed_events fe
        JOIN feed_serves fs ON fs.id = fe.feed_request_id
        WHERE fe.created_at >= now() - interval '30 days'
          AND fe.event_type IN ('impression', 'click')
          AND fs.world_ids ? fe.world_id
        GROUP BY fe.feed_request_id, fe.world_id, fe.event_type
      )
      SELECT v.world_id,
        (COUNT(*) FILTER (WHERE v.event_type = 'impression' AND v.created_at >= now() - interval '7 days'))::int AS impressions_7d,
        (COUNT(*) FILTER (WHERE v.event_type = 'click' AND v.created_at >= now() - interval '7 days'))::int AS clicks_7d,
        (COUNT(*) FILTER (WHERE v.event_type = 'impression'))::int AS impressions_total,
        (COUNT(*) FILTER (WHERE v.event_type = 'click'))::int AS clicks_total
      FROM valid v
      JOIN worlds w ON w.id = v.world_id AND w.is_published = true AND w.status = 'published'
      GROUP BY v.world_id
    `));
    total += await upsertEngagementStats(feedRows, [
      "impressions_7d",
      "clicks_7d",
      "impressions_total",
      "clicks_total",
    ]);
  }

  await invalidateEngagementStatsCache();
  return total;
}

/** Rolling retention for the training log: serves 30d (bulky jsonb
 * slates), events 90d (the ranker's label window). Index-bounded deletes. */
async function pruneFeedTrainingLogs(): Promise<number> {
  let total = 0;
  const count = (r: unknown) => (r as { rowCount?: number }).rowCount ?? 0;
  total += count(await db.execute(sql`
    DELETE FROM feed_serves WHERE created_at < now() - interval '30 days'
  `));
  total += count(await db.execute(sql`
    DELETE FROM feed_events WHERE created_at < now() - interval '90 days'
  `));
  return total;
}

/** Every Nth analytics tick (5-min cadence → ~30 min) the heavier
 * feed-side scan + prune run; play-side stats refresh every tick. */
let engagementTickCounter = 0;

// 20 min (was 5). These are DAILY rollups for the admin dashboard and 7-day
// engagement windows for ranking; in prod the world_engagement_stats refresh
// alone held a primary backend for ~16s p50 every tick (566 runs in 2 days),
// and daily_user_activity another ~2s — heavy INSERT…SELECTs that queue the
// cheap per-request reads behind them. Four ticks an hour keeps the freshness
// stamp honest for a dashboard read a few times a day.
const ANALYTICS_ROLLUP_INTERVAL_MS = 20 * 60 * 1000;
let analyticsRollupHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Refresh all three rollups. Failures are logged AND surfaced to PostHog —
 * the 2026-06/07 incident proved a console.error in Railway logs is invisible:
 * the user-activity refresher failed on every tick for four weeks and the
 * dashboard served June data with full confidence.
 */
async function refreshAnalyticsRollupsQuiet(days: number): Promise<void> {
  engagementTickCounter += 1;
  const jobs: Array<[string, (d: number) => Promise<number>]> = [
    ...(process.env.ADMIN_ANALYTICS_ENABLED==='true'?[]:[
    ["daily_user_activity", refreshDailyUserActivity],
    ["daily_platform_stats", refreshDailyPlatformStats],
    ["daily_model_stats", refreshDailyModelStats],
    ] as Array<[string,(d:number)=>Promise<number>]>),
    ["world_engagement_stats", () => refreshWorldEngagementStats()],
    // Retention pruning is cheap when there's nothing to delete; every
    // 3rd tick (~1 h at the 20-min cadence) keeps delete churn off the hot ticks.
    ...(engagementTickCounter % 3 === 1
      ? ([["feed_training_prune", () => pruneFeedTrainingLogs()]] as Array<
          [string, (d: number) => Promise<number>]
        >)
      : []),
  ];
  for (const [table, refresh] of jobs) {
    try {
      const n = await refresh(days);
      if (n > 0) console.log(`[Rollup] ${table} upserted ${n} row(s) (last ${days}d)`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Rollup] ${table} refresh failed: ${message}`);
      posthog.capture({
        distinctId: "server",
        event: "rollup_refresh_failed",
        properties: { table, error: message.slice(0, 300) },
      });
    }
  }
  if(process.env.ADMIN_ANALYTICS_ENABLED==='true')return;
  // Staleness canary: if the freshest activity day is >2 days old the pipeline
  // is dead regardless of what the individual ticks claim — alert on the state,
  // not just the errors.
  try {
    const r = await db.execute(sql`
      SELECT (MAX(activity_date) < CURRENT_DATE - 2) AS stale, MAX(activity_date)::text AS max_date
      FROM daily_user_activity
    `);
    const row = (r as unknown as { rows?: Array<{ stale?: boolean; max_date?: string }> }).rows?.[0];
    if (row?.stale) {
      console.error(`[Rollup] STALE: daily_user_activity max date is ${row.max_date}`);
      posthog.capture({
        distinctId: "server",
        event: "rollup_stale",
        properties: { table: "daily_user_activity", max_date: row.max_date ?? null },
      });
    }
  } catch { /* canary is best-effort */ }
}

/**
 * Start the in-process analytics rollup refresher. On boot it backfills all
 * history once if the user-activity table is empty (fresh/dev DB), otherwise
 * it refreshes the trailing window; then every 20 min it recomputes the last
 * 2 days (index-bounded). Call stopAnalyticsRollupInterval() from the
 * SIGTERM handler for a clean exit.
 */
export function startAnalyticsRollupInterval(): void {
  if (analyticsRollupHandle) return;
  void (async () => {
    // Self-heal the tables here too: this interval starts at boot, BEFORE the
    // deferred background schema self-heal runs, so we can't assume they exist.
    try {
      await ensureAnalyticsRollupTables();
      await ensureFeedTrainingTables();
    } catch (err) {
      console.error(`[Rollup] ensure tables failed: ${err instanceof Error ? err.message : String(err)}`);
      return; // no tables → skip; the next tick (or self-heal) retries
    }
    let empty = false;
    try {
      const r = process.env.ADMIN_ANALYTICS_ENABLED==='true'?{rows:[{n:1}]}:await db.execute(sql`SELECT COUNT(*)::int AS n FROM daily_user_activity`);
      empty = Number((r as unknown as { rows?: Array<{ n?: unknown }> }).rows?.[0]?.n ?? 0) === 0;
    } catch {
      /* shouldn't happen right after ensure */
    }
    await runExclusive("analytics-rollup", 4 * 60, () =>
      refreshAnalyticsRollupsQuiet(empty ? 100_000 : 3),
    );
  })();
  analyticsRollupHandle = setInterval(() => {
    void runExclusive("analytics-rollup", 4 * 60, () => refreshAnalyticsRollupsQuiet(2));
  }, ANALYTICS_ROLLUP_INTERVAL_MS);
}

export function stopAnalyticsRollupInterval(): void {
  if (analyticsRollupHandle) {
    clearInterval(analyticsRollupHandle);
    analyticsRollupHandle = null;
  }
}

/**
 * Get the appropriate DB for read operations, respecting read-after-write consistency.
 * - If user just did a write (flagged in Redis for 5s), returns primary `db`
 * - Otherwise returns `dbRead` (replica if configured, primary if not)
 * - No user context → always returns replica (public browsing)
 */
export async function readDb(userId?: string | null): Promise<DrizzleDB> {
  if (dbRead === db || !userId || !redis) return dbRead;
  try {
    const flag = await redis.get(`rw:${userId}`);
    return flag ? db : dbRead;
  } catch {
    // The flag is a 5s consistency hint — a Redis stall/disconnect must degrade
    // to the replica (same as an expired flag), never 500 the request. Before
    // this guard, a single Redis "Command timed out" here failed every
    // read-routed browse request (hub/featured/notifications, ~2.3k 500s in
    // 14d, 2026-07-02 stall). Redis health is already alerted via the
    // rate-limit fallback events; no capture needed per call.
    return dbRead;
  }
}

/** Flag a user as having just written, so their reads use primary for 5 seconds. */
export async function flagWrite(userId: string): Promise<void> {
  // Redis is an optimization. A flag failure must never fail the write.
  await setReadAfterWriteFlag(redis, userId);
}

// ─── Intent-revealing read routing ──────────────────────────────────────────
// Prefer these over readDb() at call sites. The 5s flagWrite window is fragile
// (useless for reads >5s after a write, or for long/streaming writes), and the
// 2026-06-05 incident showed a blanket "all reads to primary" sledgehammer
// collapses capacity. Policy: PRIMARY by default for a user's own state; the
// replica is an explicit opt-in for high-traffic public browse only.

/**
 * Read a user's OWN mutable state, or any guard read that precedes a write in the
 * same request (auth/role/lock/ownership/existence checks). ALWAYS returns the
 * primary `db` — consistency is structural, not gated on the 5s flag. The userId
 * arg is accepted for call-site symmetry with readDb but is intentionally unused.
 * Cost is negligible: small, indexed, per-user reads. Heavy public browse stays on
 * the replica via readPublic().
 */
export async function readOwn(_userId?: string | null): Promise<DrizzleDB> {
  return db;
}

/**
 * Read public/browse/aggregate data, or another user's PUBLIC data. ALWAYS returns
 * the replica `dbRead` (=== db when no replica is configured). This is what keeps
 * the replica shedding heavy read load (Discover, hub, search, public profiles,
 * analytics). A few seconds of staleness is acceptable. NEVER route a user's own
 * just-written state through this — use readOwn().
 */
export function readPublic(): DrizzleDB {
  return dbRead;
}

/**
 * Read content for an editor view: primary when the viewer owns the content (must
 * see their own in-progress edits immediately — e.g. after a minutes-long Studio
 * agent run, where the 5s flag is long expired), replica otherwise (public viewer).
 */
export async function readForEdit(viewerId: string | null | undefined, ownerId: string): Promise<DrizzleDB> {
  return viewerId && viewerId === ownerId ? db : dbRead;
}

export { db, dbRead };
export type Database = typeof db;
