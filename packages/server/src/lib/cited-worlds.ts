import { worldAudienceCondition } from "./world-publication-access.js";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { follows, worlds } from "../db/schema.js";
import { aggregatedCounters } from "./world-aggregates.js";
import { pickViewerVariantId, type VariantRow } from "./variant-pick.js";
import { normalizeWorldLanguage } from "./world-language.js";

/** Lean fields used by feed and reply card embeds, plus variant-ranking data. */
export const citedWorldCardSelect = {
  id: worlds.id,
  name: worlds.name,
  thumbnailUrl: worlds.thumbnailUrl,
  language: worlds.language,
  languageGroupId: worlds.languageGroupId,
  isPrimaryVariant: worlds.isPrimaryVariant,
  status: worlds.status,
  isPublished: worlds.isPublished,
  ageRating: worlds.ageRating,
  allowCommunityCitations: worlds.allowCommunityCitations,
  createdAt: worlds.createdAt,
} as const;

/** Full fields used by the thread detail card. */
export const citedWorldSelect = {
  ...citedWorldCardSelect,
  description: worlds.description,
  creatorId: worlds.creatorId,
  downloadCount: aggregatedCounters.downloadCount,
  averageRating: aggregatedCounters.averageRating,
} as const;

export type CitedWorldCard = {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  language: string | null;
  languageGroupId: string | null;
  isPrimaryVariant: boolean | null;
  status: string;
  isPublished: boolean | null;
  ageRating: string;
  allowCommunityCitations: boolean;
  createdAt: Date | null;
};

export type CitedWorld = CitedWorldCard & {
  description: string | null;
  creatorId: string;
  downloadCount: number;
  averageRating: number;
};

const citedWorldDetailCandidateSelect = {
  ...citedWorldCardSelect,
  description: worlds.description,
  creatorId: worlds.creatorId,
} as const;

type CitedWorldCandidate = CitedWorldCard & {
  description?: string | null;
  creatorId?: string;
};

function hasDetailFields(world: CitedWorldCard): world is CitedWorld {
  return "description" in world && "creatorId" in world && "downloadCount" in world && "averageRating" in world;
}

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
export async function resolveCitedWorlds<T extends CitedWorldCard>(
  rd: Database,
  cited: T[],
  preferredLang: string | null,
  viewerId: string | null = null,
): Promise<Map<string, T>> {
  const byCitedId = new Map<string, T>(cited.map((w) => [w.id, w]));
  const desiredLanguage = normalizeWorldLanguage(preferredLang);
  if (!desiredLanguage) return byCitedId;

  const needsResolution = cited.filter(
    (w) => w.languageGroupId && normalizeWorldLanguage(w.language) !== desiredLanguage,
  );
  const groupIds = [
    ...new Set(needsResolution.map((w) => w.languageGroupId).filter((g): g is string => !!g)),
  ];
  if (groupIds.length === 0) return byCitedId;

  const visibilityCondition = viewerId
    ? (or(
        eq(worlds.visibility, "public"),
        eq(worlds.creatorId, viewerId),
        and(
          eq(worlds.visibility, "followers"),
          sql`EXISTS (
            SELECT 1
            FROM ${follows}
            WHERE ${follows.followerId} = ${viewerId}
              AND ${follows.followingId} = ${worlds.creatorId}
          )`,
        ),
      ) ?? sql`FALSE`)
    : eq(worlds.visibility, "public");

  const includeDetails = cited.some(hasDetailFields);
  const candidates = (await rd
    .select(includeDetails ? citedWorldDetailCandidateSelect : citedWorldCardSelect)
    .from(worlds)
    .where(
      and(
        inArray(worlds.languageGroupId, groupIds),
        worldAudienceCondition(worlds.creatorId),
        eq(worlds.status, "published"),
        worldAudienceCondition(worlds.creatorId),
      eq(worlds.isPublished, true),
        eq(worlds.allowCommunityCitations, true),
        visibilityCondition,
      ),
    )) as CitedWorldCandidate[];

  // Keep the eligibility rule explicit in memory as a defensive backstop. It
  // also prevents a stale replica or future query refactor from surfacing a
  // draft sibling in a public community embed.
  const eligibleCandidates = candidates.filter(
    (w) =>
      w.status === "published" &&
      w.isPublished === true &&
      w.allowCommunityCitations === true,
  );
  const byId = new Map(eligibleCandidates.map((w) => [w.id, w]));
  const candidatesByGroup = new Map<string, CitedWorldCandidate[]>();
  for (const candidate of eligibleCandidates) {
    if (!candidate.languageGroupId) continue;
    const group = candidatesByGroup.get(candidate.languageGroupId) ?? [];
    group.push(candidate);
    candidatesByGroup.set(candidate.languageGroupId, group);
  }
  const picked = new Map<string, string>();
  for (const original of needsResolution) {
    // A safe citation must never become an adult card merely because its
    // language sibling is classified differently.
    const groupCandidates = original.languageGroupId
      ? (candidatesByGroup.get(original.languageGroupId) ?? [])
      : [];
    const safeCandidates =
      original.ageRating === "all"
        ? groupCandidates.filter((candidate) => candidate.ageRating === "all")
        : groupCandidates;
    picked.set(
      original.id,
      pickViewerVariantId(
        original as VariantRow,
        safeCandidates as VariantRow[],
        preferredLang,
      ),
    );
  }
  for (const [citedId, resolvedId] of picked) {
    if (citedId === resolvedId) continue;
    const row = byId.get(resolvedId);
    const original = byCitedId.get(citedId);
    if (!row || !original) continue;

    // The counters are language-group aggregates, so avoid recalculating their
    // correlated subqueries for every candidate and reuse the cited row's values.
    const resolved = hasDetailFields(original)
      ? {
          ...row,
          downloadCount: original.downloadCount,
          averageRating: original.averageRating,
        }
      : row;
    byCitedId.set(citedId, resolved as T);
  }
  return byCitedId;
}
