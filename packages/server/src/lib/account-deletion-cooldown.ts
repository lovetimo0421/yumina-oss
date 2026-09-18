export const ACCOUNT_DELETION_COOLDOWN_DAYS = 3;
export const ACCOUNT_DELETION_COOLDOWN_MS =
  ACCOUNT_DELETION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

/**
 * Returns the first instant at which a recreated account may be deleted,
 * or null once three days have elapsed since the identity's last deletion.
 */
export function accountDeletionBlockedUntil(
  latestDeletionAt: Date | null | undefined,
  now = new Date(),
): Date | null {
  if (!latestDeletionAt) return null;
  const blockedUntil = new Date(
    latestDeletionAt.getTime() + ACCOUNT_DELETION_COOLDOWN_MS,
  );
  return blockedUntil.getTime() > now.getTime() ? blockedUntil : null;
}
