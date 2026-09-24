/**
 * Local-bridge hub — routes one LLM turn out to the player's own browser, which
 * forwards it to a model running on their machine and streams the tokens back.
 *
 * Why a hub at all: the chat pipeline calls an `LLMProvider` and expects an
 * async iterable of chunks. A local model can't be reached from our servers
 * (the player's `localhost` is their machine, not our container), so the
 * browser has to be the courier. This module is the piece that lets a
 * server-side `for await` over LocalBridgeProvider's stream be fed by
 * two unrelated HTTP requests from that browser.
 *
 * Two hops, both of which may land on different instances:
 *
 *   LocalBridgeProvider stream          browser GET /poll (SSE)
 *          │ dispatchJob                        │ takeConnection
 *          ▼                                    ▼
 *      ┌────────────────── this module ──────────────────┐
 *      │  pending[requestId]  ◄── chunks ──  connections[userId] │
 *      └─────────────────────────────────────────────────┘
 *          ▲                                    ▲
 *          │ pushChunk/finish/fail              │ job event
 *      browser POST /chunk                  browser runs the model
 *
 * Cross-instance delivery goes over Redis pub/sub (`redisSub` already exists
 * for exactly this). With no REDIS_URL — dev, or a single-instance deploy —
 * everything resolves in-process and the Redis path is simply never taken.
 *
 * NOT a queue: a job is delivered to a live connection or it fails fast. A
 * player whose tab is closed has no local model available, and silently
 * parking their turn until they come back is worse than telling them now.
 */

import { randomUUID } from "node:crypto";
import { redis, redisSub } from "../redis.js";

/** Wire payload the browser forwards verbatim to the local OpenAI-compatible endpoint. */
export interface BridgeJobPayload {
  /** Bare model id as the local runtime knows it — no `local/` prefix. */
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  /** Ollama's `think`: false so thinking models write instead of reasoning (see LocalBridgeProvider). */
  think?: boolean;
  /**
   * Context window to run the local model at. The runtime's own default is
   * often far below what we packed (Ollama shipped 32k while our prompt
   * budget assumed 262k), and everything past it is dropped SILENTLY — off the
   * front, which is exactly where the persona and lorebook live. The browser
   * passes this through as `num_ctx` / equivalent so the runtime either fits
   * the prompt or fails loudly.
   */
  num_ctx?: number;
}

export interface BridgeJob {
  requestId: string;
  payload: BridgeJobPayload;
}

/** What the browser sends back, one batch at a time. */
export type BridgeEvent =
  | { kind: "chunk"; requestId: string; delta: string }
  | { kind: "done"; requestId: string; stopReason?: string; usage?: { promptTokens: number; completionTokens: number } }
  | { kind: "error"; requestId: string; message: string };

/** A live browser poll connection on THIS instance. */
interface Connection {
  id: string;
  userId: string;
  send: (job: BridgeJob) => void;
  /** Set when the socket drops so we stop handing it work. */
  closed: boolean;
}

/** A generateStream() call on THIS instance waiting to be fed. */
interface Pending {
  requestId: string;
  queue: BridgeEvent[];
  /** Resolves the iterator's current await, if it is parked. */
  wake: (() => void) | null;
  settled: boolean;
  lastActivity: number;
}

const connections = new Map<string, Connection[]>();
const pending = new Map<string, Pending>();

const CHANNEL = "yumina:local-bridge";

/**
 * How long a turn may go without a single token before we give up.
 *
 * Generous on purpose: a cold local model loads 17GB off disk before it emits
 * anything (measured ~60s on an NVMe laptop), and a long prompt then prefills
 * for another few seconds. A cloud timeout would fire during normal startup.
 */
const INACTIVITY_TIMEOUT_MS = 180_000;

// ── Redis fan-out ────────────────────────────────────────────────────────────

let subscribed = false;

/** Idempotent — safe to call from route setup and from tests. */
export function initLocalBridge(): void {
  if (subscribed || !redisSub) return;
  subscribed = true;
  redisSub.subscribe(CHANNEL).catch((err) => {
    console.warn("[LocalBridge] subscribe failed:", err instanceof Error ? err.message : err);
  });
  redisSub.on("message", (channel, raw) => {
    if (channel !== CHANNEL) return;
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    routeRemote(msg as RemoteMessage);
  });
}

type RemoteMessage =
  | { type: "job"; userId: string; job: BridgeJob }
  | { type: "event"; event: BridgeEvent };

function routeRemote(msg: RemoteMessage): void {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "job") {
    // Another instance took a turn for a user whose browser is connected here.
    deliverLocally(msg.userId, msg.job);
  } else if (msg.type === "event") {
    // The browser's POST landed on another instance; the waiting iterator is here.
    applyEventLocally(msg.event);
  }
}

function publish(msg: RemoteMessage): void {
  if (!redis) return;
  redis.publish(CHANNEL, JSON.stringify(msg)).catch((err) => {
    console.warn("[LocalBridge] publish failed:", err instanceof Error ? err.message : err);
  });
}

// ── Connections (browser side) ───────────────────────────────────────────────

/** Register a live poll connection. Returns a disposer for the route to call on close. */
export function addConnection(userId: string, send: (job: BridgeJob) => void): () => void {
  const conn: Connection = { id: randomUUID(), userId, send, closed: false };
  const list = connections.get(userId) ?? [];
  list.push(conn);
  connections.set(userId, list);

  return () => {
    conn.closed = true;
    const current = connections.get(userId);
    if (!current) return;
    const next = current.filter((c) => c.id !== conn.id);
    if (next.length === 0) connections.delete(userId);
    else connections.set(userId, next);
  };
}

/** Whether this user has a browser ready to run turns (this instance only). */
export function hasLocalConnection(userId: string): boolean {
  return (connections.get(userId) ?? []).some((c) => !c.closed);
}

function deliverLocally(userId: string, job: BridgeJob): boolean {
  const list = connections.get(userId) ?? [];
  // Most recent connection wins: a reloaded tab leaves a stale one behind for
  // as long as it takes the old socket to notice it's dead.
  for (let i = list.length - 1; i >= 0; i--) {
    const conn = list[i]!;
    if (conn.closed) continue;
    try {
      conn.send(job);
      return true;
    } catch {
      conn.closed = true;
    }
  }
  return false;
}

// ── Advertised models ────────────────────────────────────────────────────────

/**
 * What the player's machine currently has loaded, as reported when their
 * browser connects. Cached in Redis (short TTL) so the model picker works from
 * any instance, with an in-process copy for the no-Redis case.
 *
 * TTL rather than explicit invalidation because the truth lives on someone
 * else's computer: they can pull or delete a model with us none the wiser, and
 * a stale list that self-heals in five minutes beats one that never does.
 */
export interface AdvertisedModel {
  id: string;
  name?: string;
  contextLength?: number;
}

const MODELS_TTL_SECONDS = 300;
const localModels = new Map<string, { models: AdvertisedModel[]; expiresAt: number }>();

export function setAdvertisedModels(userId: string, models: AdvertisedModel[]): void {
  localModels.set(userId, { models, expiresAt: Date.now() + MODELS_TTL_SECONDS * 1000 });
  redis
    ?.set(`bridge:models:${userId}`, JSON.stringify(models), "EX", MODELS_TTL_SECONDS)
    .catch(() => { /* cache miss just means an empty picker */ });
}

export async function getAdvertisedModels(userId: string): Promise<AdvertisedModel[]> {
  const local = localModels.get(userId);
  if (local && local.expiresAt > Date.now()) return local.models;
  localModels.delete(userId);

  if (!redis) return [];
  try {
    const raw = await redis.get(`bridge:models:${userId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AdvertisedModel[]) : [];
  } catch {
    return [];
  }
}

// ── Events (browser → waiting iterator) ──────────────────────────────────────

function applyEventLocally(event: BridgeEvent): boolean {
  const entry = pending.get(event.requestId);
  if (!entry || entry.settled) return false;
  entry.queue.push(event);
  entry.lastActivity = Date.now();
  if (event.kind !== "chunk") entry.settled = true;
  entry.wake?.();
  return true;
}

/**
 * Called by the chunk/done/error routes. Applies locally when the waiting
 * iterator lives here, otherwise fans out over Redis so the instance holding
 * it can.
 */
export function submitEvent(event: BridgeEvent): void {
  if (applyEventLocally(event)) return;
  publish({ type: "event", event });
}

// ── Dispatch (provider side) ─────────────────────────────────────────────────

export class NoLocalBridgeError extends Error {
  constructor() {
    super("No local model is connected. Open Yumina in a browser tab on the computer running your model.");
    this.name = "NoLocalBridgeError";
  }
}

/**
 * Hand one turn to the player's browser and yield its output.
 *
 * Throws NoLocalBridgeError synchronously when nothing is connected anywhere —
 * the caller turns that into a player-readable message rather than a stall.
 */
export async function* dispatchJob(
  userId: string,
  payload: BridgeJobPayload,
  signal?: AbortSignal,
): AsyncGenerator<BridgeEvent> {
  const requestId = randomUUID();
  const entry: Pending = { requestId, queue: [], wake: null, settled: false, lastActivity: Date.now() };
  pending.set(requestId, entry);

  const job: BridgeJob = { requestId, payload };

  try {
    if (!deliverLocally(userId, job)) {
      if (!redis) throw new NoLocalBridgeError();
      // Another instance may hold the connection. We can't know without asking,
      // so publish and let the inactivity timeout decide if nobody answers.
      publish({ type: "job", userId, job });
    }

    while (true) {
      if (signal?.aborted) return;

      const next = entry.queue.shift();
      if (next) {
        yield next;
        if (next.kind !== "chunk") return;
        continue;
      }

      const idleFor = Date.now() - entry.lastActivity;
      if (idleFor >= INACTIVITY_TIMEOUT_MS) {
        yield {
          kind: "error",
          requestId,
          message:
            "Your computer didn't respond. Check that the tab running your local model is still open and the model is loaded.",
        };
        return;
      }

      await waitForActivity(entry, INACTIVITY_TIMEOUT_MS - idleFor, signal);
    }
  } finally {
    pending.delete(requestId);
  }
}

/** Park until a chunk arrives, the deadline passes, or the client goes away. */
function waitForActivity(entry: Pending, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      entry.wake = null;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(50, timeoutMs));
    entry.wake = finish;
    signal?.addEventListener("abort", finish, { once: true });
  });
}
