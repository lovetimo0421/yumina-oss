/**
 * Validate a user-supplied base URL for server-initiated outbound requests.
 * Blocks SSRF vectors: cloud metadata endpoints, private IPv4 ranges, link-local
 * addresses, *.internal / *.local hostnames.
 *
 * Returns the normalized origin (e.g. "https://example.com") on success.
 * Throws on any rejected URL.
 *
 * NOTE: We also block localhost/127.0.0.1/::1 for Custom endpoints. Ollama
 * needs localhost and has its own variant of this function — do not use this
 * helper for Ollama.
 */
export function validateCustomEndpointUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid base URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }

  // Node preserves brackets around IPv6 literals in .hostname — strip them so
  // `::1` compares equal to the bracketed form.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  // Cloud metadata endpoints
  if (
    hostname === "169.254.169.254" ||
    hostname === "metadata.google.internal" ||
    hostname === "metadata"
  ) {
    throw new Error("Base URL cannot target cloud metadata services");
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x) — bypasses the IPv4 checks below
  if (hostname.startsWith("::ffff:")) {
    throw new Error("Base URL cannot use IPv4-mapped IPv6 addresses");
  }

  // Link-local + loopback (including decimal/hex representations)
  if (
    hostname === "0.0.0.0" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "2130706433" || // decimal 127.0.0.1
    hostname === "0x7f000001" || // hex 127.0.0.1
    hostname.startsWith("169.254.") ||
    hostname.startsWith("127.") ||
    hostname.startsWith("0177.") // octal 127.x
  ) {
    throw new Error("Base URL cannot target loopback or link-local addresses");
  }

  // RFC1918 private IPv4
  if (
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname))
  ) {
    throw new Error("Base URL cannot target private network addresses");
  }

  // Internal hostnames
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    throw new Error("Base URL cannot target internal hostnames");
  }

  // Include path (user's proxy might be at `https://host/v1`) but normalize trailing slash
  return (parsed.origin + parsed.pathname).replace(/\/+$/, "");
}
