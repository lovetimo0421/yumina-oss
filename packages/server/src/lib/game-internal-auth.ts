// Service-to-service auth for game-rt → API calls (/api/internal/*).
//
// CONTRACT with packages/game-server/src/rules/backend.ts (signInternal):
// headers x-yumina-ts (ms epoch), x-yumina-nonce (single use) and
// x-yumina-sig = base64url(HMAC-SHA256(GAME_TICKET_SECRET,
// `${ts}\n${nonce}\n${METHOD}\n${path}\n${sha256hex(body)}`)). Change both together.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_MS = 60_000;
const MAX_NONCES = 50_000;

export function internalSignature(secret: string, ts: string, nonce: string, method: string, path: string, body: string): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${digest}`).digest("base64url");
}

export type InternalAuthResult = "ok" | "bad-signature" | "stale" | "replayed";

/** A replay guard per process: a signed request is good once, for one minute. */
export function createInternalVerifier(now: () => number = Date.now) {
  const seen = new Map<string, number>();
  let nextSweep = 0;
  return function verify(p: { secret: string; method: string; path: string; body: string; ts?: string | null; nonce?: string | null; sig?: string | null }): InternalAuthResult {
    const { ts, nonce, sig } = p;
    if (!p.secret || !ts || !nonce || !sig || !/^\d{1,16}$/.test(ts) || nonce.length > 128) return "bad-signature";
    const expected = Buffer.from(internalSignature(p.secret, ts, nonce, p.method, p.path, p.body));
    const actual = Buffer.from(sig);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return "bad-signature";
    const at = now();
    if (Math.abs(at - Number(ts)) > WINDOW_MS) return "stale";
    if (at >= nextSweep) {
      nextSweep = at + 10_000;
      for (const [key, exp] of seen) if (exp <= at) seen.delete(key);
    }
    if (seen.has(nonce)) return "replayed";
    if (seen.size >= MAX_NONCES) return "stale";
    seen.set(nonce, at + 2 * WINDOW_MS);
    return "ok";
  };
}
