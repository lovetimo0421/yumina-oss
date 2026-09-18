import { estimateTokens } from "@yumina/engine";
import { viewerSeesWorkingCopy } from "./working-copy.js";

export type WorldCopyMaterial = {
  schema: Record<string, unknown>;
  thumbnailUrl: string | null;
  ageRating: string;
  isNsfw: boolean | null;
};

type HeldCopyMaterial = {
  schema: Record<string, unknown>;
  thumbnailUrl: string | null;
  ageRating: string | null;
};

type CopyableWorld = WorldCopyMaterial & {
  id: string;
  status: string;
  creatorId: string;
};

function isAdult(rating: string | null | undefined): boolean {
  return !(rating === "all" || rating == null || rating === "");
}

/** Pure material selection for copying a live world or its creator-only held edit. */
export function selectWorldCopyMaterial(
  world: WorldCopyMaterial,
  pending: HeldCopyMaterial | null,
): WorldCopyMaterial {
  if (!pending) return world;

  // A held row is a complete proposed material snapshot. In particular, a null
  // thumbnail intentionally removes the cover; it must not fall back to live.
  // Historical null ratings publish as all-ages, matching approval behavior.
  const ageRating = pending.ageRating ?? "all";
  return {
    schema: pending.schema,
    thumbnailUrl: pending.thumbnailUrl,
    ageRating,
    isNsfw: isAdult(ageRating),
  };
}

/** Load held material only when this viewer is allowed to copy it. */
export async function resolveCopyMaterialForViewer(
  world: CopyableWorld,
  viewerId: string,
  loadHeldMaterial: (worldId: string) => Promise<HeldCopyMaterial | null>,
): Promise<WorldCopyMaterial> {
  if (!viewerSeesWorkingCopy(world.status, world.creatorId, viewerId)) {
    return selectWorldCopyMaterial(world, null);
  }

  return selectWorldCopyMaterial(world, await loadHeldMaterial(world.id));
}

/** Recompute copy metadata without trusting the shape of a legacy schema. */
export function estimateWorldCopyTokens(schema: Record<string, unknown>): number {
  try {
    const entries = schema["entries"];
    if (!Array.isArray(entries)) return 0;

    return entries.reduce((sum, entry) => {
      if (entry == null || typeof entry !== "object") return sum;
      const content = (entry as { content?: unknown }).content;
      return sum + estimateTokens(typeof content === "string" ? content : "");
    }, 0);
  } catch {
    return 0;
  }
}
