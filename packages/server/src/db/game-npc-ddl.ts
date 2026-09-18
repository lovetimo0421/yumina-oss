export const DAVE_MEMORY_DDL=`CREATE TABLE IF NOT EXISTS game_npc_dave_memory (
 user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 0,
 data jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT dave_memory_size CHECK (octet_length(data::text) <= 65536)
);
CREATE TABLE IF NOT EXISTS game_npc_campaign_memory (
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 campaign_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 0,
 data jsonb NOT NULL CONSTRAINT campaign_memory_size CHECK (octet_length(data::text) <= 65536),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id,campaign_id)
)`;
