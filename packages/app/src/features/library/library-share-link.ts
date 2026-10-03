import type { WorldItem } from "@/stores/worlds";

/** Use the selected card, never its source, for a public share link. */
export function getLibraryShareUrl(
  world: Pick<WorldItem, "id" | "isPublished" | "schema">,
  origin: string,
  publicWorldUrl: (origin: string, worldId: string, gamePath?: unknown) => string,
): string {
  if (world.isPublished) {
    return publicWorldUrl(origin, world.id, (world.schema?.game as { path?: unknown } | undefined)?.path);
  }
  return `${origin}/app/library?worldId=${encodeURIComponent(world.id)}`;
}
