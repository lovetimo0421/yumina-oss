export type AccountDeletionAccessBlockCode = "LAST_ADMIN_ACCOUNT";

export type AccountDeletionAccessDecision =
  | { allowed: true }
  | {
    allowed: false;
    code: AccountDeletionAccessBlockCode;
    message: string;
  };

/**
 * Account deletion is available to every authenticated account. The sole
 * role-level guard protects service continuity: an administrator cannot
 * delete the final active administrator account.
 */
export function evaluateAccountDeletionAccess(
  role: string | null | undefined,
  activeAdministratorCount: number,
): AccountDeletionAccessDecision {
  if (
    role === "admin"
    && (!Number.isSafeInteger(activeAdministratorCount) || activeAdministratorCount <= 1)
  ) {
    return {
      allowed: false,
      code: "LAST_ADMIN_ACCOUNT",
      message: "The final administrator account cannot be deleted.",
    };
  }

  return { allowed: true };
}
