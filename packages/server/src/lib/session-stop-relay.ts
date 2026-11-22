import { redis, redisSub } from "./redis.js";
import { stopSessionStream } from "./stream-registry.js";

/**
 * Cross-replica Stop for chat generations.
 *
 * A generation's AbortController lives only on the replica that is streaming
 * it (stream-registry.ts). With two web replicas the Stop request lands on the
 * other one about half the time; before this relay that Stop found nothing,
 * so the "stopped" reply kept generating, persisted and was charged.
 *
 * The stop route has already checked that the session belongs to the caller,
 * so a relayed session id is trusted as-is. Same shape as agent:stop in
 * routes/agent.ts.
 */
const CHANNEL = "chat:stop:v1";
let started = false;
let subscribing = false;

export function startSessionStopRelay(): void {
  if (started || !redisSub) return;
  started = true;
  const subscriber = redisSub;
  const subscribe = () => {
    if (subscribing || subscriber.status !== "ready") return;
    subscribing = true;
    void subscriber.subscribe(CHANNEL).catch(() => {}).finally(() => { subscribing = false; });
  };
  subscriber.on("ready", subscribe);
  subscriber.on("message", (channel: string, raw: string) => {
    if (channel !== CHANNEL || raw.length > 128) return;
    if (stopSessionStream(raw)) console.log(`[Messages] Cross-replica stop received for session ${raw}`);
  });
  subscribe();
}

/**
 * Stop the session's in-flight generation wherever it runs. Returns true when
 * this replica stopped it; otherwise the stop is broadcast to the others and
 * `relayed` says whether the broadcast went out.
 */
export async function stopSessionStreamEverywhere(sessionId: string): Promise<{ stopped: boolean; relayed: boolean }> {
  if (stopSessionStream(sessionId)) return { stopped: true, relayed: false };
  if (!redis || redis.status !== "ready") return { stopped: false, relayed: false };
  try {
    await redis.publish(CHANNEL, sessionId);
    return { stopped: false, relayed: true };
  } catch {
    return { stopped: false, relayed: false };
  }
}
