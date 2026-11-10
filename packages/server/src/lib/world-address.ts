import { worldAudienceCondition } from "./world-publication-access.js";
/**
 * Server side of public world and creator addresses:
 *   /@username/world-name-<publicId>   and   /@username
 * Lookups resolve by the permanent id (worlds.public_id) or by handle; the
 * canonical path is recomputed from the current username and name so a
 * stale address can be forwarded to the current one.
 */
import { and, eq, sql } from "drizzle-orm";
import { profileAddressPath, worldAddressPath } from "@yumina/shared";
import { readPublic } from "../db/index.js";
import { user, worlds } from "../db/schema.js";

export interface AddressedWorld {
  id: string;
  publicId: string | null;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  status: string | null;
  isPublished: boolean | null;
  visibility: string | null;
  ageRating: string | null;
  language: string | null;
  gamePath?: string | null;
  tags: unknown;
  creatorId: string;
  creatorName: string | null;
  creatorUsername: string | null;
}

const WORLD_ADDRESS_COLUMNS = {
  id: worlds.id,
  publicId: worlds.publicId,
  name: worlds.name,
  description: worlds.description,
  thumbnailUrl: worlds.thumbnailUrl,
  status: worlds.status,
  isPublished: worlds.isPublished,
  visibility: worlds.visibility,
  ageRating: worlds.ageRating,
  language: worlds.language,
  gamePath: worlds.gamePath,
  tags: worlds.tags,
  creatorId: worlds.creatorId,
  creatorName: user.name,
  creatorUsername: user.username,
};

const PUBLIC_ID_RE = /^[0-9a-f]{8,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findWorldByPublicId(publicId: string): Promise<AddressedWorld | null> {
  const key = publicId.trim().toLowerCase();
  if (!PUBLIC_ID_RE.test(key)) return null;
  const [row] = await readPublic()
    .select(WORLD_ADDRESS_COLUMNS)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(eq(worlds.publicId, key), worldAudienceCondition(worlds.creatorId)))
    .limit(1);
  return row ?? null;
}

export async function findWorldById(id: string): Promise<AddressedWorld | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await readPublic()
    .select(WORLD_ADDRESS_COLUMNS)
    .from(worlds)
    .leftJoin(user, eq(worlds.creatorId, user.id))
    .where(and(eq(worlds.id, id), worldAudienceCondition(worlds.creatorId)))
    .limit(1);
  return row ?? null;
}

/** Published and public: the only worlds that get a crawlable address. */
export function isPubliclyVisible(world: Pick<AddressedWorld, "status" | "isPublished" | "visibility">): boolean {
  return (world.status === "published" || Boolean(world.isPublished)) && world.visibility === "public";
}

/** The current address of a world, or null when it has no id or no creator handle yet. */
export function canonicalWorldPath(world: Pick<AddressedWorld, "publicId" | "name" | "creatorUsername">): string | null {
  return worldAddressPath({ username: world.creatorUsername, name: world.name, publicId: world.publicId });
}

export interface AddressedUser {
  id: string;
  name: string | null;
  username: string | null;
  bio: string | null;
  image: string | null;
  banner: string | null;
  isBanned: boolean | null;
  isSuspended: boolean | null;
}

const USER_ADDRESS_COLUMNS = {
  id: user.id,
  name: user.name,
  username: user.username,
  bio: user.bio,
  image: user.image,
  banner: user.banner,
  isBanned: user.isBanned,
  isSuspended: user.isSuspended,
};

export async function findUserByHandle(handle: string): Promise<AddressedUser | null> {
  const key = handle.trim().replace(/^@/, "").toLowerCase();
  if (!key) return null;
  const [row] = await readPublic()
    .select(USER_ADDRESS_COLUMNS)
    .from(user)
    .where(sql`lower(${user.username}) = ${key}`)
    .limit(1);
  return row ?? null;
}

export async function findUserById(id: string): Promise<AddressedUser | null> {
  if (!id) return null;
  const [row] = await readPublic().select(USER_ADDRESS_COLUMNS).from(user).where(eq(user.id, id)).limit(1);
  return row ?? null;
}

export function canonicalProfilePath(person: Pick<AddressedUser, "username">): string | null {
  return profileAddressPath(person.username);
}

/** Percent-decode a request path for comparison; a malformed path is returned as-is. */
export function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Build a redirect target: the canonical path, encoded, with the original query string kept. */
export function redirectTarget(canonicalPath: string, requestUrl: string): string {
  const search = new URL(requestUrl).search;
  return `${encodeURI(canonicalPath)}${search}`;
}
