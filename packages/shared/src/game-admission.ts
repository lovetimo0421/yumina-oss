/** Wire contract shared by the central issuer and isolated game hosts. */
export interface GameAdmission {
  v: 2; kid: string; sub: string; name: string;
  room: string; code: string; host: string; boot: string; generation: number;
  participant: string; seat: 0 | 1; game: "pvz"; release: string; protocol: 1;
  exp: number; jti: string;
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export function isGameAdmission(value: unknown): value is GameAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const bounded = (v: unknown, n: number) => typeof v === "string" && v.length > 0 && v.length <= n;
  return p.v === 2 && p.game === "pvz" && p.protocol === 1
    && bounded(p.kid,32) && bounded(p.sub,128) && bounded(p.name,256)
    && bounded(p.room,36) && uuid.test(String(p.room)) && bounded(p.boot,36) && uuid.test(String(p.boot))
    && typeof p.code === "string" && /^(?:[A-Z0-9]{4}|R[A-Z0-9]{4})$/.test(p.code)
    && typeof p.host === "string" && /^[a-z0-9-]{1,64}$/.test(p.host)
    && typeof p.participant === "string" && /^[a-z0-9-]{1,64}$/i.test(p.participant)
    && Number.isSafeInteger(p.generation) && Number(p.generation) > 0
    && (p.seat === 0 || p.seat === 1) && bounded(p.release,64)
    && Number.isSafeInteger(p.exp) && bounded(p.jti,36) && uuid.test(String(p.jti));
}
