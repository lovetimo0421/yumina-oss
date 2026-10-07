-- Immutable migration evidence. Keep original session and native ledgers intact.
CREATE TABLE IF NOT EXISTS native_game_playtime_history (
  game_id text NOT NULL,
  subject text NOT NULL,
  legacy_ms bigint NOT NULL CHECK(legacy_ms>=0),
  native_ms bigint NOT NULL CHECK(native_ms>=0),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(game_id,subject)
);
CREATE TABLE IF NOT EXISTS native_game_playtime_cutovers (
  id text PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now()
);
