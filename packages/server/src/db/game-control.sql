-- Game control data is off the input/tick path. No account rows for guests.
CREATE TABLE IF NOT EXISTS game_hosts (
 id text PRIMARY KEY,
 region text NOT NULL,
 endpoint text NOT NULL,
 max_rooms integer NOT NULL CHECK(max_rooms BETWEEN 1 AND 5000),
 boot_id uuid,
 state text NOT NULL DEFAULT 'offline' CHECK(state IN ('offline','accepting','draining')),
 lease_until timestamptz NOT NULL DEFAULT 'epoch',
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS game_rooms (
 id uuid PRIMARY KEY,
 code text NOT NULL,
 game_id text NOT NULL,
 release text NOT NULL,
 protocol integer NOT NULL,
 host_id text NOT NULL REFERENCES game_hosts(id),
 boot_id uuid NOT NULL,
 generation integer NOT NULL DEFAULT 1 CHECK(generation > 0),
 creator text NOT NULL,
 request_id uuid NOT NULL,
 visibility text NOT NULL CHECK(visibility IN ('private','public')),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','active','closed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now() + interval '3 minutes',
 UNIQUE(creator,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS game_rooms_live_code ON game_rooms(code) WHERE state <> 'closed';
CREATE INDEX IF NOT EXISTS game_rooms_host ON game_rooms(host_id,state);
CREATE INDEX IF NOT EXISTS game_rooms_discovery ON game_rooms(game_id,release,visibility,state,expires_at);
CREATE TABLE IF NOT EXISTS game_room_participants (
 room_id uuid NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
 participant_id text NOT NULL,
 subject text NOT NULL,
 seat integer NOT NULL CHECK(seat IN (0,1)),
 lease_until timestamptz NOT NULL,
 PRIMARY KEY(room_id,participant_id),
 UNIQUE(room_id,seat)
);
