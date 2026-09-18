-- Raw operational lifecycle is retained for 30 days, session summaries for 90.
-- Guest subjects intentionally have no Better Auth foreign key.
CREATE TABLE IF NOT EXISTS game_lifecycle_events (
 id uuid PRIMARY KEY,
 event_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS game_lifecycle_received ON game_lifecycle_events(received_at);
CREATE TABLE IF NOT EXISTS game_play_sessions (
 id uuid PRIMARY KEY,
 subject text NOT NULL,
 game_id text NOT NULL,
 release text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('production','qa')),
 region text NOT NULL,
 room_id uuid NOT NULL,
 host_id text NOT NULL,
 boot_id uuid NOT NULL,
 generation integer NOT NULL,
 first_seen timestamptz NOT NULL,
 last_seen timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('connected','disconnected')),
 sequence integer NOT NULL,
 active_ms bigint NOT NULL CHECK(active_ms >= 0)
);
CREATE INDEX IF NOT EXISTS game_sessions_activity ON game_play_sessions(environment,last_seen);
CREATE INDEX IF NOT EXISTS game_sessions_subject ON game_play_sessions(subject,last_seen);
-- Admin overview "players by channel" buckets sessions by first_seen (lib/game-players.ts).
-- Applied to dev + prod by hand on 2026-09-17.
CREATE INDEX IF NOT EXISTS game_sessions_env_first_seen ON game_play_sessions(environment,first_seen);
-- V2 separates automatic network time from time after a player action.
ALTER TABLE game_play_sessions ADD COLUMN IF NOT EXISTS engaged_ms bigint NOT NULL DEFAULT 0 CHECK(engaged_ms >= 0);
ALTER TABLE game_play_sessions ADD COLUMN IF NOT EXISTS action_count bigint NOT NULL DEFAULT 0 CHECK(action_count >= 0);
