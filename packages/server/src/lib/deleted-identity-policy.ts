type DeletedIdentityRegistrationState = {
  wasBanned: boolean;
} | null | undefined;

/** Prior deletion alone never blocks signup; retained bans still do. */
export function isDeletedIdentityRegistrationBlocked(
  identity: DeletedIdentityRegistrationState,
): boolean {
  return identity?.wasBanned === true;
}
