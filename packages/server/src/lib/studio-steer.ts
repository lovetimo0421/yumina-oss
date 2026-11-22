import { redis } from "./redis.js";

/**
 * What the creator adds while the assistant is still working (after Codex's
 * turn/steer). The message waits here until the run's next step, which reads
 * it before calling the model again, so the creator can correct course
 * without stopping the run and paying for its steps again. Redis carries it
 * to whichever instance runs the loop; without Redis there is one instance.
 */

export interface Steer { id: string; text: string }

/** Longest message accepted mid-run: a correction, not a new document. */
export const MAX_STEER_CHARS = 4000;
/** Messages waiting for one step at most: each one goes into that step's prompt. */
export const MAX_WAITING_STEERS = 10;
const TTL_SECONDS = 2 * 3600;
const key = (runId: string) => `agent:steer:${runId}`;
const local = new Map<string, Steer[]>();

/** False when the run already has MAX_WAITING_STEERS messages it has not read. */
export async function queueSteer(runId: string, steer: Steer): Promise<boolean> {
  if (!redis) {
    const waiting = local.get(runId) ?? [];
    if (waiting.length >= MAX_WAITING_STEERS) return false;
    local.set(runId, [...waiting, steer]);
    return true;
  }
  const results = await redis.multi().rpush(key(runId), JSON.stringify(steer)).expire(key(runId), TTL_SECONDS).exec();
  if (Number(results?.[0]?.[1] ?? 0) <= MAX_WAITING_STEERS) return true;
  // Over the limit: take back the one just pushed (the newest is at the tail).
  await redis.rpop(key(runId));
  return false;
}

/** Everything waiting for this run, oldest first; each is handed out once. */
export async function takeSteers(runId: string): Promise<Steer[]> {
  if (!redis) {
    const waiting = local.get(runId) ?? [];
    local.delete(runId);
    return waiting;
  }
  const results = await redis.multi().lrange(key(runId), 0, -1).del(key(runId)).exec();
  const raw = (results?.[0]?.[1] ?? []) as string[];
  return raw.flatMap((item) => {
    try {
      const parsed = JSON.parse(item) as Partial<Steer>;
      return typeof parsed.id === "string" && typeof parsed.text === "string" ? [{ id: parsed.id, text: parsed.text }] : [];
    } catch { return []; }
  });
}

/** The run ended: nothing more will read its queue. The client puts any
 *  message the run never took back in the creator's input. */
export async function clearSteers(runId: string): Promise<void> {
  if (!redis) { local.delete(runId); return; }
  await redis.del(key(runId));
}
