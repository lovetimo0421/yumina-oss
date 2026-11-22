/** The shape better-auth's getSession() resolves to. */
export type SessionAnswer = {
  data: unknown;
  error: { status: number; statusText?: string } | null;
};

/**
 * Only the server can say "signed out": a 200 with no session, or a 401.
 * Anything else (offline, a phone resuming before its network is back, a
 * timeout, a 429/5xx, an edge error page) says nothing about the session.
 * better-auth's own useSession() keeps the user on those errors; route guards
 * must agree with it, or a click bounces a signed-in player to /login and on
 * to the home page (2026-10 library→chat reports).
 */
function isDefinitive(answer: SessionAnswer): boolean {
  return !answer.error || answer.error.status === 401;
}

/**
 * Session check for route guards. Only definitive answers are cached, for
 * `cacheMs`, so `beforeLoad` doesn't block every navigation on a round trip.
 * A failed check retries once, then falls back to the last definitive answer
 * (of any age), then to `unverified`. Concurrent callers (hover preload +
 * click) share one request.
 */
export function createSessionCheck<T extends SessionAnswer>(
  fetchSession: () => Promise<T>,
  options: { cacheMs?: number; retryMs?: number; retrySignedOut?: () => boolean } = {},
) {
  const cacheMs = options.cacheMs ?? 30_000;
  const retryMs = options.retryMs ?? 600;
  const unverified = Object.freeze({
    data: null,
    error: Object.freeze({ status: 0, statusText: "session-unverified" }),
  }) as unknown as T;

  let cache: { answer: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  // Bumped by clear(): a check that started before a sign-out must not write
  // its answer back afterwards.
  let generation = 0;

  async function fetchDefinitive(): Promise<T | null> {
    try {
      const answer = await fetchSession();
      return isDefinitive(answer) ? answer : null;
    } catch {
      return null;
    }
  }

  function get(): Promise<T> {
    if (cache && Date.now() - cache.at < cacheMs) return Promise.resolve(cache.answer);
    if (inflight) return inflight;
    const started = generation;
    const request = (async () => {
      let answer = await fetchDefinitive();
      // One retry covers a phone waking up and a deploy blip (and, in dev,
      // Vite HMR briefly answering "no session").
      if (!answer || (options.retrySignedOut?.() && !answer.data)) {
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        answer = (await fetchDefinitive()) ?? answer;
      }
      if (started !== generation) return answer ?? unverified;
      if (answer) {
        cache = { answer, at: Date.now() };
        return answer;
      }
      return cache?.answer ?? unverified;
    })().finally(() => {
      if (inflight === request) inflight = null;
    });
    inflight = request;
    return request;
  }

  return {
    get,
    /** Forget everything (call on sign-out). */
    clear() {
      cache = null;
      inflight = null;
      generation += 1;
    },
    /** True when get() could not reach a verdict: not the same as signed out. */
    isUnverified: (answer: T) => answer === unverified,
  };
}

/**
 * What a page that needs an account should do with a session answer:
 * - signed in: continue;
 * - not verified (network/server hiccup): continue too. The page's own API
 *   calls are the authority and show their error/retry state; sending a
 *   signed-in player to /login on a blip is what bounced them home;
 * - signed out: go to /login, coming back afterwards when `returnTo` (already
 *   filtered by the auth return allowlist) is set.
 */
export function loginRedirectFor(
  answer: SessionAnswer,
  unverified: boolean,
  returnTo: string | undefined,
): { to: "/login"; search: { returnTo?: string } } | null {
  if (answer.data || unverified) return null;
  return { to: "/login", search: returnTo ? { returnTo } : {} };
}
