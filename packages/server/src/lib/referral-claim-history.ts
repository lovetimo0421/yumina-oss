export type ReferralClaims = { epoch: string; milestones: number[] };

/** Keep only claims from the active reward period when identities are merged. */
export function mergeReferralClaims(
  epoch: Date,
  currentMilestones: readonly number[],
  priorClaims: readonly (ReferralClaims | null | undefined)[],
): ReferralClaims {
  const epochKey = epoch.toISOString();
  const milestones = new Set(currentMilestones);
  for (const prior of priorClaims) {
    if (prior?.epoch !== epochKey) continue;
    for (const milestone of prior.milestones) milestones.add(milestone);
  }
  return { epoch: epochKey, milestones: [...milestones].sort((a, b) => a - b) };
}
