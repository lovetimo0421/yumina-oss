export const WORLD_UPDATE_PAGE_SIZE = 20;
export const WORLD_UPDATE_MAX_OFFSET = 10_000;

export function normalizeWorldUpdateOffset(rawOffset: string | undefined): number {
  if (!rawOffset || !/^\d+$/.test(rawOffset)) return 0;
  const bounded = Math.min(Number(rawOffset), WORLD_UPDATE_MAX_OFFSET);
  return Math.floor(bounded / WORLD_UPDATE_PAGE_SIZE) * WORLD_UPDATE_PAGE_SIZE;
}

export function canReadWorldUpdateHistory({
  status,
  visibility,
  isOwner,
  isAdmin,
  isFollower,
}: {
  status: string;
  visibility: string;
  isOwner: boolean;
  isAdmin: boolean;
  isFollower: boolean;
}): boolean {
  const canReadRestricted = isOwner || isAdmin || isFollower;
  if (status !== "published") return isOwner || isAdmin;
  return visibility === "public" || canReadRestricted;
}

export function hasMoreWorldUpdates(rowCount: number, offset: number): boolean {
  return offset < WORLD_UPDATE_MAX_OFFSET && rowCount > WORLD_UPDATE_PAGE_SIZE;
}
