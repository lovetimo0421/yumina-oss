/** An opportunity belongs to its original card, never a global last touch. */
export interface FeedOrigin {
  readonly surface: string;
  readonly position: number | null;
  readonly feedRequestId: string | null;
  readonly attributionToken?: string;
  readonly worldId?: string;
}

export interface DiscoveryAttribution { readonly token: string; readonly worldId: string }

export function discoveryAttribution(origin?: FeedOrigin | null): DiscoveryAttribution | undefined {
  if (!origin?.attributionToken || !origin.worldId) return;
  return Object.freeze({ token: origin.attributionToken, worldId: origin.worldId });
}

const STORAGE_KEY = "yumina.discovery-handoff.v1";
const TTL_MS = 30 * 60_000;
const MAX_HANDOFFS = 8;
const MAX_STORAGE_CHARS = 80_000;
const MAX_RECEIPT_CHARS = 24_000; // Server receipt budget, independent of total handoff storage.
interface Handoff { targetWorldId: string; origin: FeedOrigin; expiresAt: number }

function validHandoff(entry: unknown): entry is Handoff {
  if (!entry || typeof entry !== "object") return false;
  const { origin, targetWorldId, expiresAt } = entry as Handoff;
  const now = Date.now();
  return typeof targetWorldId === "string" && targetWorldId.length > 0 && targetWorldId.length <= 256
    && typeof expiresAt === "number" && expiresAt > now && expiresAt <= now + TTL_MS
    && typeof origin?.worldId === "string" && origin.worldId.length > 0 && origin.worldId.length <= 256
    && typeof origin.attributionToken === "string" && origin.attributionToken.length > 0 && origin.attributionToken.length <= MAX_RECEIPT_CHARS
    && typeof origin.surface === "string" && origin.surface.length <= 64
    && (origin.feedRequestId === null || (typeof origin.feedRequestId === "string" && origin.feedRequestId.length <= 256))
    && (origin.position === null || (Number.isSafeInteger(origin.position) && origin.position >= 0));
}

function readHandoffs(): Handoff[] {
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw || raw.length > MAX_STORAGE_CHARS) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(validHandoff).slice(-MAX_HANDOFFS);
}

/** Call only for an explicit preview/login handoff; target may be its selected translation. */
export function rememberDiscoveryHandoff(targetWorldId: string, origin?: FeedOrigin | null): void {
  try {
    const existing = readHandoffs().filter(entry => entry.targetWorldId !== targetWorldId);
    const entry = { targetWorldId, origin, expiresAt: Date.now() + TTL_MS };
    if (validHandoff(entry)) {
      const { worldId, attributionToken, surface, feedRequestId, position } = entry.origin;
      existing.push({ ...entry, origin: { worldId, attributionToken, surface, feedRequestId, position } });
    }
    const bounded = existing.slice(-MAX_HANDOFFS);
    // Also bound serialized storage (escaping may expand even valid strings).
    while (bounded.length && JSON.stringify(bounded).length > MAX_STORAGE_CHARS) bounded.shift();
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bounded));
  } catch { /* Disabled/malformed storage must not block play or login. */ }
}

/** Consume at the explicit target flow's start and retain its snapshot across mutation retries. */
export function consumeDiscoveryHandoff(targetWorldId: string): FeedOrigin | null {
  try {
    const existing = readHandoffs();
    const match = existing.find(entry => entry.targetWorldId === targetWorldId);
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(existing.filter(entry => entry !== match)));
    return match ? Object.freeze({ ...match.origin }) : null;
  } catch { return null; }
}
