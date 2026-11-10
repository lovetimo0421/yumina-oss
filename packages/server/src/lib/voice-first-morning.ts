// One sponsored live morning per account for "1984: The Unperson".
// Off unless UNPERSON_FIRST_MORNING_FREE=true. The grant is bound to the first
// session it is used in and lasts long enough for that morning's reconnects;
// afterwards the player keeps the typed edition (captions + read-aloud credits)
// until wallet-billed live voice is enabled for the world.

export const FIRST_MORNING_WINDOW_MS = 25 * 60_000;
const RETAIN_SECONDS = 400 * 86_400;

export interface FirstMorningStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: "EX", seconds: number, condition: "NX"): Promise<unknown>;
}

export function firstMorningEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.UNPERSON_FIRST_MORNING_FREE === "true" && Boolean(env.OPENAI_API_KEY?.trim());
}

/** In-memory store for installations without Redis (local only). */
export function memoryFirstMorningStore(): FirstMorningStore {
  const values = new Map<string, string>();
  return {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { if (values.has(key)) return null; values.set(key, value); return "OK"; },
  };
}

interface Grant { sessionId: string; startedAt: number }
function readGrant(raw: string | null): Grant | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Grant>;
    return typeof value.sessionId === "string" && typeof value.startedAt === "number" ? { sessionId: value.sessionId, startedAt: value.startedAt } : null;
  } catch { return null; }
}

/** The sponsored key if this account may talk live in this session now.
 * consume=false only peeks (availability); consume=true claims the grant. */
export async function firstMorningKey(options: {
  userId: string; sessionId: string; consume: boolean; store: FirstMorningStore;
  isUnpersonSession(sessionId: string): Promise<boolean>;
  env?: Record<string, string | undefined>; now?: number;
}): Promise<string | null> {
  const env = options.env ?? process.env, now = options.now ?? Date.now();
  if (!firstMorningEnabled(env)) return null;
  if (!await options.isUnpersonSession(options.sessionId)) return null;
  const apiKey = env.OPENAI_API_KEY!.trim();
  const key = `voice-first-morning:${options.userId}`;
  const valid = (grant: Grant | null) => grant !== null && grant.sessionId === options.sessionId && now - grant.startedAt < FIRST_MORNING_WINDOW_MS;
  const existing = readGrant(await options.store.get(key));
  if (existing) return valid(existing) ? apiKey : null;
  if (!options.consume) return apiKey;
  const claimed = await options.store.set(key, JSON.stringify({ sessionId: options.sessionId, startedAt: now }), "EX", RETAIN_SECONDS, "NX");
  if (claimed === "OK") return apiKey;
  // Another request claimed it first: honour it only for the same session.
  return valid(readGrant(await options.store.get(key))) ? apiKey : null;
}
