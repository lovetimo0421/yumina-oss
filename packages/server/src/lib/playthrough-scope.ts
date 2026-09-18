import { normalizeWorldLanguage } from "./world-language.js";

export interface PlaythroughScopeWorld {
  id: string;
  language: string | null;
}

/**
 * Which worldIds a card's shared-playthrough gallery should pull from.
 *
 * A share is created on the exact variant the player played, but the hub keys a
 * card's page on the sibling matching the VIEWER's language (see the featured /
 * hub list routes, which pick the preferred-language row per languageGroup).
 * Two things follow:
 *
 *   - Scoping the gallery to a single worldId hides a share made on a
 *     same-language SIBLING — a language group holds one 主 (primary) row plus
 *     any number of non-primary rows per language, and the page always keys on
 *     the 主. That was the bug b906be29 fixed.
 *   - Scoping it to the WHOLE language group leaks across languages: an English
 *     viewer got a gallery of Chinese chat logs they can't read (reported
 *     2026-07-24 on IVE Simulator, where the en page listed 「IVE 模拟器」).
 *
 * The correct scope is the middle one: every sibling that shares the page
 * world's own content language. Language is compared through
 * `normalizeWorldLanguage` so `zh-TW`/`zh-Hant`/`zh-CN` rows stay in one bucket,
 * matching how the rest of the hub buckets languages. An untagged page world
 * (language = null) only ever aggregates other untagged siblings — never a row
 * whose language is known to differ.
 */
export function playthroughGalleryWorldIds(
  page: PlaythroughScopeWorld,
  siblings: PlaythroughScopeWorld[],
): string[] {
  const pageLang = normalizeWorldLanguage(page.language);
  const ids = siblings
    .filter((s) => normalizeWorldLanguage(s.language) === pageLang)
    .map((s) => s.id);
  // The page's own world is always in scope, even if the sibling read raced a
  // write or came back empty.
  return ids.includes(page.id) ? ids : [page.id, ...ids];
}
