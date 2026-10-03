type DeletedIdentityRegistrationState = {
  wasBanned: boolean;
  wasSuspended?: boolean;
} | null | undefined;

/** Prior deletion alone never blocks signup; retained restrictions still do. */
export function isDeletedIdentityRegistrationBlocked(
  identity: DeletedIdentityRegistrationState,
): boolean {
  return identity?.wasBanned === true || identity?.wasSuspended === true;
}
