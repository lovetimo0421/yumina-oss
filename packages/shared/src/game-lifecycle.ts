/** Trusted hosts report lifecycle, never frame contents, names, chat or tokens. */
interface GameLifecycleBase {
  id: string;
  at: number;
  kind: "joined" | "resumed" | "disconnected" | "activity";
  host: string;
  boot: string;
  region: string;
  environment: "production" | "qa";
  game: string;
  release: string;
  room: string;
  generation: number;
  session: string;
  subject: string;
  seat: number;
  activeMs: number;
  sequence: number;
}
export type GameLifecycleEvent = GameLifecycleBase & (
  { version: 1 } | { version: 2; actions: number; engagedMs: number }
);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const label = /^[a-zA-Z0-9._-]{1,64}$/;
const keys = new Set("version id at kind host boot region environment game release room generation session subject seat activeMs sequence".split(" "));
export function isGameLifecycleEvent(value: unknown): value is GameLifecycleEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const v2 = p.version === 2;
  return Object.keys(p).length === keys.size + (v2 ? 2 : 0) && Object.keys(p).every(k => keys.has(k) || (v2 && (k === 'actions' || k === 'engagedMs'))) &&
    (p.version === 1 || v2) && (!v2 || (Number.isSafeInteger(p.actions) && Number(p.actions)>=0 && Number(p.actions)<=100000000 &&
      Number.isSafeInteger(p.engagedMs) && Number(p.engagedMs)>=0 && Number(p.engagedMs)<=Number(p.activeMs) && (Number(p.actions)>0 || p.engagedMs===0))) &&
    [p.id, p.boot, p.room, p.session].every(v => typeof v === "string" && uuid.test(v)) &&
    [p.host, p.region, p.game, p.release].every(v => typeof v === "string" && label.test(v)) &&
    ["joined", "resumed", "disconnected", "activity"].includes(String(p.kind)) &&
    ["production", "qa"].includes(String(p.environment)) &&
    typeof p.subject === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(p.subject) &&
    Number.isSafeInteger(p.at) && Number(p.at) > 0 &&
    Number.isSafeInteger(p.generation) && Number(p.generation) > 0 &&
    Number.isSafeInteger(p.sequence) && Number(p.sequence) > 0 &&
    Number.isSafeInteger(p.activeMs) && Number(p.activeMs) >= 0 && Number(p.activeMs) <= 7 * 86400_000 &&
    (p.seat === 0 || p.seat === 1);
}
