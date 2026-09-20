import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
  integer,
  bigserial,
  bigint,
  real,
  numeric,
  jsonb,
  unique,
  uniqueIndex,
  primaryKey,
  index,
  check,
  foreignKey,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  ApiKeyMetadata,
  SessionMemory,
  SessionMemoryStatus,
  SessionSummaryImplementation,
  SessionSummaryLanguage,
  SessionSummaryMode,
  SessionSummaryStatus,
  SocialEventRulesConfig,
  SocialPlatformSettlement,
} from "@yumina/shared";
import type { ToolCall } from "../lib/llm/types.js";

// ─── Better Auth tables ─────────────────────────────────────────────

// Anonymous game visitors stay outside Better Auth. A verified login can link
// a guest to one account for analytics; this never merges saved game progress.
export const gameGuestLinks = pgTable("game_guest_links", {
  guestId: text("guest_id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("game_guest_links_user_idx").on(t.userId)]);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  banner: text("banner"),
  bio: text("bio"),
  location: text("location"),
  website: text("website"),
  username: text("username").unique(),
  displayUsername: text("display_username"),
  birthYear: integer("birth_year"),
  featuredWorldId: text("featured_world_id"),
  // Platform achievement the user chose to showcase (its title + badge replace
  // the "Creator" label / Award icon on the profile). FK to platform_achievements
  // is added via db:push / self-heal (ON DELETE SET NULL).
  showcasedAchievementId: text("showcased_achievement_id"),
  preferences: jsonb("preferences").$type<Record<string, unknown>>().default({}),
  role: text("role").notNull().default("user"),
  isBanned: boolean("is_banned").notNull().default(false),
  isSuspended: boolean("is_suspended").notNull().default(false),
  // Trusted creator: an admin can flip this so this user's card first-publishes
  // and edits auto-approve instead of entering the human review queue. Bundles
  // and content-safety/structural gates are NOT bypassed; ban always wins.
  // Future-only — flipping never bulk-publishes a backlog already in the queue.
  // PROD/DEV must be db:push-ed (self-heal is PGlite-only) BEFORE code reads it.
  skipReview: boolean("skip_review").notNull().default(false),
  // Promotion partner (blogger/KOL): unlocks the detailed referral analytics
  // panel on their own invite page. Admin-toggled, no self-serve path.
  // PROD/DEV DDL applied by hand 2026-07-27 before this code shipped.
  isPartner: boolean("is_partner").notNull().default(false),
  // DEPRECATED: legacy field, no longer written. Source of truth for plan is
  // creditWallets.plan. Drop this column in a future migration once we verify
  // no external integrations read it.
  tier: text("tier").notNull().default("regular"),
  referralCode: text("referral_code").unique(),
  referredBy: text("referred_by").references((): AnyPgColumn => user.id, { onDelete: "set null" }),
  // When this user was referred (referral code redeemed). Powers the RESETTABLE
  // reward ladder: only referrals with referred_at >= REFERRAL_REWARD_EPOCH count
  // toward wallet rewards. NULL = pre-epoch (legacy) — those still count toward
  // the all-time 引路人 achievement/title, just not the reward ladder.
  referredAt: timestamp("referred_at"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  inviteCodeId: text("invite_code_id"),
  lifetimePlaytimeSeconds: integer("lifetime_playtime_seconds").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Durable increments awaiting the batched lifetime-counter update. */
export const playtimeLifetimePending = pgTable("playtime_lifetime_pending", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  seconds: integer("seconds").notNull(),
}, (t) => [check("playtime_lifetime_pending_seconds_check", sql`${t.seconds} > 0`)]);

export const gameNpcDaveMemory = pgTable('game_npc_dave_memory', {
  userId:text('user_id').primaryKey().references(()=>user.id,{onDelete:'cascade'}),
  revision:integer('revision').notNull().default(0),
  data:jsonb('data').notNull().$type<Record<string,unknown>>(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[check('dave_memory_size',sql`octet_length(${t.data}::text) <= 65536`)]);

export const gameNpcCampaignMemory = pgTable('game_npc_campaign_memory', {
  userId:text('user_id').notNull().references(()=>user.id,{onDelete:'cascade'}),
  campaignId:uuid('campaign_id').notNull(),
  revision:integer('revision').notNull().default(0),
  data:jsonb('data').notNull().$type<Record<string,unknown>>(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[primaryKey({columns:[t.userId,t.campaignId]}),check('campaign_memory_size',sql`octet_length(${t.data}::text) <= 65536`)]);

export const userMutes = pgTable("user_mutes", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  adminId: text("admin_id").references(() => user.id, { onDelete: "set null" }),
  reason: text("reason").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [index("user_mutes_expires_idx").on(t.expiresAt)]);

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
}, (t) => [
  index("session_user_id_idx").on(t.userId),
]);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("account_user_id_idx").on(t.userId),
  // Better Auth's OAuth sign-in lookup (`WHERE account_id = ? AND provider_id = ?`).
  index("account_provider_account_idx").on(t.providerId, t.accountId),
]);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Better Auth `jwt` plugin key store (RS256 pair, private half encrypted with
// BETTER_AUTH_SECRET). Public keys are served at /api/auth/jwks; partner games
// (krew.io) verify the identity tokens minted by routes/partners.ts against it.
// DDL applied by hand (dev 2026-09-12); ensureJwksTable() is the boot fallback.
export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
});

// Privacy-preserving anti-abuse record. The identity is an HMAC of normalized
// email (never raw PII), retained after account deletion to preserve bans,
// invite-code redemption history, the three-day repeat-deletion cooling-off
// period, and same-day check-in history. The
// block_welcome_rewards column is legacy compatibility data; recreated
// accounts now receive the normal new-account wallet defaults.
export const deletedAccountTombstones = pgTable("deleted_account_tombstones", {
  identityHash: text("identity_hash").primaryKey(),
  wasBanned: boolean("was_banned").notNull().default(false),
  blockWelcomeRewards: boolean("block_welcome_rewards").notNull().default(true),
  blockInviteRedemption: boolean("block_invite_redemption").notNull().default(true),
  lastCheckinDay: text("last_checkin_day"),
  rewardBlockedUntil: timestamp("reward_blocked_until"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Durable outbox for external cleanup that cannot participate in the user
// deletion transaction (S3, Redis, Stripe). Rows are removed after every
// idempotent cleanup step succeeds.
export const accountDeletionCleanupJobs = pgTable("account_deletion_cleanup_jobs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  deletedUserId: text("deleted_user_id").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripeConnectId: text("stripe_connect_id"),
  stripePaymentIntentIds: jsonb("stripe_payment_intent_ids").$type<string[]>().notNull().default([]),
  stripeCheckoutSessionIds: jsonb("stripe_checkout_session_ids").$type<string[]>().notNull().default([]),
  assetKeys: jsonb("asset_keys").$type<string[]>().notNull().default([]),
  assetPrefixes: jsonb("asset_prefixes").$type<string[]>().notNull().default([]),
  sessionTokens: jsonb("session_tokens").$type<string[]>().notNull().default([]),
  verificationIdentifiers: jsonb("verification_identifiers").$type<string[]>().notNull().default([]),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  finalizeAfter: timestamp("finalize_after").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("account_deletion_cleanup_jobs_next_idx").on(t.nextAttemptAt)]);

// ─── Application tables ─────────────────────────────────────────────

export const worlds = pgTable("worlds", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  creatorId: text("creator_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").default(""),
  extendedDescription: text("extended_description"),
  schema: jsonb("schema").notNull().$type<Record<string, unknown>>().default({}),
  thumbnailUrl: text("thumbnail_url"),
  isPublished: boolean("is_published").default(false),
  status: text("status").notNull().default("draft"),
  isNsfw: boolean("is_nsfw").default(false),
  allowEdit: boolean("allow_edit").default(true),
  // Governs custom APIs (BYOK) independently of allowEdit (forking). When false,
  // non-creators are forced onto official keys so the hidden lorebook can't leak
  // via a player's BYOK provider logs. See messages.ts / completions.ts gates.
  allowCustomApi: boolean("allow_custom_api").notNull().default(true),
  allowReviews: boolean("allow_reviews").notNull().default(true),
  // When false, players cannot share their playthroughs of this world to its
  // hub page (mirrors allowReviews — author opt-out for a per-card UGC type).
  allowSessionSharing: boolean("allow_session_sharing").notNull().default(true),
  allowCommunityCitations: boolean("allow_community_citations").notNull().default(true),
  // Creator-controlled cover-thumbnail blur, decoupled from age rating.
  // Nullable on purpose: null = "follow age rating" (legacy/auto — sensitive
  // covers blur, all-ages don't); true/false = explicit creator choice.
  // Read with the `coverShouldBlur()` fallback, never as a raw boolean.
  blurCover: boolean("blur_cover"),
  ageRating: text("age_rating").notNull().default("all"),
  targetAudience: text("target_audience").notNull().default("all"),
  visibility: text("visibility").notNull().default("public"),
  downloadCount: integer("download_count").notNull().default(0),
  messageCount: integer("message_count").notNull().default(0),
  favoriteCount: integer("favorite_count").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  averageRating: real("average_rating").notNull().default(0),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  galleryImages: jsonb("gallery_images").$type<string[]>().default([]),
  announcement: text("announcement"),
  totalTokens: integer("total_tokens").default(0),
  approxTime: text("approx_time"),
  sourceWorldId: text("source_world_id"),
  // ── Derived from `schema` by the worlds_schema_derived_trg DB trigger ──
  // Browse paths MUST read these instead of schema->'…' expressions: any
  // jsonb extraction detoasts the multi-MB schema blob per row (measured
  // 0.6ms → 460ms over the published set, the Discover-feed 2.2s root cause).
  // Trigger-maintained (not app-maintained) so Studio agent writes, version
  // rollbacks, and ad-hoc admin scripts can never let them drift. Install SQL
  // lives in ensureWorldsSchemaDerived() (db/index.ts); applied to dev+prod
  // 2026-06-10 with full backfill.
  customUiLoc: integer("custom_ui_loc"),
  hasAudio: boolean("has_audio"),
  // schema->game->>path: set = this card opens a first-party game page instead of the chat
  // renderer. Derived so the play flow can branch on it without ever touching the blob.
  gamePath: text("game_path"),
  coverCrop: jsonb("cover_crop"),
  galleryCoverCrop: jsonb("gallery_cover_crop"),
  moderationNote: text("moderation_note"),
  moderationAction: text("moderation_action"),
  reviewStatus: text("review_status"),
  submittedForReviewAt: timestamp("submitted_for_review_at"),
  reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at"),
  // First time this world went public (set once, in the publish chokepoint).
  // Used by achievement logic (十年磨一剑 / 开荒者 / 常青世界 / 我再改最后一次).
  publishedAt: timestamp("published_at"),
  rejectionReason: text("rejection_reason"),
  rejectionDetail: text("rejection_detail"),
  language: text("language"),
  languageGroupId: text("language_group_id"),
  variantLabel: text("variant_label"),
  // 主/副 flag: is this the primary variant for its (language_group, language)?
  // The hub shows only the primary per language; non-primary same-language
  // variants ("副") stay playable via the version picker but don't occupy a
  // hub slot. Ungrouped cards are trivially primary (default true).
  // NOTE: the "exactly one primary per (group, language)" partial unique index
  // (worlds_primary_variant_uniq) is intentionally NOT declared here — the
  // column defaults to true so every existing same-language sibling is true
  // right after the column is added. The index is created by the migration
  // script (_migrate_primary.mjs) AFTER the backfill demotes duplicates,
  // otherwise index creation fails on existing duplicate primaries.
  isPrimaryVariant: boolean("is_primary_variant").notNull().default(true),
  // DEPRECATED (2026-06-01): Hub Translation cover-only translations. No longer
  // read or written; superseded by per-language variants. Column kept nullable
  // for safe rollback; values nulled by migration. Remove in a later pass.
  multilanguageOverview: jsonb("multilanguage_overview").$type<Record<string, { name: string; description: string; announcement: string | null; thumbnailUrl: string | null; galleryImages: string[]; tags: string[] }>>(),
  // Phase 2 FTS column. Stored as `tsvector` in Postgres (populated by a
  // BEFORE INSERT/UPDATE trigger defined in migration 0022). Drizzle has
  // no native tsvector support, so we model it as text — which is fine
  // because application code never reads or writes this column directly;
  // only raw SQL in recommendations.ts references it for @@ and ts_rank.
  searchDoc: text("search_doc"),
  // Phase 2.5 mirror of search_doc holding the OpenCC-simplified form of
  // name + description + extendedDescription. Unlike search_doc, this is
  // NOT trigger-maintained — OpenCC runs in the app layer, so writes
  // that touch any of the three source fields must also recompute this
  // column. See normalize-search.ts + worlds.ts handlers.
  searchDocNormalized: text("search_doc_normalized"),
  // Phase 7 content embedding: 1536-dim vector from OpenAI
  // text-embedding-3-small over (name + description + tags + first_message
  // snippet + author_note). Drives the `similar_played` recall route and
  // the `vectorScore` term in scoreRecommendationBase. NULL until the
  // backfill / on-publish hook fills it in. Indexed with HNSW for cosine
  // distance — see migration 0027.
  embedding: vector("embedding", { dimensions: 1536 }),
  embeddingUpdatedAt: timestamp("embedding_updated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("worlds_creator_id_idx").on(t.creatorId),
  index("worlds_status_idx").on(t.status),
  index("worlds_language_group_id_idx").on(t.languageGroupId),
  index("worlds_review_status_idx").on(t.reviewStatus, t.submittedForReviewAt),
  // Hard backstop for MAX_WORLD_TAGS (@yumina/shared). The app clamps tags on
  // every write path, but this guards against raw inserts / seed scripts /
  // future tools that skip it — no row can ever carry more than 50 tags.
  // (Keep in sync with MAX_WORLD_TAGS + ensureWorldTagsConstraint in db/index.ts.)
  check("worlds_tags_max", sql`jsonb_array_length(${t.tags}) <= 50`),
  // Settings and discovery must agree, including imports and raw SQL writes.
  check("worlds_audience_consistent_v2", sql`
    ${t.targetAudience} IN ('all', 'male', 'female')
    AND (${t.tags} @> '["男性向"]'::jsonb AND NOT ${t.tags} @> '["女性向"]'::jsonb) = (${t.targetAudience} = 'male')
    AND (${t.tags} @> '["女性向"]'::jsonb AND NOT ${t.tags} @> '["男性向"]'::jsonb) = (${t.targetAudience} = 'female')
  `),
]);

export const playSessions = pgTable("play_sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  sessionPersona: jsonb("session_persona").$type<import("../lib/session-persona.js").SessionPersona>(),
  /** Explicit opt-in. Historical session_persona snapshots stay unlocked. */
  personaLocked: boolean("persona_locked").notNull().default(false),
  state: jsonb("state").notNull().$type<Record<string, unknown>>().default({}),
  stateGuardEnabled: boolean("state_guard_enabled").notNull().default(true),
  stateGuardModel: text("state_guard_model"),
  /** Structured summary of compacted (older) messages */
  summary: text("summary"),
  summaryUpdatedAt: timestamp("summary_updated_at"),
  summaryModel: text("summary_model"),
  summaryImplementation: text("summary_implementation").$type<SessionSummaryImplementation>().notNull().default("localdev"),
  summaryMode: text("summary_mode").$type<SessionSummaryMode>().notNull().default("threshold"),
  summaryIncluded: boolean("summary_included").notNull().default(true),
  summaryTriggerTokens: integer("summary_trigger_tokens"),
  // Output language for ALL THREE summarizers (session memory, story summary,
  // layered snippets) — null / "auto" means "write in the story's own
  // language". Before this column the prompts had no language directive and
  // small updater models summarized Chinese stories into English, which
  // translated character names and drifted a little more on every round trip.
  summaryLanguage: text("summary_language").$type<SessionSummaryLanguage>(),
  summaryRecentTailTokens: integer("summary_recent_tail_tokens"),
  summaryStatus: text("summary_status").$type<SessionSummaryStatus>().notNull().default("idle"),
  summaryError: text("summary_error"),
  summarySourceHash: text("summary_source_hash"),
  summaryCoversUntilMessageId: text("summary_covers_until_message_id"),
  summaryTokenCount: integer("summary_token_count"),
  // Cross-replica compaction claim: set when a background story-compaction job
  // takes ownership of this session, cleared on persist/fail. A second replica
  // seeing a fresh claim skips its own run instead of clobbering the hash.
  summaryClaimedAt: timestamp("summary_claimed_at"),
  // A successful user-requested recovery starts a fresh soft-budget window.
  // Per-job attempt limits bound work independently of this soft window.
  summaryBudgetWindowStartedAt: timestamp("summary_budget_window_started_at"),
  // One-shot permission for the next automatic compaction to probe recovery.
  // It is consumed atomically when that job claims the session.
  summaryBudgetResumePending: boolean("summary_budget_resume_pending").notNull().default(false),
  summaryceptionModel: text("summaryception_model"),
  summaryceptionStatus: text("summaryception_status").$type<SessionSummaryStatus>().notNull().default("idle"),
  summaryceptionError: text("summaryception_error"),
  summaryceptionUpdatedAt: timestamp("summaryception_updated_at"),
  summaryceptionSourceHash: text("summaryception_source_hash"),
  summaryceptionCoversUntilMessageId: text("summaryception_covers_until_message_id"),
  summaryceptionTokenCount: integer("summaryception_token_count"),
  summaryceptionIncluded: boolean("summaryception_included").notNull().default(false),
  /** User-visible structured continuity memory for this specific play session. */
  sessionMemory: jsonb("session_memory").$type<SessionMemory>(),
  sessionMemoryUpdatedAt: timestamp("session_memory_updated_at"),
  sessionMemoryModel: text("session_memory_model"),
  sessionMemoryIncluded: boolean("session_memory_included").notNull().default(true),
  sessionMemoryStatus: text("session_memory_status").$type<SessionMemoryStatus>().notNull().default("idle"),
  sessionMemoryError: text("session_memory_error"),
  sessionMemorySourceHash: text("session_memory_source_hash"),
  /** Cross-replica lease; the processed pointer advances only on successful save. */
  sessionMemoryClaimedAt: timestamp("session_memory_claimed_at"),
  sessionMemoryProcessedMessageId: text("session_memory_processed_message_id"),
  // Consecutive background-update failures. Incremented on failure, reset on
  // success / manual regenerate; ≥3 stops per-turn auto-retries so a
  // persistently-broken config can't burn an LLM call every turn forever.
  sessionMemoryRetryCount: integer("session_memory_retry_count").notNull().default(0),
  // Set when the player edits/deletes a message OLDER than the lag-one window
  // while memory exists — the memory may still describe the pre-edit content
  // (edits deliberately never wipe it; see extensions/session-memory/hooks.ts).
  // While set, the memory prompt block carries an explicit obsolete-content
  // warning. Cleared by full rebuild, manual save, or clear — NOT by
  // incremental updates (they never see the edited message).
  sessionMemoryStaleAt: timestamp("session_memory_stale_at"),
  // Player-pinned notes: written by the player, never rewritten by the memory
  // updater, injected with the memory every turn. Deliberately NOT part of the
  // auto-memory reset sets (revert/restart/checkpoint/clear leave it alone) —
  // it is the player's own text, and the whole point is that nothing automatic
  // ever takes it away (hhltwz request, 2026-09-05).
  sessionMemoryPinned: text("session_memory_pinned"),
  /** User-assigned session name (null = unnamed) */
  name: text("name"),
  // ── Playtime tracking (lease-based active tab tracking) ──
  playtimeSeconds: integer("playtime_seconds").notNull().default(0),
  playtimeLeaseId: text("playtime_lease_id"),
  playtimeLastSeenAt: timestamp("playtime_last_seen_at"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  // ── Session branching ──
  parentSessionId: text("parent_session_id").references((): any => playSessions.id, { onDelete: "set null" }),
  branchedFromMessageId: text("branched_from_message_id"),
  // ── Studio playtest ephemeral sessions ──
  // Marked true for sessions created by the studio playtest panel. Playtest
  // unified on the real-play pipeline uses this flag to hide these rows from
  // the user's session list and to target them for the daily cleanup cron.
  // Unifying playtest on the real pipeline eliminates the BGM / persona /
  // audio-effect drift that used to come from the separate playtest endpoint.
  ephemeral: boolean("ephemeral").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("play_sessions_user_id_idx").on(t.userId),
  index("play_sessions_world_id_idx").on(t.worldId),
  index("play_sessions_user_world_idx").on(t.userId, t.worldId),
  index("play_sessions_parent_id_idx").on(t.parentSessionId),
  index("play_sessions_created_at_idx").on(t.createdAt),
  index("play_sessions_world_created_idx").on(t.worldId, t.createdAt),
  index("play_sessions_ephemeral_cleanup_idx").on(t.ephemeral, t.updatedAt),
]);

export const userLibrary = pgTable(
  "user_library",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    lastPlayedAt: timestamp("last_played_at"),
    lastSeenUpdateAt: timestamp("last_seen_update_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.userId, t.worldId),
    index("user_library_user_id_idx").on(t.userId),
  ]
);

export const messages = pgTable("messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id")
    .notNull()
    .references(() => playSessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  status: text("status", { enum: ["complete", "streaming", "failed"] })
    .notNull()
    .default("complete"),
  errorMessage: text("error_message"),
  stateChanges: jsonb("state_changes").$type<Record<string, unknown>>(),
  stateValidation: jsonb("state_validation").$type<import("@yumina/shared").StateValidationAudit>(),
  swipes: jsonb("swipes")
    .$type<
      Array<{
        content: string;
        /** Full pre-parse LLM output. Persisted starting 2026-05; older
         *  swipes leave this undefined and the UI hides the "view raw"
         *  toggle when it equals `content`. */
        rawContent?: string;
        stateValidation?: import("@yumina/shared").StateValidationAudit;
        stateChanges?: Record<string, unknown>;
        stateSnapshot?: Record<string, unknown>;
        /** State before this reply, for replacement rather than cumulative regeneration. */
        generationState?: Record<string, unknown>;
        createdAt: string;
        model?: string;
        modelFallback?: import("@yumina/shared").ModelFallbackRecord;
        tokenCount?: number;
        creditCost?: number;
        creditBalanceAfter?: number;
      }>
    >()
    .default([]),
  activeSwipeIndex: integer("active_swipe_index").default(0),
  // Maintained by a DB trigger (messages_set_swipe_count, see
  // ensureMessagesSwipeCount in db/index.ts) = jsonb_array_length(swipes). Never
  // set from app code. Lets the regen achievement metrics aggregate an int
  // instead of detoasting the swipes jsonb per row. Nullable until backfilled;
  // the metric query COALESCEs to a jsonb fallback so it's correct meanwhile.
  swipeCount: integer("swipe_count"),
    model: text("model"),
    tokenCount: integer("token_count"),
    generationTimeMs: integer("generation_time_ms"),
    compacted: boolean("compacted").notNull().default(false),
    summaryceptionCompacted: boolean("summaryception_compacted").notNull().default(false),
    stateSnapshot: jsonb("state_snapshot").$type<Record<string, unknown>>(),
  attachments: jsonb("attachments").$type<Array<{ type: string; mimeType: string; name: string; url: string }>>(),
  // Maintained by a DB trigger (messages_content_metrics, see
  // scripts/add-message-content-metrics.sql) = character count and CJK-range
  // character count of `content`. Never set from app code. Lets the memory
  // panel total the whole backlog's tokens from integers instead of loading
  // every message BODY — the unbounded body load blocked the event loop for
  // 20-46s and 502'd the whole site on 2026-08-15. Nullable until backfilled;
  // readers COALESCE to an on-the-fly computation so they stay correct meanwhile.
  contentLen: integer("content_len"),
  contentCjkLen: integer("content_cjk_len"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("messages_session_id_idx").on(t.sessionId),
  index("messages_session_created_idx").on(t.sessionId, t.createdAt),
  index("messages_session_compacted_idx").on(t.sessionId, t.compacted),
  index("messages_session_summaryception_compacted_idx").on(t.sessionId, t.summaryceptionCompacted),
]);

export const assets = pgTable("assets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["image", "audio", "font", "txt", "other"] }).notNull(),
  filename: text("filename").notNull(),
  url: text("url").notNull(),
  sizeBytes: integer("size_bytes"),
  mimeType: text("mime_type"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("assets_world_id_idx").on(t.worldId),
]);

export const worldMemories = pgTable("world_memories", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  category: text("category", {
    enum: ["event", "relationship", "fact", "decision", "item", "location", "agreement", "world_state"],
  }).notNull(),
  importance: integer("importance").notNull().default(5),
  sessionId: text("session_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("world_memories_world_user_idx").on(t.worldId, t.userId),
]);

export const checkpoints = pgTable("checkpoints", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id")
    .notNull()
    .references(() => playSessions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  messages: jsonb("messages").$type<Array<Record<string, unknown>>>().notNull(),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  summary: text("summary"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("checkpoints_session_id_idx").on(t.sessionId),
]);

// ─── Shared playthroughs ────────────────────────────────────────────
// A player can publish an immutable snapshot of one of their play sessions
// to the world's hub page. Other players read it back as a read-only replay.
// The snapshot shape mirrors `checkpoints` (messages + state JSONB); the engagement /
// public-UGC fields (likeCount, hiddenByCreatorAt, status) mirror bundles +
// reviews. Snapshots are self-contained: deleting the source session or
// editing it later does not affect an already-shared playthrough.
export const sharedPlaythroughs = pgTable("shared_playthroughs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  sharerUserId: text("sharer_user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // Informational only — the snapshot is self-contained. No FK so the source
  // session can be deleted without touching the share.
  sourceSessionId: text("source_session_id"),
  title: text("title").notNull(),
  note: text("note"),
  // ── Immutable snapshot (checkpoints pattern) ──
  messages: jsonb("messages").$type<Array<Record<string, unknown>>>().notNull(),
  finalState: jsonb("final_state").$type<Record<string, unknown>>().notNull(),
  summary: text("summary"),
  // Session-scoped world memories captured at share time, replayed onto the
  // reader's new session when they continue (mirrors branchSession).
  sessionMemories: jsonb("session_memories").$type<Array<Record<string, unknown>>>().default([]),
  messageCount: integer("message_count").notNull().default(0),
  // Snapshot of the card's rating at share time — drives content-level gating.
  ageRating: text("age_rating").notNull().default("all"),
  // "public"  → listed on the card's hub page (card/library share).
  // "unlisted" → private, NOT listed anywhere; only reachable by id via the DM
  //              share card it was sent in (friend-only). Never surfaces on
  //              Discover and ignores the author's public sharing opt-out.
  visibility: text("visibility").notNull().default("public"),
  // active | removed (admin moderation)
  status: text("status").notNull().default("active"),
  // Card author soft-hide (reviews pattern): hides from the list but the
  // sharer can still see their own.
  hiddenByCreatorAt: timestamp("hidden_by_creator_at"),
  likeCount: integer("like_count").notNull().default(0),
  // Times another player forked this into their own account (≈ downloadCount).
  continueCount: integer("continue_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("shared_playthroughs_world_id_idx").on(t.worldId),
  index("shared_playthroughs_sharer_id_idx").on(t.sharerUserId),
  index("shared_playthroughs_world_created_idx").on(t.worldId, t.createdAt),
]);

export const sharedPlaythroughLikes = pgTable("shared_playthrough_likes", {
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  playthroughId: text("playthrough_id")
    .notNull()
    .references(() => sharedPlaythroughs.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  unique("shared_playthrough_likes_uniq").on(t.userId, t.playthroughId),
  index("shared_playthrough_likes_pt_id_idx").on(t.playthroughId),
  index("shared_playthrough_likes_user_id_idx").on(t.userId),
]);

export const promptFolders = pgTable("prompt_folders", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("prompt_folders_user_id_idx").on(t.userId),
]);

export const summaryceptionSnippets = pgTable("summaryception_snippets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  sessionId: text("session_id")
    .notNull()
    .references(() => playSessions.id, { onDelete: "cascade" }),
  layerIndex: integer("layer_index").notNull().default(0),
  snippetOrder: integer("snippet_order").notNull().default(0),
  text: text("text").notNull(),
  sourceStartMessageId: text("source_start_message_id"),
  sourceEndMessageId: text("source_end_message_id"),
  sourceStartOrdinal: integer("source_start_ordinal"),
  sourceEndOrdinal: integer("source_end_ordinal"),
  sourceHash: text("source_hash"),
  fromLayer: integer("from_layer"),
  mergedCount: integer("merged_count"),
  promoted: boolean("promoted").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("summaryception_snippets_session_layer_idx").on(t.sessionId, t.layerIndex, t.snippetOrder),
  index("summaryception_snippets_session_idx").on(t.sessionId),
]);

export const userPrompts = pgTable("user_prompts", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  folderId: text("folder_id").references(() => promptFolders.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  content: text("content").notNull().default(""),
  section: text("section", {
    enum: ["system-presets", "chat-history", "post-history"],
  }).notNull().default("system-presets"),
  enabled: boolean("enabled").notNull().default(true),
  depth: integer("depth"),
  position: real("position"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  // Loaded on every message turn (`WHERE user_id = ?`); scanned 4.4M times unindexed.
  index("user_prompts_user_id_idx").on(t.userId),
]);

export const userPresetOverrides = pgTable("user_preset_overrides", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  presetId: text("preset_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  content: text("content"),
  apiRole: text("api_role", {
    enum: ["system", "user", "assistant"],
  }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  unique().on(table.userId, table.presetId),
]);

// ─── Global Asset tables ────────────────────────────────────────────

export const assetFolders = pgTable("asset_folders", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  parentFolderId: text("parent_folder_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("asset_folders_user_id_idx").on(t.userId),
]);

export const userAssets = pgTable("user_assets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["image", "video", "audio", "font", "txt", "other"] }).notNull(),
  filename: text("filename").notNull(),
  url: text("url").notNull(),
  sizeBytes: integer("size_bytes"),
  mimeType: text("mime_type"),
  folderId: text("folder_id").references(() => assetFolders.id, { onDelete: "set null" }),
  sourceAssetId: text("source_asset_id"),
  isPublic: boolean("is_public").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("user_assets_user_id_idx").on(t.userId),
]);

export const assetReferences = pgTable("asset_references", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  assetId: text("asset_id")
    .notNull()
    .references(() => userAssets.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
});

// Binds a user's asset folder to one of their worlds. Purely an organizational
// convenience for the editor (surface "this card's folders" first) — it does NOT
// affect publishing/packaging, which still walks @asset refs via scan-world-assets.
export const worldFolderBindings = pgTable("world_folder_bindings", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  folderId: text("folder_id")
    .notNull()
    .references(() => assetFolders.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  unique("world_folder_bindings_world_folder_uq").on(t.worldId, t.folderId),
  index("world_folder_bindings_world_id_idx").on(t.worldId),
  index("world_folder_bindings_folder_id_idx").on(t.folderId),
]);

// ─── AI media generation jobs ───────────────────────────────────────
// One row per creator-initiated ComfyUI generation (image/video). Mushies are
// pre-deducted on submit (credit_transactions.referenceId = job id) and
// refunded on failure. Successful results land in user_assets (assetId).
export const generationProviderSpend = pgTable("generation_provider_spend", {
  jobId: text("job_id").primaryKey(),
  reservedUsd: real("reserved_usd").notNull(),
  actualUsd: real("actual_usd"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [index("generation_provider_spend_created_idx").on(t.createdAt)]);

export const generationJobs = pgTable("generation_jobs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["image", "video"] }).notNull(),
  templateId: text("template_id").notNull(),
  params: jsonb("params").$type<Record<string, unknown>>().notNull(),
  status: text("status", {
    enum: ["queued", "running", "succeeded", "failed", "cancelled"],
  })
    .notNull()
    .default("queued"),
  provider: text("provider"),
  providerJobId: text("provider_job_id"),
  costMushies: real("cost_mushies").notNull().default(0),
  refunded: boolean("refunded").notNull().default(false),
  // Persist the charge source and refund obligation with the job, so retries
  // preserve purchased credits and do not guess how much a cancellation owed.
  addonDebited: real("addon_debited"),
  refundAmount: real("refund_amount"),
  deliveredAt: timestamp("delivered_at"),
  landingToken: text("landing_token"),
  landingStartedAt: timestamp("landing_started_at"),
  requestKey: text("request_key"),
  dispatchStartedAt: timestamp("dispatch_started_at"),
  providerCostUsd: real("provider_cost_usd"),
  assetId: text("asset_id").references(() => userAssets.id, { onDelete: "set null" }),
  // All delivered outputs of a batch, in worker order (assetId stays = first
  // for anything that predates multi-output batches).
  assetIds: jsonb("asset_ids").$type<string[]>(),
  folderId: text("folder_id").references(() => assetFolders.id, { onDelete: "set null" }),
  // Per-job secret carried in the provider webhook URL; callback is rejected
  // unless it matches, so the public endpoint can't be spoofed.
  webhookToken: text("webhook_token"),
  errorMessage: text("error_message"),
  // Stable machine-readable failure reason (GenerationErrorCode) — the client
  // localizes this; error_message is the raw diagnostic.
  errorCode: text("error_code"),
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (t) => [
  index("generation_jobs_user_created_idx").on(t.userId, t.createdAt),
  index("generation_jobs_status_idx").on(t.status),
  index("generation_jobs_user_status_idx").on(t.userId, t.status),
  uniqueIndex("generation_jobs_user_request_idx").on(t.userId, t.requestKey)
    .where(sql`${t.requestKey} IS NOT NULL`),
  index("generation_jobs_provider_status_created_idx").on(t.provider, t.status, t.createdAt),
  index("generation_jobs_pending_refund_idx").on(t.createdAt)
    .where(sql`${t.refunded} = false AND ${t.refundAmount} > 0`),
  index("generation_jobs_cloud_dispatch_pending_idx").on(t.dispatchStartedAt)
    .where(sql`${t.provider} = 'openrouter' AND ${t.status} = 'running'`),
  index("generation_jobs_refund_pending_idx").on(t.createdAt)
    .where(sql`${t.refunded} = false AND ${t.costMushies} > 0
      AND (${t.refundAmount} > 0 OR (${t.refundAmount} IS NULL AND ${t.status} IN ('failed', 'cancelled')))`),
]);

// ─── User generation models (advanced mode) ─────────────────────────
// A creator-owned LoRA or checkpoint, imported from their asset library or
// Civitai, distributed to every region's model volume by the sync sweeper.
// userId null = platform-curated model visible to everyone.
export const generationModels = pgTable("generation_models", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  assetId: text("asset_id").references(() => userAssets.id, { onDelete: "set null" }),
  kind: text("kind", { enum: ["lora", "checkpoint"] }).notNull(),
  name: text("name").notNull(),
  // Worker-side filename (gm_<id>.safetensors) — what workflows reference.
  filename: text("filename").notNull(),
  s3Key: text("s3_key").notNull(),
  sha256: text("sha256"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  baseFamily: text("base_family").notNull().default("sdxl"),
  triggerWords: text("trigger_words"),
  source: text("source", { enum: ["library", "civitai", "platform"] })
    .notNull()
    .default("library"),
  civitaiId: text("civitai_id"),
  status: text("status", { enum: ["syncing", "ready", "failed"] })
    .notNull()
    .default("syncing"),
  // Region ids (e.g. "EU-CZ-1") whose volume has the file. Usable as soon as
  // the first region reports; the rest fill in for redundancy.
  syncedRegions: jsonb("synced_regions").$type<string[]>().notNull().default([]),
  // Per-region attempt counter — a region that keeps failing is given up on
  // instead of respawning a rented pod every sweep, forever.
  syncAttempts: jsonb("sync_attempts").$type<Record<string, number>>().notNull().default({}),
  errorMessage: text("error_message"),
  // ── Community sharing (opt-in) ────────────────────────────────────
  // A shared model stays owned by its uploader but becomes usable by anyone.
  // The file is already on every worker volume, so adopting one costs nothing
  // and takes no time — and it stops counting against the uploader's quota,
  // since they're now carrying it for the platform.
  isPublic: boolean("is_public").notNull().default(false),
  publishedAt: timestamp("published_at"),
  description: text("description"),
  category: text("category"),
  /** Example image (a user_assets id) shown on the community card. */
  previewAssetId: text("preview_asset_id"),
  /** Set when an admin pulls a shared model after a report. */
  takedownReason: text("takedown_reason"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("generation_models_user_idx").on(t.userId),
  index("generation_models_status_idx").on(t.status),
  index("generation_models_public_idx").on(t.isPublic, t.publishedAt),
]);

// Models a creator has picked up from the community — keeps their model
// picker short while the browsable library grows without limit.
export const generationModelCollections = pgTable("generation_model_collections", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  modelId: text("model_id")
    .notNull()
    .references(() => generationModels.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  unique("generation_model_collections_uq").on(t.userId, t.modelId),
  index("generation_model_collections_model_idx").on(t.modelId),
]);

// ─── Generation presets ("我的配方") ─────────────────────────────────
// A saved recipe: the full submit payload (prompt, advanced, style, denoise…)
// stored opaquely — the submit path re-validates everything when it's replayed.
export const generationPresets = pgTable("generation_presets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  templateId: text("template_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("generation_presets_user_idx").on(t.userId, t.createdAt),
]);

// ─── Bundle table ───────────────────────────────────────────────────

export const bundles = pgTable("bundles", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").default(""),
  // Primary language of the bundle's text content (e.g. "en", "zh", "ja").
  // Null = language-neutral (pure component/variable/rule packs).
  language: text("language"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  content: jsonb("content").notNull().$type<Record<string, unknown>>().default({}),
  isPublic: boolean("is_public").notNull().default(false),
  isOfficial: boolean("is_official").notNull().default(false),
  coverImage: text("cover_image"),
  galleryImages: jsonb("gallery_images").$type<string[]>().default([]),
  downloadCount: integer("download_count").notNull().default(0),
  likeCount: integer("like_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  // Same tag cap as worlds (see worlds_tags_max). The bundle create/update
  // routes have no Zod schema, so the app-layer clamp + this constraint are
  // the only guards against unbounded tag lists from the free-text editor.
  check("bundles_tags_max", sql`jsonb_array_length(${t.tags}) <= 50`),
  index("bundles_user_id_idx").on(t.userId),
]);

export const bundleLikes = pgTable("bundle_likes", {
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => bundles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  unique("bundle_likes_uniq").on(t.userId, t.bundleId),
  index("bundle_likes_bundle_id_idx").on(t.bundleId),
  index("bundle_likes_user_id_idx").on(t.userId),
]);

export const dismissedBundles = pgTable("dismissed_bundles", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  bundleId: text("bundle_id")
    .notNull()
    .references(() => bundles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [unique().on(table.userId, table.bundleId)]);

// Comment feed for a bundle — append-only, same as `reviews`. `rating` is a
// legacy star snapshot from the one-review-per-user era; the live rating lives
// in bundleRatings.
export const bundleReviews = pgTable("bundle_reviews", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  bundleId: text("bundle_id").notNull().references(() => bundles.id, { onDelete: "cascade" }),
  rating: integer("rating"),
  content: text("content"),
  replyCount: integer("reply_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("bundle_reviews_bundle_id_idx").on(table.bundleId),
]);

// One star rating per user per bundle. Mirrors worldRatings: keeping ratings
// out of the comment feed means comment volume can't inflate a bundle's score
// and hiding a comment can't silently retract someone's stars.
export const bundleRatings = pgTable("bundle_ratings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  bundleId: text("bundle_id").notNull().references(() => bundles.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  unique().on(table.userId, table.bundleId),
  index("bundle_ratings_bundle_id_idx").on(table.bundleId),
  index("bundle_ratings_user_id_idx").on(table.userId),
]);

export const bundleReviewReplies = pgTable("bundle_review_replies", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  reviewId: text("review_id").notNull().references(() => bundleReviews.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  replyToReplyId: text("reply_to_reply_id").references((): any => bundleReviewReplies.id, { onDelete: "set null" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("bundle_review_replies_review_id_idx").on(table.reviewId),
  index("bundle_review_replies_user_id_idx").on(table.userId),
]);

// ─── Social tables ──────────────────────────────────────────────────

export const favorites = pgTable("favorites", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  unique().on(table.userId, table.worldId),
  index("favorites_world_id_idx").on(table.worldId),
  index("favorites_user_id_idx").on(table.userId),
]);

export const follows = pgTable("follows", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  followerId: text("follower_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  followingId: text("following_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow(),
  /** Per-friend remark name (WeChat-style; reserved by the 2026-09 friends design, UI later). */
  alias: text("alias"),
}, (table) => [
  unique().on(table.followerId, table.followingId),
  index("follows_follower_id_idx").on(table.followerId),
  index("follows_following_id_idx").on(table.followingId),
]);

/**
 * Profile announcement wall — short posts a creator publishes on their OWN
 * profile (plans, delays, character updates). This persistent creator-owned
 * surface complements broader community discussion. Owner-writable only;
 * visibility follows the profile's privacy prefs. (Feature request, community
 * thread "Multiple feature requests!" 2026-07-30.)
 */
export const profilePosts = pgTable("profile_posts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  isPinned: boolean("is_pinned").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("profile_posts_user_created_idx").on(table.userId, table.createdAt),
]);

// Open comment feed under a card. Multiple rows per user are allowed; `rating`
// is a nullable legacy snapshot from the pre-2026-08 era when this table held
// one-review-per-user rows (star ratings now live in `worldRatings`).
export const reviews = pgTable("reviews", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
  rating: integer("rating"),
  content: text("content"),
  replyCount: integer("reply_count").notNull().default(0),
  hiddenByCreatorAt: timestamp("hidden_by_creator_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("reviews_world_id_idx").on(table.worldId),
  index("reviews_user_id_idx").on(table.userId),
]);

// One star rating per user per card (enforced per language group in the API,
// like reviews used to be). Drives review_count/average_rating on worlds, so
// comment volume can never inflate a card's traction.
export const worldRatings = pgTable("world_ratings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  unique().on(table.userId, table.worldId),
  index("world_ratings_world_id_idx").on(table.worldId),
  index("world_ratings_user_id_idx").on(table.userId),
]);

export const reviewReplies = pgTable("review_replies", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  reviewId: text("review_id").notNull().references(() => reviews.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  replyToReplyId: text("reply_to_reply_id").references((): any => reviewReplies.id, { onDelete: "set null" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("review_replies_review_id_idx").on(table.reviewId),
  index("review_replies_user_id_idx").on(table.userId),
]);

// ─── Extensions ─────────────────────────────────────────────────────
// First-party feature marketplace. The catalog of WHICH extensions exist lives
// in code (EXTENSION_REGISTRY in @yumina/shared); these tables hold only
// per-user install state, reviews, and denormalized counters — all keyed by the
// stable string `extension_key` so the system can grow toward third-party
// extensions later without reshaping the schema.

// Denormalized per-extension counters (mirrors the review_count/average_rating/
// download_count the worlds table keeps on its row). One row per key, lazily
// upserted — the only mutable "catalog" state in the DB.
export const extensionStats = pgTable("extension_stats", {
  extensionKey: text("extension_key").primaryKey(),
  downloadCount: integer("download_count").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  averageRating: real("average_rating").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Per-user install state with soft-uninstall history.
//   status='installed'   → entitlement ON
//   status='uninstalled' → previously installed, now off, user data RETAINED
// installedAt = first-ever install; uninstalledAt = last uninstall (null while
// installed). Reinstall flips status back to 'installed', keeps installedAt.
export const userExtensions = pgTable("user_extensions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  extensionKey: text("extension_key").notNull(),
  status: text("status", { enum: ["installed", "uninstalled"] }).notNull().default("installed"),
  installedAt: timestamp("installed_at").defaultNow(),
  uninstalledAt: timestamp("uninstalled_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  unique().on(table.userId, table.extensionKey),
  index("user_extensions_user_id_idx").on(table.userId),
  index("user_extensions_key_status_idx").on(table.extensionKey, table.status),
]);

// Reviews — 1:1 mirror of `reviews` (worlds), FK on the stable extension_key.
// Comment feed for an extension — append-only, same as `reviews`. `rating` is a
// legacy star snapshot; the live rating lives in extensionRatings.
export const extensionReviews = pgTable("extension_reviews", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  extensionKey: text("extension_key").notNull(),
  rating: integer("rating"),
  content: text("content"),
  replyCount: integer("reply_count").notNull().default(0),
  hiddenByCreatorAt: timestamp("hidden_by_creator_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("extension_reviews_key_idx").on(table.extensionKey),
  index("extension_reviews_user_id_idx").on(table.userId),
]);

// One star rating per user per extension. `extension_key` has no table to point
// at (extensions are code-defined, not rows), so there is no FK here — the same
// shape extensionReviews already uses.
export const extensionRatings = pgTable("extension_ratings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  extensionKey: text("extension_key").notNull(),
  rating: integer("rating").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  unique().on(table.userId, table.extensionKey),
  index("extension_ratings_key_idx").on(table.extensionKey),
  index("extension_ratings_user_id_idx").on(table.userId),
]);

// ─── API Keys ───────────────────────────────────────────────────────

export const apiKeys = pgTable("api_keys", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("openrouter"),
  encryptedKey: text("encrypted_key").notNull(),
  keyIv: text("key_iv").notNull(),
  keyTag: text("key_tag").notNull(),
  label: text("label").notNull().default("Default"),
  baseUrl: text("base_url"),                                // NEW — custom only
  metadata: jsonb("metadata").$type<ApiKeyMetadata>(),      // NEW — custom only
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("api_keys_user_id_idx").on(t.userId),
]);

// ─── Studio Conversations ───────────────────────────────────────────

export const studioConversations = pgTable("studio_conversations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("New Conversation"),
  messages: jsonb("messages").$type<Array<Record<string, unknown>>>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("studio_conversations_world_id_idx").on(t.worldId),
  index("studio_conversations_user_id_idx").on(t.userId),
]);

// ─── Agent Runs ─────────────────────────────────────────────────────

export const agentRuns = pgTable("agent_runs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id")
    .references(() => studioConversations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  status: text("status", {
    enum: ["running", "awaiting_approval", "awaiting_user", "awaiting_credits", "completed", "error"],
  }).notNull().default("running"),
  /** Full LLM message history for this run */
  messages: jsonb("messages").$type<Array<Record<string, unknown>>>().notNull().default([]),
  /** Durable credit pause. Claimed results remain here until their writes commit. */
  creditCheckpoint: jsonb("credit_checkpoint").$type<Record<string, unknown>>(),
  /** Write tool calls pending user approval */
  pendingToolCalls: jsonb("pending_tool_calls").$type<Array<Record<string, unknown>>>(),
  /** Read tool results already executed for current turn */
  readToolResults: jsonb("read_tool_results").$type<Array<Record<string, unknown>>>(),
  /** Accumulated text content from current LLM turn */
  textContent: text("text_content"),
  /** Ordered list of committed assistant text turns (each = one persistent chat bubble).
   *  Server owns commit boundaries; client hydrates this on recovery instead of re-deriving
   *  from textContent. Prevents duplicate-bubble bugs when SSE disconnects or the agent
   *  exits via spiral/max-iter/duplicate-write after already emitting read_tools_executed. */
  committedTurns: jsonb("committed_turns").$type<Array<{
    iteration: number;
    textContent: string;
    createdAt: string;
    commitId: string;
    writeToolCalls?: ToolCall[];
    /** Identity of this committed turn, decided from structural facts at commit
     *  time (NOT inferred from text later). Cross-run agent history keeps ONLY
     *  `answer`; `step` (tool preamble or mid-task stall) and `notice`
     *  (server-injected guard/nudge text) are UI-only and never re-fed to the
     *  model. This is the positive signal that replaces the old negative
     *  "looks-like-narration → drop" heuristic. See runCommittedAssistantMessages.
     *  Absent on rows written before this field existed — those fall back to the
     *  legacy heuristic + a server-notice content net. */
    lane?: "answer" | "step" | "notice";
    /** Compact, faithful trace of the tool calls this turn made: op name + target
     *  (entity id / query), NEVER tool output bodies. Cheap, doesn't go stale,
     *  doesn't 400 on replay. Lets "did this turn do work?" be read from structure
     *  instead of guessed. */
    actions?: Array<{ op: string; target?: string }>;
    /** Legacy: superseded by `lane`. True when text accompanied a tool call.
     *  Still read for back-compat on old rows; new rows set `lane` instead. */
    toolNarration?: boolean;
  }>>().notNull().default([]),
  iteration: integer("iteration").notNull().default(0),
  maxIterations: integer("max_iterations").notNull().default(10),
  model: text("model").notNull(),
  /** Studio context: activePanel, selectedElement */
  context: jsonb("context").$type<Record<string, unknown>>(),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("agent_runs_world_id_idx").on(t.worldId),
  index("agent_runs_user_status_idx").on(t.userId, t.status),
]);

// ─── World Snapshots (revert support for agent changes) ─────────────

export const worldSnapshots = pgTable("world_snapshots", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Agent run that triggered this snapshot (null for manual snapshots) */
  agentRunId: text("agent_run_id")
    .references(() => agentRuns.id, { onDelete: "set null" }),
  /** Full world schema at the time of snapshot */
  schemaData: jsonb("schema_data").$type<Record<string, unknown>>().notNull(),
  label: text("label").notNull().default("Auto-save"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("world_snapshots_world_id_idx").on(t.worldId),
]);

// ─── Achievements ────────────────────────────────────────────────────

export const achievements = pgTable("achievements", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  icon: text("icon"),
  rarity: text("rarity", { enum: ["Common", "Rare", "Epic", "Legendary"] }).notNull().default("Common"),
  condition: jsonb("condition").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const userAchievements = pgTable("user_achievements", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  achievementId: text("achievement_id").notNull().references(() => achievements.id, { onDelete: "cascade" }),
  sessionId: text("session_id"),
  earnedAt: timestamp("earned_at").defaultNow(),
}, (table) => [unique().on(table.userId, table.achievementId)]);

// ─── Platform Achievements (showcaseable titles + badges) ───────────
// Catalog grouped into categories; each achievement carries bronze/silver/gold
// tiers (plus the diamond capstone). A user showcases one via user.showcasedAchievementId.
export const platformAchievementGroups = pgTable("platform_achievement_groups", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  key: text("key").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const platformAchievements = pgTable("platform_achievements", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  groupId: text("group_id").notNull().references(() => platformAchievementGroups.id, { onDelete: "cascade" }),
  key: text("key").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  badge: text("badge"),
  metricKey: text("metric_key"),
  triggerType: text("trigger_type").notNull().default("event"),
  isCapstone: boolean("is_capstone").notNull().default(false),
  tier: text("tier", { enum: ["Common", "Rare", "Epic", "Legendary"] }).notNull().default("Common"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [index("platform_achievements_group_id_idx").on(t.groupId)]);

// Difficulty tiers for an achievement (bronze/silver/gold progression, plus the
// single diamond capstone). A non-tiered achievement has one tier.
export const platformAchievementTiers = pgTable("platform_achievement_tiers", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  achievementId: text("achievement_id").notNull().references(() => platformAchievements.id, { onDelete: "cascade" }),
  level: text("level", { enum: ["bronze", "silver", "gold", "diamond"] }).notNull().default("bronze"),
  threshold: integer("threshold").notNull().default(1),
  badge: text("badge"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [
  unique().on(t.achievementId, t.level),
  index("platform_achievement_tiers_achievement_id_idx").on(t.achievementId),
]);

// Raw per-user metric counters powering progress bars. One row per (user, metric).
export const userAchievementProgress = pgTable("user_achievement_progress", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  metricKey: text("metric_key").notNull(),
  value: integer("value").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  unique().on(t.userId, t.metricKey),
  index("user_achievement_progress_user_id_idx").on(t.userId),
]);

export const userPlatformAchievements = pgTable("user_platform_achievements", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  achievementId: text("achievement_id").notNull().references(() => platformAchievements.id, { onDelete: "cascade" }),
  tierLevel: text("tier_level").notNull().default("bronze"),
  earnedAt: timestamp("earned_at").defaultNow(),
}, (t) => [
  unique().on(t.userId, t.achievementId, t.tierLevel),
  index("user_platform_achievements_user_id_idx").on(t.userId),
]);

// ─── World Updates & Notifications ──────────────────────────────────

export const worldUpdates = pgTable("world_updates", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  content: text("content"),
  isMajor: boolean("is_major").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("world_updates_world_id_idx").on(t.worldId),
]);

// Immutable content versions. Named saves and automatic history have separate caps.
export const worldVersions = pgTable("world_versions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  note: text("note"),
  schema: jsonb("schema").notNull().$type<Record<string, unknown>>(),
  publishedAt: timestamp("published_at"),
  source: text("source").notNull().default("manual").$type<"manual" | "publish" | "live" | "backup">(),
  thumbnailUrl: text("thumbnail_url"),
  // Null identifies legacy schema-only snapshots; restore keeps the current cover/rating.
  ageRating: text("age_rating"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("world_versions_world_id_idx").on(t.worldId),
  index("world_versions_world_created_idx").on(t.worldId, t.createdAt),
]);

export const notifications = pgTable("notifications", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  dedupeKey: text("dedupe_key"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  read: boolean("read").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("notifications_user_id_idx").on(t.userId),
  index("notifications_user_read_idx").on(t.userId, t.read),
  // The notifications list is a polled endpoint ordering a user's rows by
  // created_at — the composite serves the ORDER BY without a sort (3.4k
  // slow/wk). Applied to dev+prod 2026-07-06 via install-hotpath-indexes.ts.
  index("notifications_user_created_idx").on(t.userId, t.createdAt),
  index("notifications_actor_user_idx").on(t.actorUserId),
  uniqueIndex("notifications_user_type_dedupe_uniq")
    .on(t.userId, t.type, t.dedupeKey)
    .where(sql`${t.dedupeKey} IS NOT NULL`),
]);

// ─── Reports ────────────────────────────────────────────────────────

export const reports = pgTable("reports", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  reporterId: text("reporter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull().default("world"),
  targetId: text("target_id").notNull(),
  reason: text("reason").notNull(),
  details: text("details"),
  screenshotKeys: jsonb("screenshot_keys").$type<string[]>().default([]),
  status: text("status").notNull().default("pending"),
  resolution: text("resolution"),
  resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at"),
  adminNote: text("admin_note"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [unique().on(table.reporterId, table.targetType, table.targetId)]);

// ─── Credit System ──────────────────────────────────────────────────

export const creditWallets = pgTable("credit_wallets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  balance: real("balance").notNull().default(0),
  addonBalance: real("addon_balance").notNull().default(0), // aggregate Saved + Bonus; expiry lives in Bonus lots
  plan: text("plan").notNull().default("free"), // free|go|plus|pro|ultra
  monthlyCredits: integer("monthly_credits").notNull().default(1000),
  memoryCap: integer("memory_cap"), // null = unlimited
  pendingPlan: text("pending_plan"),              // scheduled downgrade target (null = none)
  pendingPlanEffective: timestamp("pending_plan_effective"), // when the downgrade takes effect
  planExpiresAt: timestamp("plan_expires_at"),     // referral plan grant expiry (null = permanent)
  planBaseline: text("plan_baseline"),             // plan to revert to when grant expires
  planGrantQueue: jsonb("plan_grant_queue").$type<{ plan: string; durationMs: number }[]>().notNull().default([]),
  subscriptionSource: text("subscription_source"),     // "stripe" | "wechat" | null — how recurring billing is managed
  // When a Stripe sub is set to cancel at period end, we record the cancel date
  // here so admin/UI show "cancels on X" instead of "renews". Null = will renew.
  // Written by /cancel, /reactivate, and the subscription.updated webhook (the
  // webhook catches Stripe-portal cancellations that never hit our endpoint).
  subscriptionCancelAt: timestamp("subscription_cancel_at"),
  lastDailyRecovery: timestamp("last_daily_recovery"), // last time daily credit recovery was granted
  grokTrialRemaining: integer("grok_trial_remaining").notNull().default(0),
  // Billing lineup the wallet lives under. 1 = legacy (plan-config.ts: lump grant,
  // daily refill, flat check-ins). 2 = 2026-09 lineup (plan-config-v2.ts: drops on
  // day 0/10/20, no refill, quests). Set once at wallet creation from
  // BILLING_V2_LAUNCH_AT; existing wallets keep their purchased terms.
  planVersion: integer("plan_version").notNull().default(1),
  periodStart: timestamp("period_start").notNull().defaultNow(),
  periodEnd: timestamp("period_end").notNull()
    .$defaultFn(() => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("credit_wallets_user_id_idx").on(t.userId),
]);

export const creditTransactions = pgTable("credit_transactions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  walletId: text("wallet_id")
    .notNull()
    .references(() => creditWallets.id, { onDelete: "cascade" }),
  amount: real("amount").notNull(), // positive=credit, negative=debit
  type: text("type").notNull(), // plan_grant|usage|addon|admin|refund|expire
  referenceId: text("reference_id"), // usage_log.id, stripe payment id, etc.
  balanceAfter: real("balance_after").notNull(),
  description: text("description"),
  // Hash chain for tamper-proof ledger (blockchain-like)
  previousHash: text("previous_hash"), // hash of the previous transaction (null = genesis)
  hash: text("hash"),                  // SHA-256 of (id + walletId + amount + type + balanceAfter + previousHash + createdAt)
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("credit_txn_wallet_idx").on(t.walletId),
  index("credit_txn_ref_idx").on(t.referenceId),
  // The hash-chain read (newest hash per wallet, ORDER BY created_at DESC
  // LIMIT n) runs on every generation — the composite turns a fetch-all-
  // then-sort (~1s for heavy spenders) into a backward index scan (<1ms).
  // Applied to dev+prod 2026-07-06 via scripts/install-hotpath-indexes.ts.
  index("credit_txn_wallet_created_idx").on(t.walletId, t.createdAt),
  uniqueIndex("credit_txn_event_reward_ref_unique")
    .on(t.referenceId)
    .where(sql`${t.type} = 'event_reward' AND ${t.referenceId} IS NOT NULL`),
  // Prevent double-spend: same referenceId can only appear once for addon transactions.
  // Usage deductions already use unique usageLogIds. Addon uses session.id.
  // NOTE: partial unique index (WHERE type = 'addon') must be created via raw SQL / db:push.
  // Drizzle schema defines a full unique for pushability; the partial constraint
  // is applied in production via: CREATE UNIQUE INDEX IF NOT EXISTS credit_txn_addon_ref_unique
  //   ON credit_transactions(reference_id) WHERE type = 'addon' AND reference_id IS NOT NULL;
]);

// Mirrors prepare-free-credit-policy.sql. Keeping these in the schema prevents
// a later schema push from treating the separately installed wallet tables as obsolete.
/** Short-lived Studio spending holds. They earmark balance without moving
 * funding buckets; Bonus expiry and final spend allocation remain authoritative. */
export const studioCreditReservations = pgTable("studio_credit_reservations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  walletId: text("wallet_id").notNull().references(() => creditWallets.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  referenceId: text("reference_id").notNull(),
  credits: real("credits").notNull(),
  status: text("status").notNull().default("active"),
  expiresAt: timestamp("expires_at").notNull(),
  settledCredits: real("settled_credits"),
  transactionId: text("transaction_id").references(() => creditTransactions.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("studio_credit_reservations_wallet_reference_key").on(t.walletId, t.referenceId),
  check("studio_credit_reservations_credits_check", sql`${t.credits} >= 0 AND ${t.credits} < 'Infinity'::real`),
  check("studio_credit_reservations_status_check", sql`${t.status} IN ('active', 'released', 'settled')`),
  check("studio_credit_reservations_settled_check", sql`${t.settledCredits} IS NULL OR (${t.settledCredits} >= 0 AND ${t.settledCredits} < 'Infinity'::real)`),
  index("studio_credit_reservations_active_idx").on(t.walletId, t.expiresAt).where(sql`${t.status} = 'active'`),
]);

export const walletBonusLots = pgTable("wallet_bonus_lots", {
  id: text("id").primaryKey(),
  walletId: text("wallet_id").notNull(),
  origin: text("origin").notNull(),
  referenceId: text("reference_id").notNull(),
  remaining: numeric("remaining", { precision: 24, scale: 6 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ name: "wallet_bonus_lots_wallet_id_fkey", columns: [t.walletId], foreignColumns: [creditWallets.id] }).onDelete("cascade"),
  unique("wallet_bonus_lots_wallet_id_reference_id_key").on(t.walletId, t.referenceId),
  check("wallet_bonus_lots_remaining_check", sql`${t.remaining} >= 0`),
  index("wallet_bonus_lots_spend_idx").on(t.walletId, t.expiresAt).where(sql`${t.remaining} > 0`),
  index("wallet_bonus_lots_due_idx").on(t.expiresAt, t.walletId).where(sql`${t.remaining} > 0`),
]);

export const walletSpendAllocations = pgTable("wallet_spend_allocations", {
  transactionId: text("transaction_id").primaryKey(),
  walletId: text("wallet_id").notNull(),
  allocations: jsonb("allocations").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ name: "wallet_spend_allocations_transaction_id_fkey", columns: [t.transactionId], foreignColumns: [creditTransactions.id] }).onDelete("cascade"),
  foreignKey({ name: "wallet_spend_allocations_wallet_id_fkey", columns: [t.walletId], foreignColumns: [creditWallets.id] }).onDelete("cascade"),
]);

export const walletFreeCycles = pgTable("wallet_free_cycles", {
  walletId: text("wallet_id").primaryKey(),
  periodStart: timestamp("period_start").notNull(),
  monthlyCredits: integer("monthly_credits").notNull(),
  recoveryFloor: integer("recovery_floor").notNull(),
  recoveryCap: integer("recovery_cap").notNull(),
}, t => [
  foreignKey({ name: "wallet_free_cycles_wallet_id_fkey", columns: [t.walletId], foreignColumns: [creditWallets.id] }).onDelete("cascade"),
  check("wallet_free_cycles_monthly_credits_check", sql`${t.monthlyCredits} IN (1000,2000)`),
  check("wallet_free_cycles_recovery_floor_check", sql`${t.recoveryFloor} IN (100,200)`),
  check("wallet_free_cycles_recovery_cap_check", sql`${t.recoveryCap} IN (500,1000)`),
]);

/** Billing lineup v2: which scheduled drops of the current cycle a wallet has received. */
export const walletPlanDrops = pgTable("wallet_plan_drops", {
  walletId: text("wallet_id").primaryKey(),
  periodStart: timestamp("period_start").notNull(),
  dropsReleased: integer("drops_released").notNull().default(1),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => [
  foreignKey({ name: "wallet_plan_drops_wallet_id_fkey", columns: [t.walletId], foreignColumns: [creditWallets.id] }).onDelete("cascade"),
]);

/** Billing lineup v2: one quest claim per user per reward day; rewards land in wallet_bonus_lots. */
export const questClaims = pgTable("quest_claims", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  /** Kept for the daily board and for continuity with the pre-2026-09-15 rows. */
  dayKey: text("day_key").notNull(),
  /** 'day' | 'week' — which board this claim came from. */
  periodKind: text("period_kind").notNull().default("day"),
  /** The day key for daily claims, the reward week's Monday for weekly ones. */
  periodKey: text("period_key").notNull(),
  questKey: text("quest_key").notNull(),
  rewardAmount: integer("reward_amount").notNull(),
  claimedAt: timestamp("claimed_at").notNull().defaultNow(),
}, (t) => [
  // One claim per quest per period. The old (user, day) key allowed a single
  // claim a day, which the three-a-day board would have rejected.
  unique("quest_claims_user_period_quest_uniq").on(t.userId, t.periodKind, t.periodKey, t.questKey),
  index("quest_claims_user_period_idx").on(t.userId, t.periodKind, t.periodKey),
  index("quest_claims_user_claimed_idx").on(t.userId, t.claimedAt),
]);

export const walletUsageRefunds = pgTable("wallet_usage_refunds", {
  originalTransactionId: text("original_transaction_id").primaryKey(),
  refundTransactionId: text("refund_transaction_id").notNull(),
}, t => [
  foreignKey({ name: "wallet_usage_refunds_original_transaction_id_fkey", columns: [t.originalTransactionId], foreignColumns: [creditTransactions.id] }).onDelete("cascade"),
  foreignKey({ name: "wallet_usage_refunds_refund_transaction_id_fkey", columns: [t.refundTransactionId], foreignColumns: [creditTransactions.id] }).onDelete("cascade"),
  unique("wallet_usage_refunds_refund_transaction_id_key").on(t.refundTransactionId),
]);

// ─── Creator Tipping / Payouts ──────────────────────────────────────

export const creatorPayoutAccounts = pgTable("creator_payout_accounts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }).unique(),
  stripeConnectId: text("stripe_connect_id").notNull(),
  status: text("status").notNull().default("onboarding"),
  payoutsEnabled: boolean("payouts_enabled").default(false),
  chargesEnabled: boolean("charges_enabled").default(false),
  country: text("country"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Pending Stripe tips keep their user/content context in Postgres rather than
// copying IDs or free-text messages into processor metadata. User/content FKs
// null on deletion so a late webhook can either refund a deleted creator or
// complete an anonymous tip from a deleted sender without retaining their PII.
export const tipPaymentIntents = pgTable("tip_payment_intents", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  stripePaymentIntentId: text("stripe_payment_intent_id").unique(),
  senderId: text("sender_id").references(() => user.id, { onDelete: "set null" }),
  creatorId: text("creator_id").references(() => user.id, { onDelete: "set null" }),
  worldId: text("world_id").references(() => worlds.id, { onDelete: "set null" }),
  bundleId: text("bundle_id").references(() => bundles.id, { onDelete: "set null" }),
  amount: integer("amount").notNull(),
  message: text("message"),
  isAnonymous: boolean("is_anonymous").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("tip_payment_intents_sender_idx").on(t.senderId),
  index("tip_payment_intents_creator_idx").on(t.creatorId),
  index("tip_payment_intents_pi_idx").on(t.stripePaymentIntentId),
]);

export const creatorEarnings = pgTable("creator_earnings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  // Financial records are retained for accounting after either party deletes
  // their account, but the user/content attribution is removed.
  creatorId: text("creator_id").references(() => user.id, { onDelete: "set null" }),
  // Attribution target. A tip is attributed to either a world OR a bundle
  // (or neither, for creator-level/profile tips). Both nullable on purpose.
  worldId: text("world_id").references(() => worlds.id, { onDelete: "set null" }),
  bundleId: text("bundle_id").references(() => bundles.id, { onDelete: "set null" }),
  senderId: text("sender_id").references(() => user.id, { onDelete: "set null" }),
  type: text("type").notNull().default("tip"),
  grossAmount: integer("gross_amount").notNull(),
  platformFee: integer("platform_fee").notNull(),
  stripeFee: integer("stripe_fee"),
  netAmount: integer("net_amount"),
  currency: text("currency").default("usd"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeTransferId: text("stripe_transfer_id"),
  status: text("status").notNull().default("pending"),
  holdExpiresAt: timestamp("hold_expires_at"),
  message: text("message"),
  isAnonymous: boolean("is_anonymous").default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("creator_earnings_creator_idx").on(t.creatorId),
  index("creator_earnings_world_idx").on(t.worldId, t.createdAt),
  index("creator_earnings_bundle_idx").on(t.bundleId, t.createdAt),
  unique("creator_earnings_pi_unique").on(t.stripePaymentIntentId),
  // Sender-side lookup for the support prompt's "already backed this creator"
  // suppression. See the matching index on mushie_gifts.
  index("creator_earnings_sender_creator_idx").on(t.senderId, t.creatorId, t.createdAt),
]);

export const mushieGifts = pgTable("mushie_gifts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  // Keep the credit ledger but anonymize deleted senders/recipients.
  senderId: text("sender_id").references(() => user.id, { onDelete: "set null" }),
  recipientId: text("recipient_id").references(() => user.id, { onDelete: "set null" }),
  // Attribution target — world OR bundle (or neither). Both nullable.
  worldId: text("world_id").references(() => worlds.id, { onDelete: "set null" }),
  bundleId: text("bundle_id").references(() => bundles.id, { onDelete: "set null" }),
  amount: integer("amount").notNull(),
  idempotencyKey: text("idempotency_key").unique(),
  message: text("message"),
  isAnonymous: boolean("is_anonymous").default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => [
  index("mushie_gifts_recipient_idx").on(t.recipientId),
  index("mushie_gifts_world_idx").on(t.worldId),
  index("mushie_gifts_bundle_idx").on(t.bundleId),
  // The support prompt asks "has this player already backed this creator in the
  // last 90 days?" on every chat exit. Without a sender-side index that is a
  // scan of the whole gift log. Mirrored on creator_earnings.
  index("mushie_gifts_sender_recipient_idx").on(t.senderId, t.recipientId, t.createdAt),
]);

// ─── Support Prompt ─────────────────────────────────────────────────
// One row per time the "support this creator" card was judged eligible for a
// (user, world). Doubles as the frequency-cap ledger — the eligibility check
// counts rows here before it counts anything else, so a user can never be
// asked more than 3 times a year no matter what the score says.
//
// holdout rows are eligible players we deliberately did NOT show the card to.
// They are the control group for "does asking hurt retention?", which is the
// only way to know the feature is not net-negative.
export const supportPromptEvents = pgTable("support_prompt_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
  creatorId: text("creator_id").references(() => user.id, { onDelete: "set null" }),
  sessionId: text("session_id").references(() => playSessions.id, { onDelete: "set null" }),
  /** depth × affinity at the moment of the decision, 0–1. */
  score: real("score").notNull(),
  playtimeSeconds: integer("playtime_seconds").notNull().default(0),
  turnCount: integer("turn_count").notNull().default(0),
  dayCount: integer("day_count").notNull().default(0),
  /** True = eligible but suppressed on purpose (control group). */
  holdout: boolean("holdout").notNull().default(false),
  /** Set when the player actively closed the card. Counts toward the silence rule. */
  dismissedAt: timestamp("dismissed_at"),
  /**
   * Set when the card faded out unanswered. Deliberately separate from
   * dismissedAt: the player may never have seen it, so it must not read as a
   * refusal in the two-in-a-row silence rule.
   */
  timedOutAt: timestamp("timed_out_at"),
  /** Set when the player opened the tip modal from this card. */
  openedAt: timestamp("opened_at"),
  /** Set when a tip or mushie gift landed while this card's modal was open. */
  convertedAt: timestamp("converted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("support_prompt_events_user_created_idx").on(t.userId, t.createdAt),
  index("support_prompt_events_user_world_idx").on(t.userId, t.worldId, t.createdAt),
  // FK to play_sessions: without it every session delete scans this table.
  index("support_prompt_events_session_id_idx").on(t.sessionId),
]);

// ─── Stripe Webhook Dedup ────────────────────────────────────────────
// Prevents processing the same Stripe event twice under high webhook volume.
// INSERT with ON CONFLICT DO NOTHING — if the event was already processed, skip.
export const stripeWebhookEvents = pgTable("stripe_webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at").defaultNow(),
});

export const dailyCheckins = pgTable("daily_checkins", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  dayKey: text("day_key").notNull(),
  weekKey: text("week_key").notNull(),
  rewardIndex: integer("reward_index").notNull(),
  rewardAmount: integer("reward_amount").notNull(),
  timeZone: text("time_zone").notNull(),
  claimedAt: timestamp("claimed_at").notNull().defaultNow(),
}, (t) => [
  unique("daily_checkins_user_day_uniq").on(t.userId, t.dayKey),
  index("daily_checkins_user_week_idx").on(t.userId, t.weekKey),
]);

export const userCheckinStats = pgTable("user_checkin_stats", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  timeZone: text("time_zone"),
  currentStreak: integer("current_streak").notNull().default(0),
  longestStreak: integer("longest_streak").notNull().default(0),
  totalCheckins: integer("total_checkins").notNull().default(0),
  lastDayKey: text("last_day_key"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const modelPrices = pgTable("model_prices", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  modelId: text("model_id").notNull(),
  inputPricePerM: real("input_price_per_m").notNull(), // $/M input tokens (raw upstream)
  outputPricePerM: real("output_price_per_m").notNull(), // $/M output tokens (raw upstream)
  contextThreshold: integer("context_threshold"), // null = flat pricing
  inputPriceAboveThreshold: real("input_price_above_threshold"), // tiered price
  outputPriceAboveThreshold: real("output_price_above_threshold"),
  minPlan: text("min_plan").notNull().default("free"), // minimum plan to use this model
  /** Multiplier applied to credit cost. 1.0 = pass-through (raw upstream cost).
   *  Higher values protect margin on premium models — see plan-config.ts. */
  markupMultiplier: real("markup_multiplier").notNull().default(1.0),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Usage Tracking ─────────────────────────────────────────────────

export const analyticsPlayIntervals = pgTable('analytics_play_intervals', {
  id:text('id').primaryKey(),
  userId:text('user_id').notNull().references(()=>user.id,{onDelete:'cascade'}),
  worldId:text('world_id').notNull(),
  startedAt:timestamp('started_at',{withTimezone:true}).notNull(),
  endedAt:timestamp('ended_at',{withTimezone:true}).notNull(),
  product:text('product').notNull().default('main-app'),
},t=>[
  index('analytics_play_intervals_user_idx').on(t.userId),
  check('analytics_play_intervals_duration_check',sql`${t.endedAt}>${t.startedAt} AND ${t.endedAt}<=${t.startedAt}+interval '90 seconds'`),
]);
export const analyticsActivity = pgTable('analytics_activity', {
  id:text('id').primaryKey(),
  userId:text('user_id').notNull().references(()=>user.id,{onDelete:'cascade'}),
  worldId:text('world_id').notNull().default(''),
  occurredAt:timestamp('occurred_at',{withTimezone:true}).notNull().defaultNow(),
  surface:text('surface').notNull(),action:text('action').notNull(),
},t=>[
  index('analytics_activity_user_idx').on(t.userId),
  index('activity_referral_play_idx').on(t.userId,t.occurredAt).where(sql`${t.surface}='play' AND ${t.action}='foreground-engaged-60s'`),
  check('analytics_activity_surface_check',sql`${t.surface} IN ('play','studio','community','reward','browse')`),
]);
export const analyticsSourceHeartbeat = pgTable('analytics_source_heartbeat', {
  id:integer('id').primaryKey(),observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),
},t=>[check('analytics_source_heartbeat_id_check',sql`${t.id}=1`)]);

export const usageLogs = pgTable("usage_logs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  sessionId: text("session_id").references(() => playSessions.id, { onDelete: "set null" }),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  endpoint: text("endpoint").notNull(), // "send" | "regenerate" | "continue" | "studio-agent" | "studio-playtest"
  apiKeyTier: text("api_key_tier").notNull().default("regular"), // "regular" | "invited" | "byok"
  generationTimeMs: integer("generation_time_ms"),
  providerCostUsd: numeric("provider_cost_usd", { precision: 24, scale: 12 }),
  providerRequestId: text("provider_request_id"),
  // Preserve attribution when a session is deleted; no session/world join needed.
  analyticsWorldId: text("analytics_world_id"),
  tokenMeasurement: text("token_measurement"), // provider | estimated; legacy unknown
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("usage_logs_user_id_idx").on(t.userId),
  index("usage_referral_play_idx").on(t.userId,t.createdAt).where(sql`${t.endpoint} IN ('send','regenerate','continue','pvz-dave') AND ${t.completionTokens}>0`),
  index("usage_logs_created_at_idx").on(t.createdAt),
  index("usage_logs_created_user_idx").on(t.createdAt, t.userId),
  index("usage_logs_created_model_idx").on(t.createdAt, t.model),
  index("usage_logs_endpoint_created_idx").on(t.endpoint, t.createdAt),
  // Memory-panel usage rollups filter by (session_id, endpoint). Without this
  // they went through the user_id index and rechecked session_id on the heap —
  // 7,721 rows read for an estimated 7, ~1.5s per call and two calls per panel
  // render. With it: 24ms. (scripts/add-usage-logs-session-endpoint-index.sql)
  index("usage_logs_session_endpoint_idx").on(t.sessionId, t.endpoint),
  // Achievement metrics count a user's rows by model pattern / api tier on
  // the message hot path — this keeps those counts off the heap (was ~1s
  // per evaluation for heavy users). Applied to dev+prod 2026-07-06 via
  // scripts/install-hotpath-indexes.ts.
  index("usage_logs_user_model_idx").on(t.userId, t.model, t.apiKeyTier),
]);

export const worldClickHistory = pgTable("world_click_history", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  worldId: text("world_id")
    .notNull()
    .references(() => worlds.id, { onDelete: "cascade" }),
  worldName: text("world_name").notNull(),
  worldThumbnailUrl: text("world_thumbnail_url"),
  source: text("source").notNull(), // "discovery" | "library"
  interaction: text("interaction").notNull(), // "card-click" | "play-click"
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("world_click_history_user_id_idx").on(t.userId),
  index("world_click_history_world_id_idx").on(t.worldId),
  index("world_click_history_created_at_idx").on(t.createdAt),
]);

// ─── Invite Codes ───────────────────────────────────────────────────

export const inviteCodes = pgTable("invite_codes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  code: text("code").notNull().unique(),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  maxRedemptions: integer("max_redemptions").notNull().default(1),
  plan: text("plan").notNull().default("internal"), // which plan to grant
  durationDays: integer("duration_days"), // null = permanent
  isActive: boolean("is_active").notNull().default(true),
  note: text("note"),
  defaultModel: text("default_model"), // model ID to set as user's default on redemption
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const inviteCodeRedemptions = pgTable("invite_code_redemptions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  inviteCodeId: text("invite_code_id")
    .notNull()
    .references(() => inviteCodes.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .references(() => user.id, { onDelete: "set null" }),
  redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
});

// ─── Referral Milestones ────────────────────────────────────────────

export const referralRewardCampaigns = pgTable("referral_reward_campaigns", {
  id: text("id").primaryKey(),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  reward: integer("reward").notNull().default(500),
  maxRewards: integer("max_rewards").notNull().default(4),
  qualificationDays: integer("qualification_days").notNull().default(14),
  rewardSlots: integer("reward_slots").notNull().default(1000),
  paused: boolean("paused").notNull().default(false),
});

export const referralQualifications = pgTable("referral_qualifications", {
  inviteeId: text("invitee_id").primaryKey(),
  referrerId: text("referrer_id").notNull(),
  campaignId: text("campaign_id").notNull().references(() => referralRewardCampaigns.id),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  deadline: timestamp("deadline", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  turns: integer("turns").notNull().default(0),
  seconds: integer("seconds").notNull().default(0),
  returned: boolean("returned").notNull().default(false),
  firstPlayAt: timestamp("first_play_at", { withTimezone: true }),
  returnEligibleAt: timestamp("return_eligible_at", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
  activityVersion: integer("activity_version").notNull().default(0),
  transactionId: text("transaction_id").unique(),
  rewardExpiresAt: timestamp("reward_expires_at", { withTimezone: true }),
  rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
}, (t) => [
  index("referral_qualifications_referrer_idx").on(t.referrerId, t.campaignId, t.status),
  index("referral_qualifications_pending_idx").on(t.nextCheckAt).where(sql`${t.status} = 'pending'`),
]);

export const referralMilestones = pgTable("referral_milestones", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  milestone: integer("milestone").notNull(), // 1, 5, 10, 15, 20, 30
  rewardType: text("reward_type").notNull(), // "plan_grant" | "credit_grant"
  rewardDetail: text("reward_detail"), // "go:30d" | "1000 mushies"
  grantedAt: timestamp("granted_at").defaultNow().notNull(),
}, (t) => [
  unique("referral_milestones_user_milestone").on(t.userId, t.milestone),
]);

// ─── User Personas ──────────────────────────────────────────────────

export const userPersonas = pgTable(
  "user_personas",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    appearance: text("appearance"),
    personality: text("personality"),
    backstory: text("backstory"),
    // Private, user-only label to tell same-named personas apart.
    // NEVER injected into prompts — keep out of buildPersonaSystemMessage
    // (messages.ts) and applyPersonaMetadata (persona-metadata.ts).
    note: text("note"),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("user_personas_user_id_idx").on(t.userId),
  ]
);

// Per-world persona pin: a world with a binding row always plays with that
// persona; no row = follow the account-global isActive persona. Deleting the
// persona (or the world) cascades the row away, which IS the fallback path —
// resolution must never treat a dangling binding as an error.
export const userWorldPersonas = pgTable(
  "user_world_personas",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    worldId: text("world_id")
      .notNull()
      .references(() => worlds.id, { onDelete: "cascade" }),
    personaId: text("persona_id")
      .notNull()
      .references(() => userPersonas.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    unique("user_world_personas_user_world_uniq").on(t.userId, t.worldId),
    index("user_world_personas_persona_idx").on(t.personaId),
    index("user_world_personas_world_idx").on(t.worldId),
  ]
);

// ─── Direct Messages ────────────────────────────────────────────────

export const directConversations = pgTable("direct_conversations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  createdById: text("created_by_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const directConversationParticipants = pgTable(
  "direct_conversation_participants",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => directConversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
    // Per-user inbox removal marker. The physical column predates the
    // direct-only DM redesign (it was formerly named for leaving a group), so
    // keep using it instead of deleting the shared conversation and messages.
    leftAt: timestamp("left_at"),
    pinnedAt: timestamp("pinned_at"),
  },
  (t) => [
    unique("dcp_conversation_user_uniq").on(t.conversationId, t.userId),
    index("dcp_user_id_idx").on(t.userId),
  ]
);

export const directMessages = pgTable("direct_messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => directConversations.id, { onDelete: "cascade" }),
  senderId: text("sender_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  contentType: text("content_type").notNull().default("text"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  clientId: text("client_id"),
  replyToMessageId: text("reply_to_message_id").references((): any => directMessages.id, { onDelete: "set null" }),
  editedAt: timestamp("edited_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("dm_conversation_created_idx").on(t.conversationId, t.createdAt),
  index("dm_sender_id_idx").on(t.senderId),
  index("dm_client_id_idx").on(t.clientId),
  // Backs the derived DM world-share grant (lib/dm-world-grant.ts): sharing an
  // unpublished card in a DM is what authorizes the recipient to preview/fork it,
  // and that check filters on content_type + metadata->>'worldId'. Partial, so it
  // stays tiny next to plain text-message volume. Declared here so drizzle-kit
  // push doesn't treat the live index as an orphan and drop it; applied to live
  // DBs first via scripts/install-dm-world-share-index.ts.
  index("dm_world_share_world_idx")
    .on(sql`((${t.metadata} ->> 'worldId'))`)
    .where(sql`${t.contentType} = 'world-share'`),
]);

export const directMessageHidden = pgTable(
  "direct_message_hidden",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => directMessages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at").defaultNow().notNull(),
  },
  (t) => [
    unique("dm_hidden_message_user_uniq").on(t.messageId, t.userId),
    index("dm_hidden_user_idx").on(t.userId),
  ]
);

export const directMessageReadCursors = pgTable(
  "direct_message_read_cursors",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => directConversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at").defaultNow().notNull(),
  },
  (t) => [
    unique("dmrc_conversation_user_uniq").on(t.conversationId, t.userId),
    index("dmrc_user_id_idx").on(t.userId),
  ]
);

/**
 * Friend game invites (friends = mutual follows; see lib/friends.ts). A short-
 * lived pointer at a live game room: status runs pending -> accepted | declined
 * | expired | revoked, ONE pending per (from,to) pair via a partial unique
 * index (friend_invites_pending_pair_uniq, created in
 * scripts/create-friend-invites.ts -- drizzle can't express partial uniques
 * inline). Distinct from inviteCodes, which is the promo/referral system.
 */
export const friendInvites = pgTable(
  "friend_invites",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    fromUserId: text("from_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    toUserId: text("to_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    worldId: text("world_id").references(() => worlds.id, { onDelete: "set null" }),
    joinUrl: text("join_url").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    respondedAt: timestamp("responded_at"),
  },
  (t) => [
    index("friend_invites_to_idx").on(t.toUserId, t.status),
    index("friend_invites_from_idx").on(t.fromUserId, t.createdAt),
  ],
);

export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerId: text("blocker_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    blockedId: text("blocked_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    hideBlockedWorlds: boolean("hide_blocked_worlds").notNull().default(true),
    hideOwnWorlds: boolean("hide_own_worlds").notNull().default(true),
    hideBlockedActivity: boolean("hide_blocked_activity").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("user_blocks_pair_uniq").on(t.blockerId, t.blockedId),
    index("user_blocks_blocker_idx").on(t.blockerId),
    index("user_blocks_blocked_idx").on(t.blockedId),
  ]
);

// ─── Community ──────────────────────────────────────────────────────

export const forums = pgTable(
  "forums",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    slug: text("slug").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    icon: text("icon").notNull().default("💬"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    unique("forums_slug_uniq").on(t.slug),
  ]
);

export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    forumId: text("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    authorId: text("author_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    images: jsonb("images").$type<Array<{ url: string; name?: string }>>().notNull().default([]),
    lang: text("lang").notNull().default("en"),
    isPinned: boolean("is_pinned").notNull().default(false),
    isFeatured: boolean("is_featured").notNull().default(false),
    // Community-page "official" card (top of the All view, max 2). Independent of
    // is_featured, which drives the Discover hub hero, and of is_pinned (list order).
    isOfficial: boolean("is_official").notNull().default(false),
    isLocked: boolean("is_locked").notNull().default(false),
    viewCount: integer("view_count").notNull().default(0),
    replyCount: integer("reply_count").notNull().default(0),
    likeCount: integer("like_count").notNull().default(0),
    lastReplyAt: timestamp("last_reply_at"),
    lastReplyUserId: text("last_reply_user_id").references(() => user.id, { onDelete: "set null" }),
    worldId: text("world_id").references(() => worlds.id, { onDelete: "set null" }),
    ageRating: text("age_rating").notNull().default("all"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("threads_forum_pinned_reply_idx").on(t.forumId, t.isPinned, t.lastReplyAt),
    index("threads_world_likes_idx").on(t.worldId, t.likeCount),
    index("threads_author_idx").on(t.authorId),
  ]
);

export const communityTags = pgTable(
  "community_tags",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    type: text("type").notNull().default("topic"),
    worldId: text("world_id").references(() => worlds.id, { onDelete: "cascade" }),
  },
  (t) => [index("community_tags_type_world_idx").on(t.type, t.worldId)]
);

export const threadTags = pgTable(
  "thread_tags",
  {
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    tagId: text("tag_id").notNull().references(() => communityTags.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("thread_tags_pk").on(t.threadId, t.tagId),
    index("thread_tags_tag_idx").on(t.tagId),
  ]
);

export const posts = pgTable(
  "posts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    authorId: text("author_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    images: jsonb("images").$type<Array<{ url: string; name?: string }>>().notNull().default([]),
    lang: text("lang").notNull().default("en"),
    parentId: text("parent_id").references((): AnyPgColumn => posts.id, { onDelete: "set null" }),
    // The specific post this reply targets (Bilibili-style "回复 @用户名"). Distinct
    // from parentId, which is flattened to the bucket root for single-level nesting.
    // author name + floor are snapshotted for fast rendering. Account deletion
    // clears them once the self-FK nulls the deleted target ID.
    replyToId: text("reply_to_id").references((): AnyPgColumn => posts.id, { onDelete: "set null" }),
    replyToAuthorName: text("reply_to_author_name"),
    replyToFloor: integer("reply_to_floor"),
    likeCount: integer("like_count").notNull().default(0),
    floor: integer("floor").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("posts_thread_floor_idx").on(t.threadId, t.floor),
    index("posts_parent_idx").on(t.parentId),
    index("posts_reply_to_idx").on(t.replyToId),
    index("posts_author_id_idx").on(t.authorId),
  ]
);

export const threadWorlds = pgTable(
  "thread_worlds",
  {
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    unique("thread_worlds_pk").on(t.threadId, t.worldId),
    index("thread_worlds_thread_idx").on(t.threadId),
  ]
);

export const postWorlds = pgTable(
  "post_worlds",
  {
    postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
    worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    unique("post_worlds_pk").on(t.postId, t.worldId),
    index("post_worlds_post_idx").on(t.postId),
  ]
);

export const threadLikes = pgTable(
  "thread_likes",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [unique("thread_likes_uniq").on(t.userId, t.threadId)]
);

export const postLikes = pgTable(
  "post_likes",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [unique("post_likes_uniq").on(t.userId, t.postId)]
);

export const threadBookmarks = pgTable(
  "thread_bookmarks",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [unique("thread_bookmarks_uniq").on(t.userId, t.threadId)]
);

export const threadPolls = pgTable("thread_polls", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  isMultipleChoice: boolean("is_multiple_choice").notNull().default(false),
  endsAt: timestamp("ends_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const pollOptions = pgTable("poll_options", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  pollId: text("poll_id").notNull().references(() => threadPolls.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  voteCount: integer("vote_count").notNull().default(0),
});

export const pollVotes = pgTable(
  "poll_votes",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    pollId: text("poll_id").notNull().references(() => threadPolls.id, { onDelete: "cascade" }),
    optionId: text("option_id").notNull().references(() => pollOptions.id, { onDelete: "cascade" }),
  },
  (t) => [unique("poll_votes_user_option_uniq").on(t.userId, t.optionId)]
);

export const contentTranslations = pgTable(
  "content_translations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    targetLang: text("target_lang").notNull(),
    translatedTitle: text("translated_title"),
    translatedContent: text("translated_content").notNull(),
    // Hash of the source text this translation was generated from. Without it
    // the cache cannot tell which revision of an edited post it belongs to:
    // an edit used to delete the rows and re-translate, which permanently lost
    // the translation whenever regeneration failed (nothing retries), and let
    // an in-flight pre-edit request win the row via onConflictDoNothing.
    // NULL means "written before hashing existed" — treated as stale so the
    // next write regenerates it.
    sourceHash: text("source_hash"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    unique("content_translations_uniq").on(t.sourceId, t.sourceType, t.targetLang),
    index("content_translations_lookup_idx").on(t.sourceId, t.sourceType, t.targetLang),
  ]
);

export const translationAttempts = pgTable(
  "translation_attempts",
  {
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    targetLang: text("target_lang").notNull(),
    // The revision this outcome describes. An edit changes the hash, which
    // resets the attempt counter — a fresh revision always gets a fresh try.
    sourceHash: text("source_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    // Why the last try produced no cache row: api_error / empty_response /
    // parse_error / refused / echo / placeholder / no_prose / source_changed /
    // source_deleted.
    lastReason: text("last_reason"),
    lastAttemptAt: timestamp("last_attempt_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceType, t.sourceId, t.targetLang] }),
    index("translation_attempts_sweep_idx").on(t.lastAttemptAt),
  ]
);

export const adminActions = pgTable(
  "admin_actions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    adminId: text("admin_id").references(() => user.id, { onDelete: "set null" }),
    actionType: text("action_type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("admin_actions_target_idx").on(t.targetType, t.targetId, t.createdAt),
    index("admin_actions_admin_idx").on(t.adminId, t.createdAt),
    index("admin_actions_type_idx").on(t.actionType, t.createdAt),
  ]
);

export const threadRewards = pgTable(
  "thread_rewards",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    threadId: text("thread_id").unique().references(() => threads.id, { onDelete: "set null" }),
    adminId: text("admin_id").references(() => user.id, { onDelete: "set null" }),
    recipientId: text("recipient_id").references(() => user.id, { onDelete: "set null" }),
    rewardType: text("reward_type").notNull(),
    amount: integer("amount"),
    planId: text("plan_id"),
    durationDays: integer("duration_days"),
    reason: text("reason").notNull(),
    campaignTag: text("campaign_tag"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("thread_rewards_recipient_idx").on(t.recipientId),
    index("thread_rewards_admin_idx").on(t.adminId),
  ]
);

export const communityEvents = pgTable(
  "community_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    title: text("title").notNull(),
    introduction: text("introduction").notNull(),
    rewardDescription: text("reward_description"),
    lang: text("lang").notNull().default("zh"),
    submissionType: text("submission_type").notNull().default("world"),
    singleSubmissionPerUser: boolean("single_submission_per_user").notNull().default(true),
    status: text("status").notNull().default("draft"),
    isCached: boolean("is_cached").notNull().default(false),
    cachedAt: timestamp("cached_at"),
    promoteInCommunity: boolean("promote_in_community").notNull().default(false),
    promoteInDiscover: boolean("promote_in_discover").notNull().default(false),
    bannerImageUrl: text("banner_image_url"),
    posterImageUrl: text("poster_image_url"),
    registrationOpensAt: timestamp("registration_opens_at", { withTimezone: true }),
    registrationClosesAt: timestamp("registration_closes_at", { withTimezone: true }),
    finalDataOpensAt: timestamp("final_data_opens_at", { withTimezone: true }),
    finalDataClosesAt: timestamp("final_data_closes_at", { withTimezone: true }),
    settlementDeadlineAt: timestamp("settlement_deadline_at", { withTimezone: true }),
    rulesVersion: integer("rules_version").notNull().default(1),
    rulesConfig: jsonb("rules_config").$type<SocialEventRulesConfig>(),
    rulesLockedAt: timestamp("rules_locked_at", { withTimezone: true }),
    announcementThreadId: text("announcement_thread_id").references(() => threads.id, { onDelete: "set null" }),
    createdByAdminId: text("created_by_admin_id").references(() => user.id, { onDelete: "set null" }),
    updatedByAdminId: text("updated_by_admin_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("community_events_status_idx").on(t.status, t.updatedAt),
    index("community_events_cache_idx").on(t.isCached, t.cachedAt, t.updatedAt),
    index("community_events_discover_idx").on(t.promoteInDiscover, t.status, t.updatedAt),
    index("community_events_community_idx").on(t.promoteInCommunity, t.status, t.updatedAt),
    index("community_events_social_timeline_idx").on(t.submissionType, t.status, t.registrationOpensAt, t.registrationClosesAt),
    check("community_events_submission_type_check", sql`${t.submissionType} IN ('world','social_post')`),
    check("community_events_rules_version_check", sql`${t.rulesVersion} >= 1`),
  ]
);

export const communityEventSocialEntries = pgTable(
  "community_event_social_entries",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id").notNull().references(() => communityEvents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    socialHandle: text("social_handle"),
    normalizedAccountKey: text("normalized_account_key"),
    draftPayload: jsonb("draft_payload").$type<{
      socialHandle?: string;
      postUrl?: string;
      postPublishedAt?: string;
      initialEvidenceIds?: string[];
    }>(),
    currentRevisionId: text("current_revision_id")
      .references((): AnyPgColumn => communityEventSocialRevisions.id, { onDelete: "set null" }),
    replacementCount: integer("replacement_count").notNull().default(0),
    status: text("status").notNull().default("draft"),
    initialReviewEligibleAt: timestamp("initial_review_eligible_at", { withTimezone: true }),
    finalDataMode: text("final_data_mode"),
    initialReviewerAdminId: text("initial_reviewer_admin_id").references(() => user.id, { onDelete: "set null" }),
    initialReviewedAt: timestamp("initial_reviewed_at", { withTimezone: true }),
    initialReviewReason: text("initial_review_reason"),
    finalReviewerAdminId: text("final_reviewer_admin_id").references(() => user.id, { onDelete: "set null" }),
    finalReviewedAt: timestamp("final_reviewed_at", { withTimezone: true }),
    finalReviewReason: text("final_review_reason"),
    riskFlags: jsonb("risk_flags").$type<string[]>().notNull().default([]),
    verifiedScore: integer("verified_score"),
    platformEntitlement: integer("platform_entitlement"),
    membershipPlanId: text("membership_plan_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("community_event_social_entries_event_user_platform_uniq").on(t.eventId, t.userId, t.platform),
    unique("community_event_social_entries_event_platform_account_uniq").on(t.eventId, t.platform, t.normalizedAccountKey),
    index("community_event_social_entries_event_status_idx").on(t.eventId, t.status, t.createdAt),
    index("community_event_social_entries_user_idx").on(t.userId, t.createdAt),
    index("community_event_social_entries_initial_review_idx").on(t.eventId, t.initialReviewEligibleAt, t.status),
    check("community_event_social_entries_replacement_count_check", sql`${t.replacementCount} BETWEEN 0 AND 1`),
    check("community_event_social_entries_version_check", sql`${t.version} >= 1`),
    check("community_event_social_entries_score_check", sql`${t.verifiedScore} IS NULL OR ${t.verifiedScore} >= 0`),
    check("community_event_social_entries_entitlement_check", sql`${t.platformEntitlement} IS NULL OR ${t.platformEntitlement} BETWEEN 0 AND 15000`),
    check("community_event_social_entries_membership_check", sql`${t.membershipPlanId} IS NULL OR ${t.membershipPlanId} IN ('go','plus','pro','ultra')`),
    check("community_event_social_entries_status_check", sql`${t.status} IN ('draft','submitted','under_initial_review','needs_changes','initial_approved','initial_rejected','under_final_review','settled','disqualified')`),
    check("community_event_social_entries_final_mode_check", sql`${t.finalDataMode} IS NULL OR ${t.finalDataMode} IN ('user_evidence','official_link_check')`),
    check("community_event_social_entries_platform_check", sql`${t.platform} IN ('xiaohongshu','douyin','weibo','bilibili','kuaishou','tiktok','instagram','youtube','x','threads','reddit')`),
  ]
);

export const communityEventSocialRevisions = pgTable(
  "community_event_social_revisions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id").notNull().references(() => communityEvents.id, { onDelete: "cascade" }),
    entryId: text("entry_id").notNull().references(() => communityEventSocialEntries.id, { onDelete: "cascade" }),
    revisionNo: integer("revision_no").notNull(),
    changeKind: text("change_kind").notNull(),
    rawUrl: text("raw_url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    canonicalPostKey: text("canonical_post_key").notNull(),
    postPublishedAt: timestamp("post_published_at", { withTimezone: true }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    rulesVersion: integer("rules_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("community_event_social_revisions_entry_revision_uniq").on(t.entryId, t.revisionNo),
    uniqueIndex("community_event_social_revisions_event_post_current_uniq")
      .on(t.eventId, t.canonicalPostKey)
      .where(sql`${t.supersededAt} IS NULL`),
    index("community_event_social_revisions_entry_idx").on(t.entryId, t.submittedAt),
    uniqueIndex("community_event_social_revisions_current_uniq")
      .on(t.entryId)
      .where(sql`${t.supersededAt} IS NULL`),
    check("community_event_social_revisions_revision_no_check", sql`${t.revisionNo} >= 1`),
    check("community_event_social_revisions_rules_version_check", sql`${t.rulesVersion} >= 1`),
    check("community_event_social_revisions_change_kind_check", sql`${t.changeKind} IN ('initial','correction','replacement')`),
  ]
);

/** Durable ownership of every post ever used in an event, including replaced posts. */
export const communityEventSocialPostClaims = pgTable(
  "community_event_social_post_claims",
  {
    eventId: text("event_id").notNull().references(() => communityEvents.id, { onDelete: "cascade" }),
    canonicalPostKey: text("canonical_post_key").notNull(),
    entryId: text("entry_id").notNull().references(() => communityEventSocialEntries.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "community_event_social_post_claims_pk", columns: [t.eventId, t.canonicalPostKey] }),
    index("community_event_social_post_claims_entry_idx").on(t.entryId, t.claimedAt),
  ]
);

export const communityEventSocialEvidence = pgTable(
  "community_event_social_evidence",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id").notNull().references(() => communityEvents.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    entryId: text("entry_id").references(() => communityEventSocialEntries.id, { onDelete: "cascade" }),
    revisionId: text("revision_id").references(() => communityEventSocialRevisions.id, { onDelete: "set null" }),
    purpose: text("purpose").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    checksum: text("checksum"),
    status: text("status").notNull().default("uploading"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    boundAt: timestamp("bound_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("community_event_social_evidence_owner_status_idx").on(t.ownerId, t.status, t.createdAt),
    index("community_event_social_evidence_event_idx").on(t.eventId, t.createdAt),
    index("community_event_social_evidence_entry_idx").on(t.entryId, t.purpose),
    index("community_event_social_evidence_expiry_idx").on(t.status, t.expiresAt),
    check("community_event_social_evidence_size_check", sql`${t.sizeBytes} > 0`),
    check("community_event_social_evidence_purpose_check", sql`${t.purpose} IN ('initial','final_metrics','admin_capture')`),
    check("community_event_social_evidence_status_check", sql`${t.status} IN ('uploading','ready','attached','deleted')`),
  ]
);

export const communityEventSocialMetricSnapshots = pgTable(
  "community_event_social_metric_snapshots",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id").notNull().references(() => communityEvents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    entryId: text("entry_id").notNull().references(() => communityEventSocialEntries.id, { onDelete: "cascade" }),
    revisionId: text("revision_id").references(() => communityEventSocialRevisions.id, { onDelete: "set null" }),
    resolution: text("resolution").notNull(),
    likes: integer("likes").notNull().default(0),
    favorites: integer("favorites").notNull().default(0),
    validComments: integer("valid_comments").notNull().default(0),
    shares: integer("shares").notNull().default(0),
    linkStatus: text("link_status").notNull().default("unknown"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default([]),
    reviewerAdminId: text("reviewer_admin_id").references(() => user.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    score: integer("score").notNull(),
    platformEntitlement: integer("platform_entitlement").notNull(),
    membershipPlanId: text("membership_plan_id"),
    rulesVersion: integer("rules_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("community_event_social_metric_snapshots_entry_idx").on(t.entryId, t.verifiedAt),
    index("community_event_social_metric_snapshots_event_idx").on(t.eventId, t.verifiedAt),
    check("community_event_social_metric_snapshots_metrics_check", sql`${t.likes} >= 0 AND ${t.favorites} >= 0 AND ${t.validComments} >= 0 AND ${t.shares} >= 0`),
    check("community_event_social_metric_snapshots_score_check", sql`${t.score} >= 0`),
    check("community_event_social_metric_snapshots_entitlement_check", sql`${t.platformEntitlement} BETWEEN 0 AND 15000`),
    check("community_event_social_metric_snapshots_resolution_check", sql`${t.resolution} IN ('user_evidence','official_link_check','unverifiable')`),
    check("community_event_social_metric_snapshots_link_status_check", sql`${t.linkStatus} IN ('unknown','accessible','unavailable','not_public')`),
    check("community_event_social_metric_snapshots_membership_check", sql`${t.membershipPlanId} IS NULL OR ${t.membershipPlanId} IN ('go','plus','pro','ultra')`),
    check("community_event_social_metric_snapshots_rules_version_check", sql`${t.rulesVersion} >= 1`),
    check("community_event_social_metric_snapshots_unverifiable_check", sql`${t.resolution} <> 'unverifiable' OR (${t.likes} = 0 AND ${t.favorites} = 0 AND ${t.validComments} = 0 AND ${t.shares} = 0 AND ${t.score} = 0)`),
    check("community_event_social_metric_snapshots_user_evidence_check", sql`${t.resolution} <> 'user_evidence' OR jsonb_array_length(${t.evidenceIds}) > 0`),
  ]
);

export const communityEventSocialSettlements = pgTable(
  "community_event_social_settlements",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id").notNull().references(() => communityEvents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("draft"),
    version: integer("version").notNull().default(1),
    totalEntitlement: integer("total_entitlement").notNull().default(0),
    committedMushies: integer("committed_mushies").notNull().default(0),
    finalDueMushies: integer("final_due_mushies").notNull().default(0),
    highestPlanId: text("highest_plan_id"),
    membershipDurationDays: integer("membership_duration_days").notNull().default(0),
    calculationSnapshot: jsonb("calculation_snapshot").$type<SocialPlatformSettlement[]>().notNull().default([]),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    approvedByAdminId: text("approved_by_admin_id").references(() => user.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("community_event_social_settlements_event_user_uniq").on(t.eventId, t.userId),
    index("community_event_social_settlements_event_status_idx").on(t.eventId, t.status, t.updatedAt),
    index("community_event_social_settlements_user_idx").on(t.userId, t.updatedAt),
    check("community_event_social_settlements_version_check", sql`${t.version} >= 1`),
    check("community_event_social_settlements_total_check", sql`${t.totalEntitlement} BETWEEN 0 AND 75000`),
    check("community_event_social_settlements_committed_check", sql`${t.committedMushies} BETWEEN 0 AND 75000`),
    check("community_event_social_settlements_due_check", sql`${t.finalDueMushies} BETWEEN 0 AND 75000`),
    check("community_event_social_settlements_duration_check", sql`${t.membershipDurationDays} BETWEEN 0 AND 30`),
    check("community_event_social_settlements_status_check", sql`${t.status} IN ('draft','pending','processing','completed','failed','cancelled')`),
    check("community_event_social_settlements_plan_check", sql`${t.highestPlanId} IS NULL OR ${t.highestPlanId} IN ('go','plus','pro','ultra')`),
  ]
);

export const planEntitlements = pgTable(
  "plan_entitlements",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    planId: text("plan_id").notNull(),
    source: text("source").notNull().default("event"),
    sourceId: text("source_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    durationDays: integer("duration_days").notNull(),
    remainingDurationSeconds: integer("remaining_duration_seconds").notNull(),
    status: text("status").notNull().default("queued"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("plan_entitlements_user_status_idx").on(t.userId, t.status, t.createdAt),
    index("plan_entitlements_source_idx").on(t.source, t.sourceId),
    uniqueIndex("plan_entitlements_event_user_uniq")
      .on(t.source, t.sourceId, t.userId)
      .where(sql`${t.source} = 'event'`),
    uniqueIndex("plan_entitlements_one_active_per_user_uniq")
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
    check("plan_entitlements_duration_check", sql`${t.durationDays} > 0 AND ${t.remainingDurationSeconds} >= 0`),
    check("plan_entitlements_plan_check", sql`${t.planId} IN ('go','plus','pro','ultra')`),
    // Relaxed 2026-07-19 (scripts/relax-plan-entitlement-sources.sql): admin +
    // referral time-limited grants live on this overlay too, so wallet.plan
    // stays strictly the PAID tier and grants can never fight billing state.
    check("plan_entitlements_source_check", sql`${t.source} IN ('event','admin','referral')`),
    check("plan_entitlements_status_check", sql`${t.status} IN ('queued','active','consumed','cancelled')`),
  ]
);

export const communityEventRewardGrants = pgTable(
  "community_event_reward_grants",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id").notNull().references(() => communityEvents.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform"),
    entryId: text("entry_id").references(() => communityEventSocialEntries.id, { onDelete: "set null" }),
    settlementId: text("settlement_id").references(() => communityEventSocialSettlements.id, { onDelete: "set null" }),
    phase: text("phase").notNull(),
    purpose: text("purpose"),
    kind: text("kind").notNull(),
    amount: integer("amount"),
    planId: text("plan_id"),
    durationDays: integer("duration_days"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    creditTransactionId: text("credit_transaction_id").references(() => creditTransactions.id, { onDelete: "set null" }),
    planEntitlementId: text("plan_entitlement_id").references(() => planEntitlements.id, { onDelete: "set null" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("community_event_reward_grants_event_status_idx").on(t.eventId, t.status, t.createdAt),
    index("community_event_reward_grants_user_idx").on(t.userId, t.createdAt),
    index("community_event_reward_grants_entry_idx").on(t.entryId, t.phase),
    index("community_event_reward_grants_settlement_idx").on(t.settlementId, t.phase),
    index("community_event_reward_grants_purpose_status_idx").on(t.purpose, t.status, t.createdAt),
    check("community_event_reward_grants_attempt_check", sql`${t.attemptCount} >= 0`),
    check("community_event_reward_grants_amount_check", sql`${t.amount} IS NULL OR ${t.amount} BETWEEN -75000 AND 75000`),
    check("community_event_reward_grants_phase_check", sql`${t.phase} IN ('initial','final','adjustment','reversal')`),
    check("community_event_reward_grants_purpose_check", sql`${t.purpose} IS NULL OR ${t.purpose} IN ('verified_settlement_floor')`),
    check("community_event_reward_grants_kind_check", sql`${t.kind} IN ('mushies','plan')`),
    check("community_event_reward_grants_status_check", sql`${t.status} IN ('pending','processing','applied','failed','cancelled','reversed')`),
    check("community_event_reward_grants_plan_check", sql`${t.planId} IS NULL OR ${t.planId} IN ('go','plus','pro','ultra')`),
    check("community_event_reward_grants_platform_check", sql`${t.platform} IS NULL OR ${t.platform} IN ('xiaohongshu','douyin','weibo','bilibili','kuaishou','tiktok','instagram','youtube','x','threads','reddit')`),
    check("community_event_reward_grants_payload_check", sql`(
      (${t.kind} = 'mushies' AND ${t.amount} IS NOT NULL AND ${t.planId} IS NULL AND ${t.durationDays} IS NULL)
      OR
      (${t.kind} = 'plan' AND ${t.amount} IS NULL AND ${t.planId} IS NOT NULL AND ${t.durationDays} IS NOT NULL)
    )`),
  ]
);

export const communityEventSubmissions = pgTable(
  "community_event_submissions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    eventId: text("event_id").notNull().references(() => communityEvents.id, { onDelete: "cascade" }),
    submitterId: text("submitter_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    // Keep rewarded submission history if the submitted world or account is
    // deleted so reward eligibility cannot be reset.
    worldId: text("world_id").references(() => worlds.id, { onDelete: "set null" }),
    enforcesSingleSubmission: boolean("enforces_single_submission").notNull().default(false),
    status: text("status").notNull().default("pending"),
    adminComment: text("admin_comment"),
    rewardType: text("reward_type"),
    rewardAmount: integer("reward_amount"),
    rewardPlanId: text("reward_plan_id"),
    rewardDurationDays: integer("reward_duration_days"),
    reviewerAdminId: text("reviewer_admin_id").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("community_event_submissions_event_status_idx").on(t.eventId, t.status, t.createdAt),
    index("community_event_submissions_submitter_idx").on(t.submitterId, t.createdAt),
    index("community_event_submissions_world_idx").on(t.worldId),
    index("community_event_submissions_reviewer_idx").on(t.reviewerAdminId, t.reviewedAt),
    uniqueIndex("community_event_submissions_single_user_uniq")
      .on(t.eventId, t.submitterId)
      .where(sql`${t.enforcesSingleSubmission} = true`),
  ]
);

// ─── Editorial curation ─────────────────────────────────────────────

export const editorialBoosts = pgTable("editorial_boosts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  // XOR-enforced at DB layer: exactly one of worldId or languageGroupId must be set.
  worldId: text("world_id").references(() => worlds.id, { onDelete: "cascade" }),
  languageGroupId: text("language_group_id"),
  scoreBoost: real("score_boost").notNull(),
  note: text("note"),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  index("editorial_boosts_world_id_idx").on(t.worldId),
  index("editorial_boosts_language_group_id_idx").on(t.languageGroupId),
]);

export const featuredWorlds = pgTable("featured_worlds", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
  slot: integer("slot").notNull(), // 0..4 for current 5-slot bento layout
  note: text("note"),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  unique().on(t.slot), // one world per slot
  index("featured_worlds_slot_idx").on(t.slot),
]);

/** The big hero carousel at the top of the hub page ("精选世界"). Different
 * shape from `featuredWorlds` because hero is per-language and accepts
 * either a specific world or a whole language group as a slot target.
 * XOR check on the (worldId, languageGroupId) pair is enforced at the DB
 * layer (see migration 0028). */
export const featuredHeroWorlds = pgTable("featured_hero_worlds", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  language: text("language").notNull(), // 'zh' | 'en'
  slot: integer("slot").notNull(),
  kind: text("kind").notNull(),         // 'world' | 'group'
  worldId: text("world_id").references(() => worlds.id, { onDelete: "cascade" }),
  languageGroupId: text("language_group_id"),
  note: text("note"),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [
  unique("featured_hero_worlds_lang_slot_unique").on(t.language, t.slot),
  index("featured_hero_worlds_lang_slot_idx").on(t.language, t.slot),
]);

// ─── Feed training log (recsys Ship 1) ──────────────────────────────
// The recommender's feedback loop. Every hub serve, viewport-confirmed
// impression, click, and play lands here so ranking quality is finally
// measurable AND trainable from our own database (previously this funnel
// existed only in PostHog and could never join back to worlds/users).
// All tables are append-only + pruned on a rolling window by the rollup
// interval; none participate in user-facing reads except through the
// aggregated `world_engagement_stats`.

/** One row per /hub response actually sent to a client. `id` IS the
 * feedRequestId echoed by client events — the join key of the whole log.
 * world_ids is the ordered slate (rank order), so "shown at position p"
 * is reconstructable even when the client beacon is lost. 30d retention. */
export const feedServes = pgTable("feed_serves", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  surface: text("surface").notNull(),
  feed: text("feed").notNull(),
  tier: text("tier"),
  /** Ranking experiment arm that produced this slate ("control" | "engage_v1" | …). */
  variant: text("variant").notNull().default("control"),
  lang: text("lang"),
  offset: integer("offset").notNull().default(0),
  worldIds: jsonb("world_ids").$type<string[]>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("feed_serves_created_idx").on(t.createdAt),
  index("feed_serves_user_idx").on(t.userId, t.createdAt),
]);

/** Client-beacon events: viewport-confirmed impressions (≥500ms, ≥50%
 * visible — same rule as the PostHog hub_impression), card clicks, and
 * play starts. `position` is the slate rank at emit time. 90d retention.
 * This is the label stream for CTR priors today and the learned ranker
 * next — treat as append-only, never user-facing. */
export const feedEvents = pgTable("feed_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  feedRequestId: text("feed_request_id"),
  userId: text("user_id"),
  worldId: text("world_id").notNull(),
  eventType: text("event_type").notNull(), // 'impression' | 'click' | 'play'
  position: integer("position"),
  surface: text("surface"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("feed_events_world_idx").on(t.worldId, t.createdAt),
  index("feed_events_user_idx").on(t.userId, t.createdAt),
  index("feed_events_created_idx").on(t.createdAt),
]);

/** Per-world engagement aggregates consumed by the ranker (via a 5-min
 * Redis snapshot). Feed-side columns (impressions/clicks) are refreshed
 * from feed_events once that log has ≥3 days of history — until then they
 * hold the PostHog-backfilled seed. Play-side columns come from
 * play_sessions and are always live. Velocity is derived at score time
 * from plays_7d vs plays_prev_7d, not stored. */
export const worldEngagementStats = pgTable("world_engagement_stats", {
  worldId: text("world_id").primaryKey(),
  impressions7d: integer("impressions_7d").notNull().default(0),
  clicks7d: integer("clicks_7d").notNull().default(0),
  playsStarted7d: integer("plays_started_7d").notNull().default(0),
  /** Sessions created in the last 7d that reached ≥300s playtime — the
   * "qualified play" bar (Roblox qPTR analog). */
  qualifiedPlays7d: integer("qualified_plays_7d").notNull().default(0),
  playsPrev7d: integer("plays_prev_7d").notNull().default(0),
  impressionsTotal: integer("impressions_total").notNull().default(0),
  clicksTotal: integer("clicks_total").notNull().default(0),
  /** Retention-proven cold-start signals (30d): distinct users who came back
   * (≥2 sessions) and total capped playtime. Rank the new-user/guest feed by
   * these so it surfaces worlds people actually return to, not just the
   * most-downloaded (which is dominated by a handful of idol-group sims). */
  returners30d: integer("returners_30d").notNull().default(0),
  totalPlayMinutes30d: integer("total_play_minutes_30d").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Nightly-trained LightGBM ranker models (Ship 2). The trainer INSERTs a
 * row only when the candidate beats the live baseline on a held-out day;
 * the server loads the newest 'published' row and serves it under the
 * engage_v2 arm via the pure-TS evaluator in lib/ranker-model.ts. */
export const rankerModels = pgTable("ranker_models", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  status: text("status").notNull().default("published"), // 'published' | 'rejected' | 'retired'
  model: jsonb("model").notNull(),
  featureNames: jsonb("feature_names").$type<string[]>().notNull(),
  metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
  trainedAt: timestamp("trained_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("ranker_models_status_idx").on(t.status, t.id),
]);

/** ALS matrix-factorization item-item neighbors ("users who played X also
 * played Y"), refreshed nightly by the trainer. Feeds the co_played recall
 * route. rank = 1-based neighbor order per world. */
export const worldSimilarities = pgTable("world_similarities", {
  worldId: text("world_id").notNull(),
  similarWorldId: text("similar_world_id").notNull(),
  score: real("score").notNull(),
  rank: integer("rank").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.worldId, t.similarWorldId] }),
  index("world_similarities_world_idx").on(t.worldId, t.rank),
]);

/** ALS latent factors (Ship 4): the user↔world matrix factorization vectors
 * themselves (unit-normalized, 64-dim as a JSON array), refreshed nightly by
 * the trainer. Serving scores behavioral taste affinity by the dot product
 * of a user's vector with a world's — the collaborative-filtering signal that
 * finds cross-genre connections tags don't encode. Separate tables (not one
 * matrix) so the per-user lookup is a single PK read and the world set loads
 * as one cached snapshot. */
export const worldLatentFactors = pgTable("world_latent_factors", {
  worldId: text("world_id").primaryKey(),
  factors: jsonb("factors").$type<number[]>().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userLatentFactors = pgTable("user_latent_factors", {
  userId: text("user_id").primaryKey(),
  factors: jsonb("factors").$type<number[]>().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Explicit "not interested" — the strongest negative signal we collect.
 * Hard-excludes the world from the user's recommended feed (search still
 * finds it by name, same carve-out as library exclusions). */
export const worldDismissals = pgTable("world_dismissals", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.worldId] }),
  index("world_dismissals_user_idx").on(t.userId),
]);

// ─── World Review Submissions ───────────────────────────────────────
// Append-only history of every submit/approve/reject/withdraw decision.
// `worlds` carries the latest summary; this table carries the audit trail.

export const worldReviewSubmissions = pgTable(
  "world_review_submissions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    // Moderation history survives world deletion; rejected creators require
    // support-assisted account deletion instead of resetting their record.
    worldId: text("world_id")
      .references(() => worlds.id, { onDelete: "set null" }),
    // Used to collapse all variants of a multilanguage submission into one
    // queue entry. Equals languageGroupId when present, else equals worldId.
    groupKey: text("group_key").notNull(),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    submittedAt: timestamp("submitted_at").notNull().defaultNow(),
    decision: text("decision").notNull().default("pending"),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at"),
    rejectionReason: text("rejection_reason"),
    rejectionDetail: text("rejection_detail"),
    // Admin "ignore" — parks a pending submission out of the queue WITHOUT
    // deciding it. `decision` deliberately stays 'pending' so no author-facing
    // surface (e.g. /worlds/:id/review-history) ever reveals the ignore. Only
    // admins see ignored_at; the author keeps seeing "pending review".
    ignoredAt: timestamp("ignored_at"),
    ignoredBy: text("ignored_by").references(() => user.id, { onDelete: "set null" }),
    // "initial" = first publish of a draft/unpublished/rejected world (the world
    // itself sits at status='pending_review'). "edit" = a held material change to
    // an ALREADY-PUBLISHED world (the world stays status='published' and live;
    // the proposed content lives in world_pending_edits). Both feed the same
    // admin queue; approve/reject branch on which kind a group contains.
    submissionType: text("submission_type").notNull().default("initial"),
    // Snapshot of publish settings at submission time so the admin sees what
    // the author actually intended to publish, even if the author edits after
    // withdraw + resubmit.
    snapshotAgeRating: text("snapshot_age_rating"),
    snapshotIsNsfw: boolean("snapshot_is_nsfw"),
    snapshotTargetAudience: text("snapshot_target_audience"),
    snapshotVisibility: text("snapshot_visibility"),
    snapshotAllowEdit: boolean("snapshot_allow_edit"),
    snapshotAllowReviews: boolean("snapshot_allow_reviews"),
  },
  (t) => [
    index("world_review_submissions_decision_idx").on(t.decision, t.submittedAt),
    index("world_review_submissions_group_idx").on(t.groupKey, t.decision),
    index("world_review_submissions_ignored_idx").on(t.groupKey, t.ignoredAt),
    index("world_review_submissions_world_idx").on(t.worldId, t.submittedAt),
    index("world_review_submissions_submitter_idx").on(t.submittedBy, t.submittedAt),
  ],
);

// ─── World Pending Edits ────────────────────────────────────────────
// A held material change to an already-published world. The live `worlds` row
// keeps serving the last-approved content to players; the creator's proposed
// edit to any of the four material surfaces (lorebook entries, frontend
// rootComponent, age rating, cover) is parked here until an admin approves it.
// On approve the proposed values are committed back onto `worlds` (and the row
// cleared); on reject the row is kept (status='rejected') so the creator can
// revise and resubmit. At most one row per world (1:1).
export const worldPendingEdits = pgTable(
  "world_pending_edits",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    worldId: text("world_id")
      .notNull()
      .unique()
      .references(() => worlds.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Mirrors the review-queue grouping convention: languageGroupId ?? worldId.
    groupKey: text("group_key").notNull(),
    // Full proposed WorldDefinition (the creator's working copy of the schema).
    schema: jsonb("schema").$type<Record<string, unknown>>().notNull(),
    // Version switches keep the working draft separate even for non-material edits.
    preserveDraft: boolean("preserve_draft").notNull().default(false),
    // Proposed cover + rating. Null means "unchanged from the live value".
    thumbnailUrl: text("thumbnail_url"),
    ageRating: text("age_rating"),
    isNsfw: boolean("is_nsfw"),
    // Which of the four material surfaces diverged from live, as a stable list of
    // MaterialChangeReason values ("entries" | "frontend" | "ageRating" | "cover").
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    // Optional "what's new" note the creator writes for players. Held with the
    // edit and posted to world_updates (notifying library users) only when the
    // edit is APPROVED and goes live — never while it's still pending/unreviewed.
    updateTitle: text("update_title"),
    updateContent: text("update_content"),
    updateIsMajor: boolean("update_is_major").notNull().default(false),
    // 'draft'    — held, not yet submitted to the admin queue
    // 'pending'  — submitted, awaiting admin decision
    // 'rejected' — admin rejected; creator may revise (edits move it back to draft)
    status: text("status").notNull().default("draft"),
    submittedAt: timestamp("submitted_at"),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at"),
    rejectionReason: text("rejection_reason"),
    rejectionDetail: text("rejection_detail"),
    // The worlds.updatedAt this edit was last diffed against. Recorded for audit
    // and a possible future staleness guard; not currently read anywhere. (The
    // creator can't drift the held MATERIAL content under review — editing
    // supersedes the submission back to draft — so a baseline check isn't needed
    // for safety; it would only sharpen the admin diff against non-material drift.)
    baseUpdatedAt: timestamp("base_updated_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("world_pending_edits_status_idx").on(t.status, t.submittedAt),
    index("world_pending_edits_group_idx").on(t.groupKey, t.status),
  ],
);

// ─── Measured per-reply cost per model (2026-09-17) ─────────────────
// Written nightly by lib/model-cost-stats.ts from the last 7 days of real
// official replies; read by GET /api/models so the picker shows a measured range
// instead of a hard-coded average. scripts/model-cost-stats.sql is the DDL.
export const modelCostStats = pgTable("model_cost_stats", {
  modelId: text("model_id").primaryKey(),
  windowDays: integer("window_days").notNull(),
  turns: integer("turns").notNull(),
  medianCredits: real("median_credits").notNull(),
  p25Credits: real("p25_credits").notNull(),
  p75Credits: real("p75_credits").notNull(),
  p90Credits: real("p90_credits").notNull(),
  medianPromptTokens: integer("median_prompt_tokens").notNull(),
  medianOutputTokens: integer("median_output_tokens").notNull(),
  /** Share of a typical reply's cost that is the prompt (from list prices at the median sizes). */
  inputShare: real("input_share").notNull(),
  /** Share of the previous day's replies inside the [p25, p90] band that was on screen. */
  coverage24h: real("coverage_24h"),
  computedAt: timestamp("computed_at").notNull().defaultNow(),
});
