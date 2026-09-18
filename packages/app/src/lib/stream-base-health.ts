/**
 * Reachability of the direct-origin stream base (`stream.yumina.io`).
 *
 * The direct base is DNS-only — it skips Cloudflare, and with it CF's ~100s
 * connection cut, which is what makes long Studio agent runs survive. Some
 * networks (mainland China in particular) reach the CF-proxied apiBase fine but
 * cannot reach the bare origin at all: the connection hangs on silent packet
 * drop rather than being refused.
 *
 * The send path used to discover this inline — every send raced the direct base
 * against a 10s deadline and only then fell back. On a blocked network that is
 * 10 dead seconds per message, and it made a VPN look broken: a failure stuck
 * for 15 minutes, so turning the VPN on mid-window changed nothing.
 *
 * So reachability is decided OUT of the send path: a cheap background probe
 * writes here, and the send path only reads. Kept pure (no fetch, no storage,
 * no clock) so the staleness and decision rules are directly testable.
 */

export type StreamBaseStatus = "unknown" | "healthy" | "unhealthy";

export interface StreamBaseHealth {
  status: StreamBaseStatus;
  /** epoch ms of the observation; 0 when never observed */
  checkedAt: number;
}

export const UNKNOWN_HEALTH: StreamBaseHealth = { status: "unknown", checkedAt: 0 };

/**
 * How long an observation is trusted. Long enough that a settled network isn't
 * re-probed constantly, short enough that a change is picked up on its own even
 * if no event (online / tab focus) fires to trigger a refresh.
 */
export const STREAM_BASE_TTL_MS = 15 * 60_000;

/** What the send path should do about the direct base right now. */
export type BaseDecision =
  /** Known reachable — use the direct base (no CF cut). */
  | "direct"
  /** Known unreachable — go straight to the proxy, do NOT pay the deadline. */
  | "proxy"
  /** No fresh answer — try direct behind the connect deadline, as before. */
  | "try-direct";

export function isFresh(
  health: StreamBaseHealth,
  now: number,
  ttlMs: number = STREAM_BASE_TTL_MS,
): boolean {
  if (health.status === "unknown" || health.checkedAt <= 0) return false;
  const age = now - health.checkedAt;
  // A checkedAt in the future (clock moved backwards, restored session) is not
  // evidence about the network — treat it as no answer rather than trusting it
  // for a full TTL.
  if (age < 0) return false;
  return age < ttlMs;
}

/**
 * Stale or absent readings fall through to `try-direct` — today's behavior —
 * so a network we know nothing about never loses the direct base's fast path.
 * The deadline + inline fallback in the send path remain the safety net for a
 * base that goes bad between probes.
 */
export function decideBase(
  health: StreamBaseHealth,
  now: number,
  ttlMs: number = STREAM_BASE_TTL_MS,
): BaseDecision {
  if (!isFresh(health, now, ttlMs)) return "try-direct";
  return health.status === "healthy" ? "direct" : "proxy";
}

/** True when a background probe would tell us something we don't already know. */
export function shouldProbe(
  health: StreamBaseHealth,
  now: number,
  ttlMs: number = STREAM_BASE_TTL_MS,
): boolean {
  return !isFresh(health, now, ttlMs);
}

/** Parse a persisted reading; any malformed value degrades to "unknown". */
export function parseHealth(raw: string | null): StreamBaseHealth {
  if (!raw) return UNKNOWN_HEALTH;
  try {
    const parsed = JSON.parse(raw) as Partial<StreamBaseHealth>;
    const checkedAt = Number(parsed?.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt <= 0) return UNKNOWN_HEALTH;
    if (parsed?.status !== "healthy" && parsed?.status !== "unhealthy") return UNKNOWN_HEALTH;
    return { status: parsed.status, checkedAt };
  } catch {
    return UNKNOWN_HEALTH;
  }
}

export function serializeHealth(health: StreamBaseHealth): string {
  return JSON.stringify(health);
}
