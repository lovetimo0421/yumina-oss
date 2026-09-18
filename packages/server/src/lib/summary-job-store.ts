import { createHash } from "node:crypto";
import { redis } from "./redis.js";
import { SummaryJobManager, type SummaryJobStore } from "./summary-job-core.js";
import type { EpisodeCheckpoint } from "./summary-episode-recovery.js";

// Only installations without Redis use this bounded, expiring local store.
const local = new Map<string, { value: string; expires: number }>();
function pruneLocal() {
  for (const [key, item] of local) if (item.expires <= Date.now()) local.delete(key);
}
const store: SummaryJobStore = {
  async get(key) {
    if (redis) return redis.get(key);
    pruneLocal();
    return local.get(key)?.value ?? null;
  },
  async compareAndSet(key, previous, next, ttlSeconds) {
    if (redis) {
      return Number(await redis.eval(
        "local v = redis.call('GET', KEYS[1]); if (not v and ARGV[1] == '') or v == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]); return 1 end; return 0",
        1, key, previous ?? "", next, ttlSeconds,
      )) === 1;
    }
    pruneLocal();
    if ((local.get(key)?.value ?? null) !== previous) return false;
    if (!local.has(key) && local.size >= 2048) throw new Error("Summary cache is full. Please try again later.");
    local.set(key, { value: next, expires: Date.now() + ttlSeconds * 1000 });
    return true;
  },
};

export const summaryJobs = new SummaryJobManager(store);
export const summaryJobKey = (userId: string, sessionId: string) => `summary-job:v1:${userId}:${sessionId}`;

/** Include actual prompt inputs so edits and setting changes invalidate reuse. */
export function episodeCheckpointKey(userId: string, sessionId: string, input: unknown) {
  return `summary-episode:v1:${userId}:${sessionId}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}
export async function loadEpisodeCheckpoint(key: string): Promise<EpisodeCheckpoint | null> {
  try {
    const raw = await store.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    console.warn("[StoryCompaction] Episode checkpoint unavailable; continuing without cache.");
    return null;
  }
}
export async function saveEpisodeCheckpoint(key: string, result: EpisodeCheckpoint): Promise<void> {
  try {
    await store.compareAndSet(key, null, JSON.stringify(result), 3600);
  } catch {
    console.warn("[StoryCompaction] Episode checkpoint save failed; preserving generated output.");
  }
}
