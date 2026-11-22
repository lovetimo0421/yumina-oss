import { sql } from "drizzle-orm";
import type { LedgerDatabase } from "../lib/transaction-hash.js";

/** Card leaderboards (a card's own high-score boards, like Steam's). Identical
 * to scripts/leaderboards.sql, which is applied by hand (dev, then prod) before
 * the code ships; the boot install below is only the fallback self-heal. */
export const LEADERBOARDS_DDL = [
  `CREATE TABLE IF NOT EXISTS card_leaderboards (
  card_key text NOT NULL,
  board text NOT NULL,
  ascending boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (card_key, board)
)`,
  `CREATE TABLE IF NOT EXISTS card_leaderboard_entries (
  card_key text NOT NULL,
  board text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  score double precision NOT NULL,
  details jsonb,
  updated_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (card_key, board, user_id)
)`,
  `CREATE INDEX IF NOT EXISTS card_leaderboard_entries_score_idx ON card_leaderboard_entries (card_key, board, score)`,
] as const;

export const leaderboardsSql = () => LEADERBOARDS_DDL.map(statement => `${statement};\n`).join("");

export async function installLeaderboards(database: Pick<LedgerDatabase, "execute">): Promise<void> {
  for (const statement of LEADERBOARDS_DDL) await database.execute(sql.raw(statement));
}
