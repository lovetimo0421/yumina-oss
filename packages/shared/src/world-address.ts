/**
 * Public addresses for worlds and creators.
 *
 *   yumina.io/@username/world-name-<publicId>
 *   yumina.io/@username
 *
 * A world address resolves by its permanent `publicId` alone. The username
 * and the name are there for people, and when either changes the old
 * address still opens the world and forwards to the current form. This is
 * the Medium / Stack Overflow model: nothing has to be frozen or remembered.
 */

/** Handles nobody may register: they read as the platform speaking. */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "yumina", "yumina_official", "yuminaofficial", "official", "admin", "administrator", "staff", "team",
  "support", "help", "mod", "moderator", "moderators", "system", "root", "api", "app", "www", "mail",
  "krew", "krewio", "pvz", "mushie", "mushies", "store", "billing", "legal", "security", "abuse",
  "null", "undefined", "anonymous", "deleted", "me", "you", "login", "register", "settings",
]);

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username.trim().toLowerCase());
}

/** Better Auth's default username alphabet, kept explicit so URLs stay simple. */
export const USERNAME_RE = /^[a-zA-Z0-9_.]{3,20}$/;

const MAX_SLUG_LENGTH = 80;
/** Words that profile pages may want to own one day; a world named this gets a suffix. */
const RESERVED_WORLD_SLUGS = new Set(["followers", "following", "reviews", "achievements", "worlds", "about", "edit"]);

/**
 * Turn a world name into the readable part of its address.
 * Letters and numbers of any script stay (CJK included); everything else
 * becomes a dash; a name with nothing usable becomes "world".
 */
export function slugifyWorldName(name: string | null | undefined): string {
  const base = (name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  let slug = base;
  if (slug.length > MAX_SLUG_LENGTH) {
    const cut = slug.slice(0, MAX_SLUG_LENGTH);
    const lastDash = cut.lastIndexOf("-");
    slug = (lastDash > 20 ? cut.slice(0, lastDash) : cut).replace(/-$/, "");
  }
  if (!slug) return "world";
  if (RESERVED_WORLD_SLUGS.has(slug)) return `${slug}-world`;
  return slug;
}

export interface WorldAddressParts {
  /** The creator's handle, any case; the address uses lowercase. */
  username: string;
  name: string | null | undefined;
  publicId: string;
}

/** `/@username/world-name-<publicId>`. Returns null when a part is missing. */
export function worldAddressPath(parts: { username?: string | null; name?: string | null; publicId?: string | null }): string | null {
  const username = parts.username?.trim().toLowerCase();
  const publicId = parts.publicId?.trim().toLowerCase();
  if (!username || !publicId) return null;
  return `/@${username}/${slugifyWorldName(parts.name)}-${publicId}`;
}

/** `/@username` */
export function profileAddressPath(username: string | null | undefined): string | null {
  const handle = username?.trim().toLowerCase();
  return handle ? `/@${handle}` : null;
}

export interface ParsedWorldAddress {
  /** Lowercased handle without the "@". */
  handle: string;
  /** The readable part as written in the address (may be stale after a rename). */
  slug: string;
  publicId: string;
}

const PUBLIC_ID_RE = /^[0-9a-f]{8,32}$/;

/**
 * Read a world address. Accepts any case and percent-encoding; the id is the
 * last dash-separated piece. `/@user/world-name-27483dff` → { handle: "user",
 * slug: "world-name", publicId: "27483dff" }. Null for anything else.
 */
export function parseWorldAddress(pathname: string): ParsedWorldAddress | null {
  const path = safeDecode(pathname).replace(/\/+$/, "");
  const match = path.match(/^\/@([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const handle = match[1]!.toLowerCase();
  const tail = match[2]!;
  const dash = tail.lastIndexOf("-");
  const publicId = (dash >= 0 ? tail.slice(dash + 1) : tail).toLowerCase();
  if (!PUBLIC_ID_RE.test(publicId)) return null;
  const slug = dash >= 0 ? tail.slice(0, dash) : "";
  return { handle, slug, publicId };
}

/** Read a creator address: `/@user` → "user". Null for anything else. */
export function parseProfileAddress(pathname: string): string | null {
  const path = safeDecode(pathname).replace(/\/+$/, "");
  const match = path.match(/^\/@([^/]+)$/);
  return match ? match[1]!.toLowerCase() : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
