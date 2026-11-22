import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

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

// ─── Address-level guard ────────────────────────────────────────────
// The hostname checks above read the URL as text. A public name can still
// resolve to a private address (127.0.0.1.nip.io, a DNS record the caller
// owns), and a public server can answer with a redirect to one. So every
// request to a user-supplied endpoint also checks where the name really
// points, and never follows a redirect.

const PRIVATE_RANGES = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE_RANGES.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) PRIVATE_RANGES.addSubnet(net, prefix, "ipv6");

/** Loopback, private, link-local, CGNAT, ULA, multicast, or an IPv4 address wrapped in IPv6. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  if (family === 4) return PRIVATE_RANGES.check(ip, "ipv4");
  if (family !== 6) return true;
  const mapped = /^::ffff:([0-9]+[.][0-9]+[.][0-9]+[.][0-9]+)$/.exec(ip);
  if (mapped) return PRIVATE_RANGES.check(mapped[1]!, "ipv4");
  if (ip.startsWith("::ffff:")) return true;
  return PRIVATE_RANGES.check(ip, "ipv6");
}

function bareHost(hostname: string): string {
  let host = hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

const REFUSED = "This address points to a private network and cannot be used";

type Resolver = (hostname: string) => Promise<string[]>;
const systemResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address);

/**
 * Throws when the URL's host is, or resolves to, a private address, or does not
 * resolve at all. Used where a caller wants the answer before connecting (saving
 * a connection); the request itself is checked again at connect time below.
 */
export async function assertPublicEndpoint(rawUrl: string, resolve: Resolver = systemResolver): Promise<void> {
  const hostname = bareHost(new URL(rawUrl).hostname);
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error(REFUSED);
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new Error("This address could not be resolved");
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error(REFUSED);
}

// The check has to be made on the address the socket really connects to. A
// lookup done beforehand can be answered differently a moment later (a DNS
// record with no TTL), so the connection's own lookup is the one that is
// judged: every address it returns must be public or the connect fails.
type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  const opts = (typeof options === "object" && options !== null ? options : {}) as Record<string, unknown>;
  dnsLookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address))) {
      return callback(Object.assign(new Error(REFUSED), { code: "EPRIVATEADDRESS" }));
    }
    if (opts.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup as never } });
const builtinFetch = globalThis.fetch;

const MAX_REDIRECTS = 5;

/**
 * fetch for a user-supplied endpoint. Every connection it makes is pinned to an
 * address that passed the check, including each hop of a redirect: redirects
 * are walked here one at a time (http to https, a moved path) so that no hop
 * escapes the check, the way fetch's own "follow" would for a literal address.
 */
export async function fetchUserEndpoint(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url;
  let request: RequestInit = init;
  for (let hop = 0; ; hop++) {
    const response = await fetchOnce(current, request);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error("The endpoint redirected too many times");
    const next = new URL(location, current);
    if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error("The endpoint redirected to an unsupported address");
    const headers = new Headers(request.headers);
    // As fetch does: a key is not carried to another origin, and 301/302/303
    // turn a POST into a GET.
    if (next.origin !== new URL(current).origin) headers.delete("authorization");
    const method = (request.method ?? "GET").toUpperCase();
    const keepsMethod = response.status === 307 || response.status === 308 || method === "GET" || method === "HEAD";
    if (!keepsMethod) headers.delete("content-type");
    request = keepsMethod ? { ...request, headers } : { ...request, headers, method: "GET", body: undefined };
    current = next.toString();
  }
}

async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  // A literal IP never goes through a lookup, so it is judged here.
  const hostname = bareHost(new URL(url).hostname);
  if (isIP(hostname) && isPrivateAddress(hostname)) throw new Error(REFUSED);
  // Tests replace the global fetch to play the endpoint; honour the stand-in.
  if (globalThis.fetch !== builtinFetch) return globalThis.fetch(url, { ...init, redirect: "manual" });
  try {
    return await undiciFetch(url, { ...(init as object), redirect: "manual", dispatcher: guardedAgent } as never) as unknown as Response;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } } | null)?.cause;
    if (cause?.code === "EPRIVATEADDRESS") throw new Error(REFUSED);
    throw error;
  }
}
