import { redis, redisSub } from "./redis.js";

// ── SSE Pub/Sub (Redis-backed for multi-replica, in-memory fallback for dev) ──
// Used by DM routes for real-time message delivery.

type Subscriber = {
  userId: string;
  send: (event: string, payload: Record<string, unknown>) => Promise<void> | void;
};

const subscribers = new Map<string, Set<Subscriber>>();
const subscribedChannels = new Set<string>();

if (redisSub) {
  redisSub.on("message", (channel: string, message: string) => {
    const key = channel.slice(5);
    const subs = subscribers.get(key);
    if (!subs) return;

    try {
      const { event, payload, excludeUserId } = JSON.parse(message) as {
        event: string;
        payload: Record<string, unknown>;
        excludeUserId?: string;
      };

      for (const sub of subs) {
        if (excludeUserId && sub.userId === excludeUserId) continue;
        try {
          const result = sub.send(event, payload);
          if (result && typeof result.catch === "function") {
            result.catch(() => { subs.delete(sub); });
          }
        } catch {
          subs.delete(sub);
        }
      }
    } catch {
      // Malformed message, skip
    }
  });
}

export function subscribeToRoom(
  key: string,
  userId: string,
  send: Subscriber["send"]
): () => void {
  const sub: Subscriber = { userId, send };
  if (!subscribers.has(key)) {
    subscribers.set(key, new Set());
  }
  const subs = subscribers.get(key)!;
  for (const existing of subs) {
    if (existing.userId === userId) {
      subs.delete(existing);
    }
  }
  subs.add(sub);

  const channel = `room:${key}`;
  if (redisSub && !subscribedChannels.has(channel)) {
    subscribedChannels.add(channel);
    redisSub.subscribe(channel).catch(() => {});
  }

  return () => {
    subscribers.get(key)?.delete(sub);
    if (subscribers.get(key)?.size === 0) {
      subscribers.delete(key);
      if (redisSub && subscribedChannels.has(channel)) {
        subscribedChannels.delete(channel);
        redisSub.unsubscribe(channel).catch(() => {});
      }
    }
  };
}

export async function publishRoomEvent(
  key: string,
  event: string,
  payload: Record<string, unknown>,
  options?: { excludeUserId?: string }
): Promise<void> {
  if (redis) {
    const message = JSON.stringify({ event, payload, excludeUserId: options?.excludeUserId });
    await redis.publish(`room:${key}`, message);
    return;
  }

  const subs = subscribers.get(key);
  if (!subs) return;

  for (const sub of subs) {
    if (options?.excludeUserId && sub.userId === options.excludeUserId) continue;
    try {
      await sub.send(event, payload);
    } catch {
      subs.delete(sub);
    }
  }
}
