import { and, or, sql, type SQL } from "drizzle-orm";
import { canonicalizeTag, TAG_VOCABULARY } from "@yumina/shared";
import { resolveHubLanguageScope } from "./world-language.js";

export interface HubTagQueryOptions {
  currentUserId?: string;
  query?: string;
  lang?: string;
  contentLevel?: string;
  includeOtherLanguages?: boolean;
  nsfwOnly?: boolean;
  limit?: number;
}

/** Accept the current client value and older clients' content-mode values. */
export function parseContentLevelParam(raw: string | undefined): "safe" | "r18" | undefined {
  if (raw === "safe") return "safe";
  if (raw === "sensitive" || raw === "r18" || raw === "r18g") return "r18";
  return undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Search the eligible catalog before limiting results, never the popular shelf. */
export function buildHubTagQuery(options: HubTagQueryOptions): SQL {
  const lang = resolveHubLanguageScope(options.lang, options.includeOtherLanguages);
  const viewer = options.currentUserId;
  const safeOnly = !viewer || parseContentLevelParam(options.contentLevel) !== "r18";
  const query = options.query?.trim();
  const conditions: SQL[] = [sql`worlds.is_published = true`, sql`worlds.status = 'published'`];
  if (safeOnly) conditions.push(sql`worlds.age_rating = 'all'`);
  else if (options.nsfwOnly) conditions.push(sql`worlds.age_rating <> 'all'`);
  if (lang) conditions.push(sql`(worlds.language = ${lang} OR worlds.language LIKE ${`${lang}-%`})`);

  // Tag names and counts must follow the same access rules as the matching cards.
  if (viewer) {
    conditions.push(sql`(
      worlds.visibility = 'public' OR worlds.creator_id = ${viewer} OR (
        worlds.visibility = 'followers' AND EXISTS (
          SELECT 1 FROM follows WHERE follower_id = ${viewer} AND following_id = worlds.creator_id
        )
      )
    )`);
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM user_blocks WHERE blocker_id = ${viewer}
        AND blocked_id = worlds.creator_id AND hide_blocked_worlds = true
    )`);
    conditions.push(sql`NOT EXISTS (
      SELECT 1 FROM user_blocks WHERE blocked_id = ${viewer}
        AND blocker_id = worlds.creator_id AND hide_own_worlds = true
    )`);
  } else conditions.push(sql`worlds.visibility = 'public'`);

  let exactMatch: SQL | undefined;
  if (query) {
    const lower = query.toLowerCase();
    const matchingSpellings = new Set<string>();
    for (const entry of TAG_VOCABULARY) {
      const spellings = [entry.canonical, ...Object.values(entry.labels), ...(entry.aliases ?? [])];
      if (spellings.some((value) => value.toLowerCase().includes(lower))) {
        for (const value of spellings) matchingSpellings.add(value.toLowerCase());
      }
    }
    const matches = [sql`tag.value ILIKE ${`%${escapeLike(query)}%`}`];
    if (matchingSpellings.size > 0) {
      matches.push(sql`lower(tag.value) IN (${sql.join([...matchingSpellings].map((value) => sql`${value}`), sql`, `)})`);
    }
    conditions.push(or(...matches)!);
    exactMatch = sql`lower(tag.value) IN (${lower}, ${canonicalizeTag(query).toLowerCase()})`;
  }

  const requestedLimit = options.limit;
  const limit = requestedLimit !== undefined && Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50) : 20;
  return sql`SELECT tag.value AS tag, COUNT(DISTINCT worlds.id) AS count
    FROM worlds CROSS JOIN LATERAL jsonb_array_elements_text(worlds.tags) AS tag(value)
    WHERE ${and(...conditions)}
    GROUP BY tag.value
    ORDER BY ${exactMatch ? sql`CASE WHEN ${exactMatch} THEN 0 ELSE 1 END, ` : sql``}count DESC, tag.value
    LIMIT ${limit}`;
}
