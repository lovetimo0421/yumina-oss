/**
 * Principle: a creator's edits to their OWN published world take effect
 * immediately for the creator (preview, play, prompt), while everyone else keeps
 * seeing the last-approved live version until an admin approves the held edit.
 *
 * This pure gate decides whether a given viewer should be served the held
 * working copy (when one exists) instead of the live schema. It is deliberately
 * dependency-free so the play routes (sessions / messages / combat) can all
 * share one definition and it can be unit-tested without a DB.
 *
 * Security note: returning `true` for a non-creator would leak unapproved
 * content to players — the `creatorId === viewerId` check is load-bearing.
 */
export function viewerSeesWorkingCopy(
  status: string,
  creatorId: string,
  viewerId: string,
): boolean {
  return status === "published" && creatorId === viewerId;
}
