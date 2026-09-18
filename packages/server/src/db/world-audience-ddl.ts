import { MAX_WORLD_TAGS } from "@yumina/shared";

// Keep the CHECK in schema.ts in sync. Both representations are public API:
// publish settings use target_audience, while discovery uses the tags.
export const WORLD_AUDIENCE_VALID_SQL = `
  target_audience IN ('all', 'male', 'female')
  AND (tags @> '["男性向"]'::jsonb AND NOT tags @> '["女性向"]'::jsonb) = (target_audience = 'male')
  AND (tags @> '["女性向"]'::jsonb AND NOT tags @> '["男性向"]'::jsonb) = (target_audience = 'female')
`;

/** Shared by startup and the one-off installer; run in a transaction. */
export const WORLD_AUDIENCE_DDL = `
SELECT pg_advisory_xact_lock(hashtext('yumina-world-audience-v1'));

DO $column$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'worlds'::regclass
    AND attname = 'target_audience' AND NOT attisdropped) THEN
    ALTER TABLE worlds ADD COLUMN target_audience TEXT NOT NULL DEFAULT 'all';
  END IF;
END;
$column$;

CREATE OR REPLACE FUNCTION worlds_tags_with_audience(input_tags JSONB, audience TEXT)
RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $fn$
  SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
    || CASE audience
      WHEN 'male' THEN '["男性向"]'::jsonb
      WHEN 'female' THEN '["女性向"]'::jsonb
      WHEN 'all' THEN CASE
        WHEN input_tags @> '["男性向","女性向"]'::jsonb THEN '["男性向","女性向"]'::jsonb
        ELSE '[]'::jsonb END
      ELSE '[]'::jsonb
    END
  FROM (
    SELECT elem, ord
    FROM jsonb_array_elements(input_tags) WITH ORDINALITY AS t(elem, ord)
    WHERE elem NOT IN ('"男性向"'::jsonb, '"女性向"'::jsonb)
    ORDER BY ord
    LIMIT ${MAX_WORLD_TAGS} - CASE
      WHEN audience IN ('male', 'female') THEN 1
      WHEN audience = 'all' AND input_tags @> '["男性向","女性向"]'::jsonb THEN 2
      ELSE 0 END
  ) rest;
$fn$;

CREATE OR REPLACE FUNCTION worlds_sync_audience()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  has_male BOOLEAN;
  has_female BOOLEAN;
  audience_changed BOOLEAN := false;
BEGIN
  IF NEW.target_audience IS NULL OR NEW.target_audience NOT IN ('all', 'male', 'female') THEN
    RAISE EXCEPTION 'Invalid world target audience' USING ERRCODE = '23514';
  END IF;
  has_male := NEW.tags @> '["男性向"]'::jsonb;
  has_female := NEW.tags @> '["女性向"]'::jsonb;
  IF TG_OP = 'UPDATE' THEN
    audience_changed := NEW.target_audience IS DISTINCT FROM OLD.target_audience;
  END IF;

  -- Both explicit tags describe a card for both audiences, even when a caller
  -- sends a stale single-audience settings field. Preserve both and use all.
  -- Otherwise explicit audience changes win, including selecting all.
  -- Imports/copies recover a single existing tag when the column is omitted.
  -- Removing one of two tags adopts the remaining one; deleting the last
  -- single tag must not silently broaden a male/female world.
  IF has_male AND has_female THEN
    NEW.target_audience := 'all';
  ELSIF NOT audience_changed AND (
    (TG_OP = 'INSERT' AND NEW.target_audience = 'all') OR
    (TG_OP = 'UPDATE' AND NEW.tags IS DISTINCT FROM OLD.tags)
  ) THEN
    IF has_male AND NOT has_female THEN NEW.target_audience := 'male';
    ELSIF has_female AND NOT has_male THEN NEW.target_audience := 'female';
    END IF;
  END IF;
  NEW.tags := worlds_tags_with_audience(NEW.tags, NEW.target_audience);
  RETURN NEW;
END;
$fn$;

DO $install$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'worlds'::regclass
      AND tgname = 'worlds_audience_sync_trg' AND tgenabled = 'O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'worlds'::regclass
      AND conname = 'worlds_audience_consistent_v2' AND convalidated
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'worlds'::regclass
      AND conname = 'worlds_audience_consistent'
  ) THEN
    -- Install + reconcile atomically, so concurrent saves cannot slip between
    -- the backfill and the invariant. Leave updated_at untouched: maintenance
    -- must not resurface thousands of old cards in Newest.
    LOCK TABLE worlds IN SHARE ROW EXCLUSIVE MODE;
    -- v1 forbids dual tags even after the trigger is updated. Drop it in the
    -- same locked transaction before reconciling and validating v2.
    ALTER TABLE worlds DROP CONSTRAINT IF EXISTS worlds_audience_consistent;
    DROP TRIGGER IF EXISTS worlds_audience_sync_trg ON worlds;
    CREATE TRIGGER worlds_audience_sync_trg
      BEFORE INSERT OR UPDATE OF tags, target_audience ON worlds
      FOR EACH ROW EXECUTE FUNCTION worlds_sync_audience();

    WITH repairs AS (
      SELECT id, CASE
        WHEN tags @> '["男性向","女性向"]'::jsonb THEN 'all'
        WHEN target_audience IN ('male', 'female') THEN target_audience
        WHEN tags @> '["男性向"]'::jsonb AND NOT tags @> '["女性向"]'::jsonb THEN 'male'
        WHEN tags @> '["女性向"]'::jsonb AND NOT tags @> '["男性向"]'::jsonb THEN 'female'
        ELSE 'all'
      END AS audience
      FROM worlds WHERE NOT (${WORLD_AUDIENCE_VALID_SQL})
    )
    UPDATE worlds w SET target_audience = r.audience,
      tags = worlds_tags_with_audience(w.tags, r.audience)
    FROM repairs r WHERE w.id = r.id;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conrelid = 'worlds'::regclass
        AND conname = 'worlds_audience_consistent_v2'
    ) THEN
      ALTER TABLE worlds ADD CONSTRAINT worlds_audience_consistent_v2
        CHECK (${WORLD_AUDIENCE_VALID_SQL}) NOT VALID;
    END IF;
    ALTER TABLE worlds VALIDATE CONSTRAINT worlds_audience_consistent_v2;
  END IF;
END;
$install$;
`;
