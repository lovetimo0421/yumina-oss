-- Credits-paid GPT-Live calls (Big Brother Is Listening). Idempotent: run against dev, then prod, BEFORE deploying.
-- Index names must NOT start with voice_: the voice-billing readiness snapshot fingerprints every voice_% index,
-- and extra ones make checkBalance throw VOICE_SCHEMA_NOT_READY (prod incident 2026-10-19).
CREATE TABLE IF NOT EXISTS voice_live_calls (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  connection_id text,
  provider_id text,
  state text NOT NULL DEFAULT 'connecting' CHECK (state IN ('connecting','active','closing','closed')),
  started_at timestamptz,
  last_heartbeat_at timestamptz,
  paid_minutes integer NOT NULL DEFAULT 0 CHECK (paid_minutes BETWEEN 0 AND 60),
  credits_per_minute integer NOT NULL CHECK (credits_per_minute > 0),
  max_minutes integer NOT NULL DEFAULT 15 CHECK (max_minutes BETWEEN 1 AND 60),
  claimed_until timestamptz,
  close_reason text,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS live_calls_one_open ON voice_live_calls (user_id) WHERE state <> 'closed';
CREATE UNIQUE INDEX IF NOT EXISTS live_calls_provider ON voice_live_calls (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS live_calls_open ON voice_live_calls (state, started_at) WHERE state <> 'closed';
