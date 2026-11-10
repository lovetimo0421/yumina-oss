/**
 * The usage_logs endpoints the daily and weekly quests count as a chat turn
 * (with completion_tokens > 0): a reply on the site (send / regenerate /
 * continue) or a reply an outside app got through the AI gateway (`app`,
 * routes/ai-gateway.ts) — Jason's call: chatting in a linked game is playing.
 *
 * The one list for all three readers: usage-log.ts (schedules the collector
 * after a turn), quests.ts questProgress (the board) and quest-auto-collect.ts
 * (the day-end sweep). Imports nothing, so any of them can load it.
 */
export const QUEST_TURN_ENDPOINTS = ["send", "regenerate", "continue", "app"] as const;

export const QUEST_TURN_ENDPOINT_SET: ReadonlySet<string> = new Set(QUEST_TURN_ENDPOINTS);

/**
 * `'send','regenerate',…` for an SQL `endpoint IN (…)`. Literals rather than
 * bind parameters so the planner sees the same predicate as before; safe
 * because every entry is a fixed identifier checked here.
 */
export const QUEST_TURN_ENDPOINTS_SQL = QUEST_TURN_ENDPOINTS.map((endpoint) => {
  if (!/^[a-z_-]+$/.test(endpoint)) throw new Error(`bad quest turn endpoint ${endpoint}`);
  return `'${endpoint}'`;
}).join(",");
