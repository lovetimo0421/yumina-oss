import { z } from "zod";
import { config } from "dotenv";

config({ path: "../../.env" });

// Edition is resolved BEFORE the schema so defaults can depend on it.
//   hosted — yumina.io: hub, billing, community, admin, multi-user auth.
//   local  — the open-source self-hosted build: no platform services, one
//            local account by default, embedded PGlite + on-disk assets.
// The open-source export pins this to "local"; the private build defaults to
// "hosted" and can be flipped with YUMINA_EDITION=local to test the OSS shape.
const RAW_EDITION = process.env.YUMINA_EDITION === "hosted" ? "hosted" : "local";
const IS_LOCAL = RAW_EDITION === "local";

/** Treat "" the same as unset so `.optional()` / `.default()` apply. */
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envSchema = z.object({
  DATABASE_URL: z.preprocess(
    (value) => {
      if (typeof value === "string" && value.trim() === "") return undefined;
      return value;
    },
    z.string().url().optional()
  ),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(100),
  IMAGE_EXECUTION_MODE: z.enum(["embedded", "external"]).default("embedded"),
  IMAGE_EVENT_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(50_000).default(25_000),
  YUMINA_EDITION: z.enum(["hosted", "local"]).default("hosted"),
  // single-user: one auto-signed-in local account, no login screen (local default).
  // multi-user: Better Auth email/password (+ optional social providers).
  YUMINA_AUTH_MODE: z.preprocess(emptyToUndefined, z.enum(["single-user", "multi-user"]).optional()),
  // Root folder for everything a local install persists (PGlite + assets).
  YUMINA_DATA_DIR: z.preprocess(emptyToUndefined, z.string().default(IS_LOCAL ? "./data" : "./.yumina-data")),
  // On-disk asset storage, used when no S3 bucket is configured. Resolved below.
  YUMINA_STORAGE_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  // Public origin of this deployment (cookies, CORS, links in emails, SEO).
  // Unset = derive from BETTER_AUTH_URL.
  PUBLIC_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
  // Bind address. Unset = Node's default (all interfaces, IPv6 included, which
  // Railway's networking needs). The local edition defaults to loopback below:
  // single-user mode has no login, so exposing it on a LAN makes everyone "you".
  HOST: z.preprocess(emptyToUndefined, z.string().optional()),
  PGLITE_DATA_DIR: z.preprocess(
    emptyToUndefined,
    z.string().default(process.env.NODE_TEST_CONTEXT ? "memory://" : IS_LOCAL ? "./data/pglite" : "./dev.db"),
  ),
  /**
   * Accounts created at or after this instant default story memory to 16,000
   * instead of carrying their whole context window. Unset = nobody is moved,
   * so the split ships dark and the behaviour change is one env flip that can
   * be reverted without a deploy. An explicit user choice always applies,
   * flag or no flag (packages/shared/src/story-memory.ts).
   */
  STORY_MEMORY_DEFAULT_AT: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * Treat story memory as a RESERVATION rather than a leftover: the lorebook
   * budget becomes what remains after setting it aside, so triggered entries
   * trim to make room instead of the conversation being squeezed out. Only
   * bites when a world is large relative to the plan's window. Off = the
   * budget is the full window, exactly as before.
   */
  LOREBOOK_RESERVES_STORY_MEMORY: z.preprocess(
    (v) => (typeof v === "string" ? ["1", "true", "on"].includes(v.trim().toLowerCase()) : v),
    z.boolean().default(false),
  ),
  BETTER_AUTH_SECRET: z.string().min(1),
  // Key material for encrypting stored BYOK API keys. Unset = derived from
  // BETTER_AUTH_SECRET (the historical behaviour, kept so existing rows keep
  // decrypting). Set it on a fresh install so rotating the auth secret never
  // bricks every stored provider key. Changing it AFTER keys exist invalidates them.
  ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  // Stable, comma-separated HMAC keys for deleted-identity tombstones. Put a
  // new key first and retain old keys while rotating. Falls back to the auth
  // secret for existing deployments, but production should set this explicitly.
  DELETED_IDENTITY_HMAC_SECRETS: z.string().default(""),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  DISCORD_CLIENT_ID: z.string().default(""),
  DISCORD_CLIENT_SECRET: z.string().default(""),
  TWITTER_CLIENT_ID: z.string().default(""),
  TWITTER_CLIENT_SECRET: z.string().default(""),
  // krew.io inside Yumina (docs/superpowers/specs/2026-09-12-krew-yumina-identity-handoff-design.md).
  // KREW_CLIENT_ORIGIN = the origin the /krew page frames (prod: https://play.krew.io).
  // Empty = the /krew page reports "not available" and the token endpoint 404s,
  // so the feature is dark until the env is set — a kill switch without a deploy.
  KREW_CLIENT_ORIGIN: z.string().default(""),
  // Krew's API origin, echoed in the public config for the client's benefit.
  // Yumina never calls it; the frame talks to it directly.
  KREW_API_ORIGIN: z.string().default("https://game.krew.io"),
  // The krew TEST stack's client origin. `/krew?env=test` frames this instead of
  // KREW_CLIENT_ORIGIN so testers sign in through Yumina as usual while the game
  // runs on the hidden test servers. Empty = no test variant.
  KREW_TEST_CLIENT_ORIGIN: z.string().default("https://test.krew.io"),
  // `aud` claim krew checks on the identity token.
  KREW_TOKEN_AUDIENCE: z.string().default("krew.io"),
  APP_URL: z.string().url().default("http://localhost:5173"),
  PORT: z.coerce.number().default(3000),
  // S3-compatible storage (Railway Storage Buckets)
  AWS_S3_BUCKET_NAME: z.string().default(""),
  AWS_ACCESS_KEY_ID: z.string().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().default(""),
  AWS_ENDPOINT_URL: z.string().default("https://t3.storageapi.dev"),
  AWS_DEFAULT_REGION: z.string().default("sjc"),
  // Cloudflare Turnstile (anti-bot)
  TURNSTILE_SECRET_KEY: z.string().default(""),
  // Resend (email) — required in production
  RESEND_API_KEY: process.env.NODE_ENV === "production" && !IS_LOCAL
    ? z.string().min(1, "RESEND_API_KEY is required in production")
    : z.string().default(""),
  // Official Yumina API keys (regular = self-signup users, invite = invite code users)
  YUMINA_OPENROUTER_KEY: z.string().default(""),
  YUMINA_INVITE_OPENROUTER_KEY: z.string().default(""),
  // Stripe
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().default(""),
  // Redis (shared state for multi-replica scaling)
  REDIS_URL: z.string().default(""),
  // Read replica (optional — falls back to DATABASE_URL if not set)
  DATABASE_READ_URL: z.string().default(""),
  // Client-side execution deadline, with connection disposal on timeout.
  // Explicit maintenance work has a separate bounded 5-minute scope.
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
  // Temporary diagnostic capture; zero disables it. Never opens a debug port.
  RUNTIME_CPU_PROFILE_SECONDS: z.coerce.number().int().min(0).max(180).default(0),
  // PostHog analytics
  POSTHOG_API_KEY: z.string().default(""),
  POSTHOG_HOST: z.string().default("https://us.i.posthog.com"),
  // Reddit Ads Conversions API (server-side Purchase/SignUp reporting).
  // Empty token disables sends entirely (dev/local). Pixel id must match the
  // browser pixel in packages/app/index.html so dedupe-by-conversion_id works.
  REDDIT_CAPI_TOKEN: z.string().default(""),
  REDDIT_PIXEL_ID: z.string().default("a2_jeuli9udatr6"),
  // OpenAI — used for content embeddings (Phase 7 reco). Empty string
  // disables embedding generation; existing embeddings still work.
  OPENAI_API_KEY: z.string().default(""),
  // AI media generation (ComfyUI workers). All empty by default — the whole
  // feature is disabled unless a provider is configured.
  // RunPod serverless endpoint(s) running runpod/worker-comfyui (production
  // path). Comma-separated for multi-region failover — the provider health-
  // checks each and submits to the healthiest (e.g. "abc123,def456").
  RUNPOD_API_KEY: z.string().default(""),
  OPENROUTER_IMAGE_API_KEY: z.string().default(""),
  // Fleet limits are deploy-time controls, never values supplied by the client.
  // Raising the ceiling requires provider capacity and load-test evidence.
  OPENROUTER_IMAGE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(5000).default(10),
  // Was capped at 10 and defaulted to 4 because each in-flight response cost
  // roughly five copies of the picture in memory. The reader now decodes as the
  // bytes arrive (lib/generation/image-response.ts), which measured 81MB -> 30MB
  // of peak for a typical 2K image, so eight concurrent now costs less than the
  // old four did. The ceiling is raised well past the new default so this can be
  // tuned from the environment once the container's real memory is known,
  // without another deploy.
  OPENROUTER_IMAGE_LOCAL_CONCURRENT: z.coerce.number().int().min(1).max(64).default(8),
  OPENROUTER_IMAGE_MAX_QUEUED: z.coerce.number().int().min(1).max(50_000).default(100),
  // Daily supplier-cost reservation (USD); isolates image spend from chat.
  OPENROUTER_IMAGE_DAILY_BUDGET_USD: z.coerce.number().positive().default(25),
  RUNPOD_COMFY_ENDPOINT_ID: z.string().default(""),
  // Direct ComfyUI server (http://127.0.0.1:8188) — local development only.
  COMFY_LOCAL_URL: z.string().default(""),
  // Model-volume regions for user LoRA/checkpoint distribution, as
  // "dataCenterId:networkVolumeId" pairs, comma-separated
  // (e.g. "EU-CZ-1:6mf2cryrph,US-IL-1:0g073cgjw6").
  RUNPOD_MODEL_REGIONS: z.string().default(""),
  // Optional stable sync-pod ownership scope. Defaults to the Railway
  // environment ID, or auth origin locally; never share it across databases.
  RUNPOD_SYNC_NAMESPACE: z.string().trim().max(80).default(""),
  // Base64-encoded OpenSSH private key whose public half is injected into
  // sync pods via PUBLIC_KEY (the server drives downloads over SSH).
  RUNPOD_SSH_PRIVATE_KEY: z.string().default(""),
  RUNPOD_SSH_PUBLIC_KEY: z.string().default(""),
  // Optional Civitai API token for downloading gated models.
  CIVITAI_API_TOKEN: z.string().default(""),
  // Platform daily reset clock — ONE universal boundary for ALL users.
  // Check-in AND daily-supply recovery both reset at 04:00 in this IANA
  // zone. Asia/Shanghai = UTC+8 with no DST, so the boundary is a fixed
  // 20:00 UTC every day. ~86% of users are already UTC+8 (Shanghai/Taipei/
  // Hong Kong), so 04:00 Beijing IS their local 4 AM. Non-UTC+8 users reset
  // at their local midday — an accepted tradeoff for a single global clock.
  // Must match 'Asia/Shanghai' hardcoded in scripts/install-daily-recovery-fn.sql.
  YUMINA_CHECKIN_TIME_ZONE: z.string().default("Asia/Shanghai"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const IS_DEV = process.env.NODE_ENV !== "production";

/** "hosted" (yumina.io) or "local" (open-source self-hosted build). */
export const EDITION = env.YUMINA_EDITION;
export const IS_LOCAL_EDITION = EDITION === "local";
/** Effective auth mode: local edition defaults to a single auto-signed-in account. */
export const AUTH_MODE: "single-user" | "multi-user" =
  env.YUMINA_AUTH_MODE ?? (IS_LOCAL_EDITION ? "single-user" : "multi-user");
/** Where on-disk assets live when S3 is not configured. */
export const STORAGE_DIR = env.YUMINA_STORAGE_DIR ?? `${env.YUMINA_DATA_DIR.replace(/[\/]+$/, "")}/assets`;
/** Bind address for the HTTP server; undefined keeps Node's dual-stack default. */
export const BIND_HOST: string | undefined = env.HOST ?? (IS_LOCAL_EDITION ? "127.0.0.1" : undefined);
/** Canonical public origin (no trailing slash). */
export const PUBLIC_ORIGIN = (env.PUBLIC_ORIGIN ?? env.BETTER_AUTH_URL).replace(/\/+$/, "");
