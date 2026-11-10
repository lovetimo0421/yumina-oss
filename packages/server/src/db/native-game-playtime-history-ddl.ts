// Bundled counterpart of the PostgreSQL preparation SQL. Parity is tested.
export const NATIVE_PLAYTIME_HISTORY_DDLS = [
  `CREATE TABLE IF NOT EXISTS native_game_playtime_history (
    game_id text NOT NULL, subject text NOT NULL,
    legacy_ms bigint NOT NULL CHECK(legacy_ms>=0), native_ms bigint NOT NULL CHECK(native_ms>=0),
    captured_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(game_id,subject)
  )`,
  `CREATE TABLE IF NOT EXISTS native_game_playtime_cutovers (
    id text PRIMARY KEY, captured_at timestamptz NOT NULL DEFAULT now()
  )`,
];

export const NATIVE_PLAYTIME_HISTORY_SNAPSHOT = `
WITH capture AS (
  INSERT INTO native_game_playtime_cutovers(id) VALUES('recorded-history-v1')
  ON CONFLICT(id) DO NOTHING RETURNING id
), source AS (
  SELECT CASE WHEN w.game_path IN ('/pvz','/pvz/') THEN 'pvz' ELSE 'krew' END AS game_id,
    ps.user_id AS subject,GREATEST(ps.playtime_seconds,0)::bigint*1000 AS legacy_ms,0::bigint AS native_ms
  FROM play_sessions ps JOIN worlds w ON w.id=ps.world_id
  WHERE ps.ephemeral=false AND w.game_path IN ('/pvz','/pvz/','/krew','/krew/')
  UNION ALL
  SELECT game_id,subject,0::bigint,active_ms FROM native_game_playtime WHERE game_id IN ('pvz','krew')
)
INSERT INTO native_game_playtime_history(game_id,subject,legacy_ms,native_ms)
SELECT s.game_id,s.subject,SUM(s.legacy_ms)::bigint,SUM(s.native_ms)::bigint
FROM source s CROSS JOIN capture GROUP BY s.game_id,s.subject;`;
