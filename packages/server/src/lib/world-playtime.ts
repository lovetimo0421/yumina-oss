import { readDb } from "../db/index.js";
import { worldPlaytimeQuery } from "./world-playtime-query.js";
import { nativeGameStatsQuery } from "./native-game-stats-query.js";
import { createWorldActivityEnricher, type ActivityTotal } from "./world-activity-enrichment.js";

/** Enrich already-authorized rows; native games use their own measured ledger. */
export const withWorldPlaytime = createWorldActivityEnricher(async (ids, kind) => {
  const database = await readDb();
  const result = await database.execute(kind === 'native' ? nativeGameStatsQuery(ids) : worldPlaytimeQuery(ids));
  return (result.rows as ActivityTotal[]).map(row => ({ ...row, seconds: Number(row.seconds) }));
});
