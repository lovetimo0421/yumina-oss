/** Canonical client intent log. Confirmed saves/starts belong to server mutations. */
const apiBase = import.meta.env?.VITE_API_URL || "";

// One clock for the current runtime; no receipt/token retention. Receipt fields
// here are timing hints only. The server still verifies signatures and expiry.
let clockAnchor: { serverMs: number; monotonicMs: number } | undefined;
function receiptServedAt(token: unknown): number {
  if (typeof token !== "string" || token.length > 24_000) return NaN;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !/^[\w-]{43}$/.test(parts[1])) return NaN;
  try {
    const bytes = Uint8Array.from(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
    const receipt = JSON.parse(new TextDecoder().decode(bytes));
    return receipt?.version === 1 && typeof receipt.servedAt === "string" ? Date.parse(receipt.servedAt) : NaN;
  } catch { return NaN; }
}

/** Call only for an accepted canonical page, using its fresh HTTP Date header.
 * Capture receivedAt when headers arrive, before awaiting JSON. A committed
 * cursor retry can carry an old servedAt, so it cannot supply the clock alone. */
export function registerFeedClock(attributionToken: string, responseDate: string | null, receivedAt = performance.now()): void {
  const serverMs = responseDate === null ? NaN : Date.parse(responseDate);
  const servedAt = receiptServedAt(attributionToken);
  const now = performance.now();
  if (!Number.isFinite(serverMs) || !Number.isFinite(servedAt) || !Number.isFinite(receivedAt) || receivedAt > now) return;
  const sampled = Math.max(serverMs, servedAt) + (now - receivedAt);
  // Refreshing a second-resolution HTTP date must not rewind an active preview.
  const previous = clockAnchor ? clockAnchor.serverMs + Math.max(0, now - clockAnchor.monotonicMs) : sampled;
  clockAnchor = { serverMs: Math.max(sampled, previous), monotonicMs: now };
}

export interface FeedBeaconInput {
  feedRequestId: string | null;
  worldId: string;
  eventType: "impression" | "click" | "play" | "preview_dwell" | "save_intent";
  position: number | null;
  surface: string | null;
  attributionToken?: string;
  durationMs?: number;
}

export interface FeedBeaconEvent extends FeedBeaconInput {
  readonly eventId: string;
  readonly occurredAt: string;
}

const FLUSH_INTERVAL_MS = 4000;
const MAX_BATCH = 40;
const MAX_BATCH_BYTES = 48 * 1024;
const MAX_BUFFERED = 200;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_AGE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const ENVELOPE_BYTES = 13; // {"events":[]} plus one spare comma
const encoder = new TextEncoder();

interface PendingEvent { json: string; bytes: number; createdAt: number; attempts: number; canonical: boolean }
let queue: PendingEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;
let inFlight = false;
let retryAfter = 0;
const stats = { queued: 0, sent: 0, retried: 0, dropped: 0, buffered: 0, bufferedBytes: 0 };

/** Local diagnostics only; never emit telemetry about telemetry or show UX errors. */
export function getFeedBeaconStats() { return { ...stats }; }

function retire(events: PendingEvent[], outcome: "sent" | "dropped") {
  stats[outcome] += events.length;
  stats.buffered -= events.length;
  stats.bufferedBytes -= events.reduce((sum, item) => sum + item.bytes, 0);
}

function schedule(delay = FLUSH_INTERVAL_MS) {
  if (flushTimer !== null || !queue.length || inFlight) return;
  flushTimer = setTimeout(flush, Math.max(delay, retryAfter - performance.now()));
}

function flush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  if (inFlight) return;
  const now = performance.now();
  queue = queue.filter(item => {
    if (now - item.createdAt <= MAX_AGE_MS) return true;
    retire([item], "dropped");
    return false;
  });
  if (!queue.length) return;
  if (now < retryAfter) { schedule(retryAfter - now); return; }
  const events: PendingEvent[] = [];
  let bytes = ENVELOPE_BYTES;
  while (queue.length && events.length < MAX_BATCH && bytes + queue[0].bytes <= MAX_BATCH_BYTES) {
    const item = queue.shift()!;
    item.attempts++;
    bytes += item.bytes;
    events.push(item);
  }
  inFlight = true;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new Error("beacon timeout")); }, REQUEST_TIMEOUT_MS);
  });
  const send = async () => {
    let retry = true;
    let sent = false;
    try {
      const response = await Promise.race([fetch(`${apiBase}/api/feed/events`, {
        method: "POST", credentials: "include", keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: `{"events":[${events.map(item => item.json).join(",")}]}`,
        signal: controller.signal,
      }), expired]);
      sent = response.ok;
      retry = response.status === 408 || response.status === 429 || response.status >= 500;
    } catch { /* Network failures are retryable, within the same bounds. */ }
    finally { clearTimeout(timeout!); }

    if (sent) {
      retire(events, "sent");
    } else {
      const retained = events.filter(item => {
        // The legacy receiver has no occurrence-ID deduplication. A lost
        // response may follow a committed insert, so only receipts can retry.
        if (retry && item.canonical && item.attempts < MAX_ATTEMPTS && performance.now() - item.createdAt <= MAX_AGE_MS) return true;
        retire([item], "dropped");
        return false;
      });
      stats.retried += retained.length;
      queue.unshift(...retained);
      if (retained.length) retryAfter = performance.now() + FLUSH_INTERVAL_MS * 2 ** (retained[0].attempts - 1);
    }
    inFlight = false;
    schedule(queue.length >= MAX_BATCH ? 0 : FLUSH_INTERVAL_MS);
  };
  void send();
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

function newEventId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Mint at occurrence, snapshot once, reuse for every attempt and PostHog mirror. */
export function queueFeedEvent(input: FeedBeaconInput): Readonly<FeedBeaconEvent> | undefined {
  try {
    if (typeof window === "undefined") return;
    const now = performance.now();
    const canonical = typeof input.attributionToken === "string" && input.attributionToken.length > 0;
    let occurredAt = Date.now();
    if (canonical && clockAnchor) {
      occurredAt = clockAnchor.serverMs + Math.max(0, now - clockAnchor.monotonicMs);
      const servedAt = receiptServedAt(input.attributionToken);
      if (Number.isFinite(servedAt)) {
        // HTTP Date loses fractional seconds; keep valid foreground dwell
        // inside its receipt's elapsed time without altering duration or expiry.
        const duration = input.eventType === "preview_dwell" && typeof input.durationMs === "number"
          && Number.isFinite(input.durationMs) && input.durationMs >= 0 && input.durationMs <= 1_800_000 ? input.durationMs : 0;
        occurredAt = Math.max(occurredAt, servedAt + duration);
      }
    }
    const event = Object.freeze({ ...input, eventId: newEventId(), occurredAt: new Date(Math.ceil(occurredAt)).toISOString() });
    const json = JSON.stringify(event);
    const bytes = encoder.encode(json).byteLength + 1;
    if (bytes + ENVELOPE_BYTES > MAX_BATCH_BYTES || stats.buffered >= MAX_BUFFERED || stats.bufferedBytes + bytes > MAX_BUFFERED_BYTES) {
      stats.dropped++;
      return event;
    }
    installListeners();
    queue.push({ json, bytes, createdAt: now, attempts: 0, canonical });
    stats.queued++;
    stats.buffered++;
    stats.bufferedBytes += bytes;
    if (queue.length >= MAX_BATCH && performance.now() >= retryAfter) flush();
    else schedule();
    return event;
  } catch {
    stats.dropped++;
    // Telemetry never affects the action it describes.
  }
}
