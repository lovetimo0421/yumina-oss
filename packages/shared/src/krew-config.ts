/** Public game addresses only. Never put identity or session data here. */
export type KrewPublicConfig = {
  enabled: boolean;
  clientOrigin: string | null;
  testClientOrigin: string | null;
};

export const KREW_CONFIG_ELEMENT_ID = "krew-config";

export function normalizeKrewClientOrigin(value: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch {
    return "";
  }
}

export function getKrewPublicConfig(clientOrigin: string, testClientOrigin: string): KrewPublicConfig {
  const client = normalizeKrewClientOrigin(clientOrigin);
  return {
    enabled: Boolean(client),
    clientOrigin: client || null,
    testClientOrigin: client ? normalizeKrewClientOrigin(testClientOrigin) || null : null,
  };
}

/** The gateway krew's client talks to, derived the way its engine page does
 *  (`game.` + the client host without a `play.`/`www.` prefix): play.krew.io →
 *  game.krew.io, test.krew.io → game.test.krew.io. Used only to warm a
 *  connection early; the client still decides where it actually connects. */
export function krewGameOrigin(clientOrigin: string): string | null {
  const origin = normalizeKrewClientOrigin(clientOrigin);
  if (!origin) return null;
  const url = new URL(origin);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  return `${url.protocol}//game.${url.hostname.replace(/^(play|www)\./, "")}`;
}
