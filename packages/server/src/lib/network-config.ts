/** Resolve deployment addresses once for auth, sandbox policy and links. */
export function resolveNetworkConfig(input: {
  port: number;
  publicHost?: string;
  publicOrigin?: string;
  authUrl?: string;
  localEdition: boolean;
}) {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const fallback = `http://${input.publicHost || "localhost"}:${input.port}`;
  const publicUrl = new URL(input.publicOrigin || input.authUrl || fallback);
  const authUrl = new URL(input.authUrl || publicUrl.href);
  for (const url of [publicUrl, authUrl]) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Public/auth URLs must be HTTP(S) origins without credentials, paths or queries");
    }
  }
  const localHttp = input.localEdition && publicUrl.protocol === "http:";
  return {
    publicOrigin: publicUrl.origin,
    authUrl: authUrl.origin,
    secureCookies: !localHttp,
    sandboxHttpSource: localHttp ? ` ${publicUrl.origin}` : "",
  };
}
