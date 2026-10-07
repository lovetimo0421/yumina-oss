// Additive and idempotent, so old application replicas can finish serving while
// the testing deployment starts. No content is rewritten or deleted here.
export const WORLD_VERSION_SCHEMA_SQL = `

CREATE TABLE IF NOT EXISTS "world_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "world_id" text NOT NULL REFERENCES "worlds"("id") ON DELETE CASCADE,
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "note" text,
  "schema" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "world_versions_world_id_idx" ON "world_versions" ("world_id");
CREATE INDEX IF NOT EXISTS "world_versions_world_created_idx" ON "world_versions" ("world_id", "created_at");

CREATE TABLE IF NOT EXISTS "world_pending_edits" (
  "id" text PRIMARY KEY NOT NULL,
  "world_id" text NOT NULL REFERENCES "worlds"("id") ON DELETE CASCADE,
  "created_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "group_key" text NOT NULL,
  "schema" jsonb NOT NULL,
  "thumbnail_url" text,
  "age_rating" text,
  "is_nsfw" boolean,
  "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "submitted_at" timestamp,
  "reviewed_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp,
  "rejection_reason" text,
  "rejection_detail" text,
  "base_updated_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "world_pending_edits_world_id_unique" ON "world_pending_edits" ("world_id");
CREATE INDEX IF NOT EXISTS "world_pending_edits_status_idx" ON "world_pending_edits" ("status", "submitted_at");
CREATE INDEX IF NOT EXISTS "world_pending_edits_group_idx" ON "world_pending_edits" ("group_key", "status");

ALTER TABLE world_pending_edits ADD COLUMN IF NOT EXISTS update_title text;
ALTER TABLE world_pending_edits ADD COLUMN IF NOT EXISTS update_content text;
ALTER TABLE world_pending_edits ADD COLUMN IF NOT EXISTS update_is_major boolean NOT NULL DEFAULT false;

ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS published_at timestamp;
ALTER TABLE world_pending_edits ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS thumbnail_url text;
ALTER TABLE world_versions ADD COLUMN IF NOT EXISTS age_rating text;
ALTER TABLE world_pending_edits ADD COLUMN IF NOT EXISTS preserve_draft boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS world_versions_world_hash_idx ON world_versions(world_id, content_hash);
`;

/** The worlds table as the app builds it, for tests that stand a database up
 *  by hand. Generated from db/index.ts so a column added there cannot quietly
 *  leave a hand-written test table behind. */
export const WORLDS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    name TEXT NOT NULL, description TEXT DEFAULT '', extended_description TEXT,
    schema JSONB NOT NULL DEFAULT '{}', thumbnail_url TEXT,
    is_published BOOLEAN DEFAULT false, status TEXT NOT NULL DEFAULT 'draft',
    is_nsfw BOOLEAN DEFAULT false, allow_edit BOOLEAN DEFAULT true,
    allow_custom_api BOOLEAN NOT NULL DEFAULT true,
    allow_reviews BOOLEAN NOT NULL DEFAULT true,
    allow_live_canon BOOLEAN NOT NULL DEFAULT false,
    allow_live_canon_additions BOOLEAN NOT NULL DEFAULT false,
    age_rating TEXT NOT NULL DEFAULT 'all', visibility TEXT NOT NULL DEFAULT 'public',
    download_count INTEGER NOT NULL DEFAULT 0,
    tags JSONB NOT NULL DEFAULT '[]', gallery_images JSONB DEFAULT '[]',
    announcement TEXT, total_tokens INTEGER DEFAULT 0, approx_time TEXT,
    source_world_id TEXT,
    custom_ui_loc INTEGER, has_audio BOOLEAN, cover_crop JSONB, gallery_cover_crop JSONB, landscape_cover_url TEXT, landscape_cover_crop JSONB,
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT worlds_tags_max CHECK (jsonb_array_length(tags) <= 10)
);
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS custom_ui_loc INTEGER;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS has_audio BOOLEAN;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS cover_crop JSONB;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS gallery_cover_crop JSONB;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS landscape_cover_url TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS landscape_cover_crop JSONB;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS multilanguage_overview JSONB;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS favorite_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS average_rating REAL NOT NULL DEFAULT 0;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS moderation_note TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS moderation_action TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_reviews BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_custom_api BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_live_canon BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_live_canon_additions BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS blur_cover BOOLEAN;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS language_group_id TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS variant_label TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS is_primary_variant BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_community_citations BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS allow_session_sharing BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS target_audience TEXT NOT NULL DEFAULT 'all';
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS game_path TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS review_status TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS submitted_for_review_at TIMESTAMP;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS rejection_detail TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS public_id TEXT;

ALTER TABLE worlds ADD COLUMN IF NOT EXISTS search_doc TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS search_doc_normalized TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS embedding TEXT;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMP;
`;
