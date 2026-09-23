-- Apply before deploying code that selects user_personas.entries.
-- Additive: existing personas keep their fields and receive an empty list.
ALTER TABLE "user_personas"
  ADD COLUMN IF NOT EXISTS "entries" jsonb NOT NULL DEFAULT '[]'::jsonb;
