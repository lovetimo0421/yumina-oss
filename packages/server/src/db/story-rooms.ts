import { sql } from "drizzle-orm";
import type { LedgerDatabase } from "../lib/transaction-hash.js";

/** Story rooms (a play session shared by 2-12 friends). Identical to
 * scripts/story-rooms.sql, which is applied by hand (dev, then prod) before the
 * code ships; the boot install below is only the fallback self-heal. */
export const STORY_ROOMS_DDL = [
  `CREATE TABLE IF NOT EXISTS story_rooms (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  session_id text NOT NULL UNIQUE REFERENCES play_sessions(id) ON DELETE CASCADE,
  world_id text NOT NULL,
  host_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  turn_mode text NOT NULL DEFAULT 'free',
  max_seats integer NOT NULL DEFAULT 12,
  merge_window_ms integer NOT NULL DEFAULT 8000,
  status text NOT NULL DEFAULT 'open',
  created_at timestamp NOT NULL DEFAULT now(),
  closed_at timestamp
)`,
  `CREATE TABLE IF NOT EXISTS story_room_members (
  room_id text NOT NULL REFERENCES story_rooms(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'player',
  joined_at timestamp NOT NULL DEFAULT now(),
  left_at timestamp,
  kicked_at timestamp,
  muted_until timestamp,
  PRIMARY KEY (room_id, user_id)
)`,
  `CREATE TABLE IF NOT EXISTS story_room_actions (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES story_rooms(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  text text NOT NULL,
  turn_id text,
  message_id text,
  created_at timestamp NOT NULL DEFAULT now()
)`,
  `CREATE INDEX IF NOT EXISTS story_room_actions_open_idx ON story_room_actions (room_id) WHERE message_id IS NULL`,
  `CREATE INDEX IF NOT EXISTS story_room_actions_turn_idx ON story_room_actions (turn_id) WHERE turn_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS story_room_members_user_idx ON story_room_members (user_id)`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS contributions jsonb`,
  `ALTER TABLE story_rooms ADD COLUMN IF NOT EXISTS min_seats integer NOT NULL DEFAULT 2`,
  `ALTER TABLE story_room_members ADD COLUMN IF NOT EXISTS role_id text`,
  `ALTER TABLE story_room_members ADD COLUMN IF NOT EXISTS role_name text`,
  `ALTER TABLE story_room_actions ADD COLUMN IF NOT EXISTS roster text`,
  `ALTER TABLE story_rooms ADD COLUMN IF NOT EXISTS send_profile jsonb`,
  `ALTER TABLE story_rooms ADD COLUMN IF NOT EXISTS open_to_friends boolean NOT NULL DEFAULT false`,
  `ALTER TABLE story_room_actions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'action'`,
  `ALTER TABLE story_room_actions ADD COLUMN IF NOT EXISTS hold boolean NOT NULL DEFAULT false`,
  `ALTER TABLE story_rooms ADD COLUMN IF NOT EXISTS spend_cap integer DEFAULT 5000`,
  `ALTER TABLE story_rooms ADD COLUMN IF NOT EXISTS cost_mode text NOT NULL DEFAULT 'host'`,
  `ALTER TABLE story_rooms ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false`,
  `ALTER TABLE story_room_members ADD COLUMN IF NOT EXISTS split_ok boolean NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS story_rooms_public_idx ON story_rooms (world_id) WHERE status = 'open' AND is_public`,
] as const;

export const storyRoomsSql = () => STORY_ROOMS_DDL.map(statement => `${statement};\n`).join("");

export async function installStoryRooms(database: Pick<LedgerDatabase, "execute">): Promise<void> {
  for (const statement of STORY_ROOMS_DDL) await database.execute(sql.raw(statement));
}
