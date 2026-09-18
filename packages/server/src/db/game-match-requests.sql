-- One idempotent, cancellable admission intent. Room/seat state remains in
-- the shared directory; language is deliberately not a matchmaking partition.
CREATE TABLE IF NOT EXISTS game_match_requests (
 subject text NOT NULL,
 request_id uuid NOT NULL,
 participant_id text NOT NULL,
 room_id uuid REFERENCES game_rooms(id) ON DELETE SET NULL,
 state text NOT NULL CHECK(state IN ('assigned','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(subject,request_id)
);
CREATE INDEX IF NOT EXISTS game_match_requests_subject ON game_match_requests(subject,state);
CREATE INDEX IF NOT EXISTS game_match_requests_retention ON game_match_requests(created_at);
