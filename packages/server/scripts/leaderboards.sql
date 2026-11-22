-- Card leaderboards (a card's own high-score boards). Idempotent: run against dev, then prod, BEFORE deploying.
-- Must stay identical to LEADERBOARDS_DDL in src/db/leaderboards.ts (a test compares them).
CREATE TABLE IF NOT EXISTS card_leaderboards (
  card_key text NOT NULL,
  board text NOT NULL,
  ascending boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (card_key, board)
);
CREATE TABLE IF NOT EXISTS card_leaderboard_entries (
  card_key text NOT NULL,
  board text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  score double precision NOT NULL,
  details jsonb,
  updated_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (card_key, board, user_id)
);
CREATE INDEX IF NOT EXISTS card_leaderboard_entries_score_idx ON card_leaderboard_entries (card_key, board, score);
