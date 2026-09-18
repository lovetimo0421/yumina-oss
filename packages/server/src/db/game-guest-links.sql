CREATE TABLE IF NOT EXISTS game_guest_links (
  guest_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS game_guest_links_user_idx ON game_guest_links(user_id);
