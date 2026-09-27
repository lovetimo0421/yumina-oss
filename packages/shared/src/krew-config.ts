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
