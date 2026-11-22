/** Transactional grandfathering migration. Quiesce old feedback writers before first application. */
export const WORLD_FEEDBACK_DDL = `
SELECT pg_advisory_xact_lock(hashtext('world-feedback-v1'));
CREATE TEMP TABLE feedback_prior_shape ON COMMIT DROP AS SELECT to_regclass('world_ratings') IS NOT NULL AS had_votes;
-- Also upgrade a fresh local database's original one-review schema.
ALTER TABLE reviews ALTER COLUMN rating DROP NOT NULL;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_user_id_world_id_unique;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_user_id_world_id_key;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply_count integer NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS hidden_by_creator_at timestamp;
CREATE TABLE IF NOT EXISTS world_ratings (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, rating integer NOT NULL,
  low_reason text, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(), UNIQUE(user_id, world_id)
);
CREATE TABLE IF NOT EXISTS review_replies (
  id text PRIMARY KEY, review_id text NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  reply_to_reply_id text REFERENCES review_replies(id) ON DELETE SET NULL,
  content text NOT NULL, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_replies_review_id_idx ON review_replies(review_id);
CREATE TABLE IF NOT EXISTS world_feedback_migrations (id text PRIMARY KEY);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS linked_review_id text REFERENCES reviews(id) ON DELETE SET NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS deleted_at timestamp;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS archived_rating integer;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS superseded_by_review_id text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS playtime_at_review_seconds integer;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS rating_requested boolean NOT NULL DEFAULT false;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moved_at timestamp;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS moved_from text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS move_reason text;
ALTER TABLE review_replies ADD COLUMN IF NOT EXISTS deleted_at timestamp;
CREATE UNIQUE INDEX IF NOT EXISTS reviews_linked_review_unique ON reviews(linked_review_id);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS legacy_feedback boolean NOT NULL DEFAULT false;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS review_updates jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Historical ratings/replies are immutable during grandfathering. Legacy clients
-- must be drained before this transaction; see prepare-world-feedback.mjs.
DROP TRIGGER IF EXISTS world_rating_review_bridge ON world_ratings;
DROP TRIGGER IF EXISTS world_review_reply_discussion ON review_replies;
DROP TRIGGER IF EXISTS world_feedback_classify_insert ON reviews;
DROP INDEX IF EXISTS reviews_one_active_per_world_user;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_kind_rating_check;
ALTER TABLE reviews ALTER COLUMN kind DROP DEFAULT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM world_feedback_migrations WHERE id='grandfather-feedback-v4') THEN
    UPDATE reviews SET legacy_feedback=true, kind=COALESCE(kind,'review'),
      hidden_by_creator_at=NULL, superseded_by_review_id=NULL;
    -- Only a database predating the separate votes table derives votes from reviews.
    -- An existing empty votes table means users withdrew their votes: never refill it.
    IF NOT (SELECT had_votes FROM feedback_prior_shape) THEN
      INSERT INTO world_ratings(id,user_id,world_id,rating,low_reason,created_at,updated_at)
        SELECT DISTINCT ON (user_id,world_id) 'legacy-vote-' || id,user_id,world_id,rating,reason,created_at,updated_at
        FROM reviews WHERE rating BETWEEN 1 AND 5
        ORDER BY user_id,world_id,updated_at DESC NULLS LAST,created_at DESC NULLS LAST,id DESC;
      UPDATE worlds w SET review_count=(SELECT count(*)::int FROM world_ratings wr WHERE wr.world_id=w.id),
        average_rating=(SELECT COALESCE(avg(wr.rating),0)::real FROM world_ratings wr WHERE wr.world_id=w.id);
    END IF;
    -- An explicit current-vote owner avoids changing any historical review's stars,
    -- reasons or text. Preserve every vote, including preexisting sibling votes.
    INSERT INTO reviews(id,user_id,world_id,kind,rating,reason,created_at,updated_at,legacy_feedback)
      SELECT 'feedback-vote-v4-' || id,user_id,world_id,'review',rating,low_reason,created_at,updated_at,false
      FROM world_ratings;
    -- Earlier testing migrations used linked containers; restore their comments
    -- to the exact original review, never a replacement author's-history row.
    UPDATE review_replies rr SET review_id=container.linked_review_id
      FROM reviews container WHERE rr.review_id=container.id AND container.linked_review_id IS NOT NULL;
    UPDATE reviews r SET reply_count=(SELECT count(*)::int FROM review_replies rr WHERE rr.review_id=r.id AND rr.deleted_at IS NULL);
    INSERT INTO world_feedback_migrations VALUES ('grandfather-feedback-v4');
  END IF;
END $$;
ALTER TABLE reviews ALTER COLUMN kind SET NOT NULL;
ALTER TABLE reviews ADD CONSTRAINT reviews_kind_rating_check CHECK (
  (kind='review' AND ((rating IS NOT NULL AND rating BETWEEN 1 AND 5) OR (legacy_feedback AND rating IS NULL)))
  OR (kind='discussion' AND rating IS NULL)
);
-- Old clients are not allowed to write through the cutover. Explicit kind is
-- mandatory once migrated; unrated historical rows are grandfathered, not a
-- bypass for new unrated reviews.
CREATE UNIQUE INDEX reviews_one_active_per_world_user ON reviews(world_id,user_id)
  WHERE kind='review' AND deleted_at IS NULL AND superseded_by_review_id IS NULL AND NOT legacy_feedback;
CREATE INDEX IF NOT EXISTS reviews_world_kind_created_idx ON reviews(world_id,kind,created_at);
`;
