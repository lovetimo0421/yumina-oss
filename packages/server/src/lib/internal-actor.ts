import { randomBytes } from "node:crypto";

/**
 * In-process requests the server makes on a user's behalf (a story room's
 * round is sent by the server as the host, see lib/story-room-runner.ts).
 * The request carries a one-time random token in a header; the token lives
 * only in this process's memory for a minute and is consumed by the first
 * auth check that reads it. Nothing arriving over the network can know one,
 * and it survives middleware that rebuilds the Request (request-body-limit).
 */
export const INTERNAL_ACTOR_HEADER = "x-yumina-internal-actor";
type Actor = { userId: string; purpose: "story-room-round" };
const TTL_MS = 60_000;
const pending = new Map<string, Actor & { until: number }>();

/** Headers that let one in-process request act as `userId`. */
export function internalActorHeaders(userId: string, purpose: Actor["purpose"]): Record<string, string> {
  const now = Date.now();
  for (const [token, entry] of pending) if (entry.until <= now) pending.delete(token);
  const token = randomBytes(32).toString("base64url");
  pending.set(token, { userId, purpose, until: now + TTL_MS });
  return { [INTERNAL_ACTOR_HEADER]: token };
}

/** The actor a request's token names, consuming the token. Null for anything else. */
export function takeInternalActor(request: Request): Actor | null {
  const token = request.headers.get(INTERNAL_ACTOR_HEADER);
  if (!token) return null;
  const entry = pending.get(token);
  pending.delete(token);
  if (!entry || entry.until <= Date.now()) return null;
  return { userId: entry.userId, purpose: entry.purpose };
}
