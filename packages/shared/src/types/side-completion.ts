import { z } from "zod";

/** Per-call native worldbook allowlist for context:'session' side completions.
 * Omitted keeps the world's normal selection; [] keeps only ungrouped Core.
 * Selected books still obey their enabled/activation/entry gates. */
export const sideCompletionWorldbookIdsSchema = z.array(z.string().min(1).max(128)).max(32).refine(
  ids => new Set(ids).size === ids.length,
  { message: "worldbookIds must contain unique book IDs" },
);

export type SideCompletionWorldbookIds = z.infer<typeof sideCompletionWorldbookIdsSchema>;
