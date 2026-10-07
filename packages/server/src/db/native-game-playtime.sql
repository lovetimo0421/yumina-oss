-- Lifetime native time is independent of the operational lifecycle retention.
-- IDs distinguish trusted host cumulative counters from server-measured solo time.
CREATE TABLE IF NOT EXISTS native_game_playtime (
 id text PRIMARY KEY,
 game_id text NOT NULL,
 subject text NOT NULL,
 active_ms bigint NOT NULL CHECK(active_ms >= 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS native_game_playtime_game_subject ON native_game_playtime(game_id,subject);

-- Apply after game-lifecycle.sql. Historical source is action-qualified host
-- engaged time only; QA and legacy network-active time never contribute.
-- Re-running before or after live ingest cannot decrease or double count time.
INSERT INTO native_game_playtime(id,game_id,subject,active_ms)
 SELECT 'host:' || id::text,game_id,subject,engaged_ms
 FROM game_play_sessions WHERE environment='production'
 ON CONFLICT(id) DO UPDATE SET
  active_ms=GREATEST(native_game_playtime.active_ms,EXCLUDED.active_ms),
  updated_at=now()
 WHERE native_game_playtime.subject=EXCLUDED.subject
   AND native_game_playtime.game_id=EXCLUDED.game_id;
