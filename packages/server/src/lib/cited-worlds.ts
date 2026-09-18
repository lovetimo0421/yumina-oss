import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { worlds } from "../db/schema.js";
import { aggregatedCounters } from "./world-aggregates.js";
import { pickViewerVariantIds, type VariantRow } from "./variant-pick.js";

/** Display fields a cited-card embed needs, for whichever variant we resolve to. */
export const citedWorldSelect = {
  id: worlds.id,
  name: worlds.name,
  description: worlds.description,
  thumbnailUrl: worlds.thumbnailUrl,
  creatorId: worlds.creatorId,
  language: worlds.language,
  languageGroupId: worlds.languageGroupId,
  isPrimaryVariant: worlds.isPrimaryVariant,
  createdAt: worlds.createdAt,
  downloadCount: aggregatedCounters.downloadCount,
  averageRating: aggregatedCounters.averageRating,
} as const;

export type CitedWorld = {
  id: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  creatorId: string;
  language: string | null;
  languageGroupId: string | null;
  isPrimaryVariant: boolean | null;
  createdAt: Date | null;
  downloadCount: number;
  averageRating: number;
};

/**
 * A community thread or reply cites one concrete world id — whichever variant
 * the author played, in practice almost always the Chinese one. Swap each
 * citation to the sibling in the VIEWER's language so an English reader doesn't
 * get a Chinese card name, cover and Play target. Falls back to the card the
 * author actually cited whenever the group has no published sibling for that
 * language: never a worse language match than the original.
 *
 * Costs one extra query, and only when the viewer has a language AND at least
 * one cited card belongs to a language group.
 *
 * Display-only. The citation row in `thread_worlds` / `post_worlds` is
 * untouched, so the cited-owner delete authorization — which reads those tables
 * directly rather than the response — is unaffected.
 */
export async function resolveCitedWorlds(
  rd: Database,
  cited: CitedWorld[],
  preferredLang: string | null,
): Promise<Map<string, CitedWorld>> {
  const byCitedId = new Map<string, CitedWorld>(cited.map((w) => [w.id, w]));
  const groupIds = [...new Set(cited.map((w) => w.languageGroupId).filter((g): g is string => !!g))];
  if (!preferredLang || groupIds.length === 0) return byCitedId;

  const candidates = (await rd
    .select(citedWorldSelect)
    .from(worlds)
    .where(
      and(
        inArray(worlds.languageGroupId, groupIds),
        eq(worlds.status, "published"),
        eq(worlds.isPublished, true),
        // Only swap to siblings anyone can open: a followers-only sibling
        // would send non-followers to a blocked detail page, which is worse
        // than falling back to the originally cited card.
        eq(worlds.visibility, "public"),
      ),
    )) as CitedWorld[];

  const byId = new Map(candidates.map((w) => [w.id, w]));
  const picked = pickViewerVariantIds(cited as VariantRow[], candidates as VariantRow[], preferredLang);
  for (const [citedId, resolvedId] of picked) {
    if (citedId === resolvedId) continue;
    const row = byId.get(resolvedId);
    if (row) byCitedId.set(citedId, row);
  }
  return byCitedId;
}
