import { parseTableCode } from "./room-logic";

/**
 * A rules-table invite is the card's page with `?table=CODE`. The page keeps
 * the code here; once the friend presses Play, the card's UI reads it with
 * `api.room.pendingTable()` (read once) and joins `rules:CODE` itself.
 */
const key = (worldId: string) => `yumina:pending-table:${worldId}`;
// The last invite whatever card it was for: the friend may start another
// version of the card (经典版 / AI娘版), which has its own id.
const LAST_KEY = "yumina:pending-table";
const TTL_MS = 60 * 60_000;
const OTHER_VERSION_TTL_MS = 15 * 60_000;

export function rememberPendingTable(worldId: string, raw: unknown): void {
  const code = parseTableCode(raw);
  if (!code) return;
  try {
    sessionStorage.setItem(key(worldId), JSON.stringify({ code, at: Date.now() }));
    sessionStorage.setItem(LAST_KEY, JSON.stringify({ code, at: Date.now(), worldId }));
  } catch {
    /* private mode: the friend can still type the code into the card */
  }
}

type Saved = { code?: unknown; at?: unknown; worldId?: unknown };

function take(k: string, ttl: number): { code: string | null; worldId: unknown } | null {
  const raw = sessionStorage.getItem(k);
  if (!raw) return null;
  sessionStorage.removeItem(k);
  const saved = JSON.parse(raw) as Saved;
  const fresh = typeof saved.at === "number" && Date.now() - saved.at <= ttl;
  return { code: fresh ? parseTableCode(saved.code) : null, worldId: saved.worldId };
}

export function takePendingTable(worldId: string): string | null {
  try {
    const own = take(key(worldId), TTL_MS);
    const last = take(LAST_KEY, OTHER_VERSION_TTL_MS);
    // Read once: the copy kept for the card the invite named goes too.
    if (last && typeof last.worldId === "string") sessionStorage.removeItem(key(last.worldId));
    return own?.code ?? last?.code ?? null;
  } catch {
    return null;
  }
}
