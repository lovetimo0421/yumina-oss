/**
 * Fork attribution ("Based on X by Y") — when it is real credit and when it is
 * an artifact of how language variants get made.
 *
 * A translated variant is usually produced by copying the original card and
 * then linking the copy into the same language group, which leaves
 * `sourceWorldId` pointing at what is now a sibling. Rendering that made the
 * English card read "Based on 绝世唐门 by mia~" — attributed to its own Chinese
 * self. Same creator + same language group means translation, not derivation.
 *
 * A source by a *different* creator stays attributed even inside a shared
 * group (someone translating another author's card still owes them credit).
 *
 * The server applies the same rule when it fills `sourceWorldName` /
 * `sourceCreator*` (see `forkSourceMatch` in server routes/worlds.ts). This
 * helper covers the client-side fallbacks that resolve the source out of the
 * local worlds store instead.
 */

interface AttributionSide {
  creatorId?: string | null;
  languageGroupId?: string | null;
}

export function isOwnTranslationSource(
  world: AttributionSide,
  source: AttributionSide | null | undefined,
): boolean {
  if (!source) return false;
  if (!world.languageGroupId || !source.languageGroupId) return false;
  if (world.languageGroupId !== source.languageGroupId) return false;
  return !!world.creatorId && world.creatorId === source.creatorId;
}
