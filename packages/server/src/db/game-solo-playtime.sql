-- Durable anti-replay watermarks are separate from the shared public ledger.
-- Keep stopped rows: deleting them would permit old session IDs to replay.
CREATE TABLE IF NOT EXISTS game_solo_playtime_sessions (
  id uuid PRIMARY KEY,
  game_id text NOT NULL CHECK(game_id='pvz'),
  subject text NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0),
  client_active_ms bigint NOT NULL CHECK(client_active_ms>=0),
  active_ms bigint NOT NULL DEFAULT 0 CHECK(active_ms>=0),
  active boolean NOT NULL DEFAULT false,
  stopped boolean NOT NULL DEFAULT false,
  last_server_ms bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(NOT(stopped AND active))
);
CREATE INDEX IF NOT EXISTS game_solo_playtime_live_subject_idx
  ON game_solo_playtime_sessions(subject,game_id,last_server_ms) WHERE active;
