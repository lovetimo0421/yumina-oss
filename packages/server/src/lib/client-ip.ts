/**
 * The visitor's address, for rate limits, login step-up and the device list.
 *
 * `cf-connecting-ip` and `x-forwarded-for` are whatever the sender typed when a
 * request reaches the origin without passing through Cloudflare, and the origin
 * is reachable that way (the Railway domain, the DNS-only stream host). Keying
 * a limit on them let anyone pick a fresh bucket per request.
 *
 * `x-real-ip` is written by Railway's edge from the connection itself, so it is
 * the one header the sender does not control. It is the address to use unless
 * that connection came from Cloudflare, in which case Cloudflare's own
 * `cf-connecting-ip` names the visitor behind it. Every place that needs the
 * address reads it from here.
 */
import { BlockList, isIP } from "node:net";

// https://www.cloudflare.com/ips/ — the published edge ranges.
const CLOUDFLARE_RANGES: ReadonlyArray<readonly [string, number, "ipv4" | "ipv6"]> = [
  ["173.245.48.0", 20, "ipv4"],
  ["103.21.244.0", 22, "ipv4"],
  ["103.22.200.0", 22, "ipv4"],
  ["103.31.4.0", 22, "ipv4"],
  ["141.101.64.0", 18, "ipv4"],
  ["108.162.192.0", 18, "ipv4"],
  ["190.93.240.0", 20, "ipv4"],
  ["188.114.96.0", 20, "ipv4"],
  ["197.234.240.0", 22, "ipv4"],
  ["198.41.128.0", 17, "ipv4"],
  ["162.158.0.0", 15, "ipv4"],
  ["104.16.0.0", 13, "ipv4"],
  ["104.24.0.0", 14, "ipv4"],
  ["172.64.0.0", 13, "ipv4"],
  ["131.0.72.0", 22, "ipv4"],
  ["2400:cb00::", 32, "ipv6"],
  ["2606:4700::", 32, "ipv6"],
  ["2803:f800::", 32, "ipv6"],
  ["2405:b500::", 32, "ipv6"],
  ["2405:8100::", 32, "ipv6"],
  ["2a06:98c0::", 29, "ipv6"],
  ["2c0f:f248::", 32, "ipv6"],
];

const cloudflare = new BlockList();
for (const [network, prefix, family] of CLOUDFLARE_RANGES) cloudflare.addSubnet(network, prefix, family);

function address(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  if (!first) return null;
  const family = isIP(first);
  return family === 0 ? null : first;
}

export function isCloudflareAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return cloudflare.check(ip, family === 4 ? "ipv4" : "ipv6");
}

type HeaderReader = (name: string) => string | null | undefined;

export function clientIpFrom(header: HeaderReader): string | null {
  const connecting = address(header("x-real-ip"));
  const viaCloudflare = address(header("cf-connecting-ip"));
  if (connecting) {
    // The connection is Cloudflare's: the visitor is the one Cloudflare names.
    if (viaCloudflare && isCloudflareAddress(connecting)) return viaCloudflare;
    return connecting;
  }
  // No edge in front (local development, tests): nothing better is known.
  return viaCloudflare ?? address(header("x-forwarded-for"));
}

/** The header Better Auth reads the address from; set by us, never by the sender. */
export const CLIENT_IP_HEADER = "x-yumina-client-ip";

/** Stamp the request with the address worked out above, replacing anything the sender put there. */
export function stampClientIp(request: Request): Request {
  const ip = clientIpFrom((name) => request.headers.get(name));
  try {
    if (ip) request.headers.set(CLIENT_IP_HEADER, ip);
    else request.headers.delete(CLIENT_IP_HEADER);
  } catch {
    // Immutable headers: leave the request as it is; Better Auth falls back to
    // the next header in its list.
  }
  return request;
}
