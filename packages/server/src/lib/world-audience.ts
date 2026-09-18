import {
  AUDIENCE_TAG_MALE,
  AUDIENCE_TAG_FEMALE,
  clampWorldTags,
  syncAudienceTags,
  type TargetAudience,
} from "@yumina/shared";

function hasBothAudienceTags(tags: string[]): boolean {
  const normalized = clampWorldTags(tags);
  return normalized.includes(AUDIENCE_TAG_MALE) && normalized.includes(AUDIENCE_TAG_FEMALE);
}

/** Resolve the tags and settings field together before a metadata write. */
export function resolveWorldAudience(
  tags: string[],
  targetAudience: TargetAudience,
  preserveBoth = true,
): { tags: string[]; targetAudience: TargetAudience } {
  const normalized = clampWorldTags(tags);
  // Publishing always resends the form's audience, which may predate a tags
  // edit. Explicit dual tags take precedence. An audience-only PATCH can still
  // deliberately switch to a single audience by passing preserveBoth=false.
  const effectiveAudience = preserveBoth && hasBothAudienceTags(normalized)
    ? "all"
    : targetAudience;
  return {
    tags: syncAudienceTags(normalized, effectiveAudience),
    targetAudience: effectiveAudience,
  };
}

/** An edit sends targetAudience only when the creator deliberately changes it. */
export function resolveWorldAudienceEdit(
  currentTags: string[],
  submittedTags: string[] | undefined,
  targetAudience: TargetAudience,
): { tags: string[]; targetAudience: TargetAudience } {
  // Adding the second audience tag is explicit intent to keep both. If both
  // already existed, an accompanying ordinary-tag edit must not cancel the
  // creator's deliberate audience switch.
  return resolveWorldAudience(
    submittedTags ?? currentTags,
    targetAudience,
    submittedTags !== undefined && !hasBothAudienceTags(currentTags),
  );
}
