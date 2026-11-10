import { randomUUID } from "node:crypto";
import { redis, redisSub } from "./redis.js";

/**
 * Changes to a card made from outside the open editor — an AI working
 * through a world access token — pushed to every Studio tab that has the card
 * open, so the creator watches it happen (the board reloads, a notice says
 * who changed what) instead of finding it later.
 *
 * Production runs several replicas: the AI's request and the creator's open
 * tab often land on different ones. Each event is delivered locally and
 * published on Redis; other replicas deliver what they hear, and a replica
 * skips its own echo. Without Redis (dev) it stays in-process. The write is
 * safe either way — the editor's save 3-way merges a newer server copy — only
 * the live refresh depends on this.
 */

export interface WorldEvent {
  kind: "external-write";
  /** Who did it: the token's name, e.g. "Claude Code". */
  actor: string;
  tool: string;
  /** The tool's arguments, trimmed — the editor finds the row it touched. */
  args: Record<string, unknown>;
  ok: boolean;
  at: string;
}

type Listener = (event: WorldEvent) => void;
const listeners = new Map<string, Set<Listener>>();

const WORLD_EVENTS_CHANNEL = "world:events";
const REPLICA_ID = randomUUID();

function deliver(worldId: string, event: WorldEvent): void {
  for (const listener of listeners.get(worldId) ?? []) {
    try { listener(event); } catch { /* one tab's failure is not the writer's */ }
  }
}

if (redisSub) {
  const sub = redisSub;
  const subscribe = () => { sub.subscribe(WORLD_EVENTS_CHANNEL).catch(() => { /* retried on reconnect */ }); };
  sub.on("ready", subscribe);
  if ((sub as { status?: string }).status === "ready") subscribe();
  sub.on("message", (channel: string, message: string) => {
    if (channel !== WORLD_EVENTS_CHANNEL) return;
    try {
      const { from, worldId, event } = JSON.parse(message) as { from: string; worldId: string; event: WorldEvent };
      if (from !== REPLICA_ID && listeners.has(worldId)) deliver(worldId, event);
    } catch { /* malformed message */ }
  });
}

export function subscribeWorldEvents(worldId: string, listener: Listener): () => void {
  let set = listeners.get(worldId);
  if (!set) { set = new Set(); listeners.set(worldId, set); }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(worldId);
  };
}

export function publishWorldEvent(worldId: string, event: WorldEvent): void {
  deliver(worldId, event);
  if (redis) {
    redis.publish(WORLD_EVENTS_CHANNEL, JSON.stringify({ from: REPLICA_ID, worldId, event })).catch(() => { /* live refresh only */ });
  }
}
