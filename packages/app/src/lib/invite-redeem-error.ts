const inviteRedeemErrorKeys = {
  INVITE_REWARD_ALREADY_USED: "inviteRewardAlreadyUsed",
  INVALID_INVITE_CODE_FORMAT: "invalidInviteCodeFormat",
  INVITE_CODE_ALREADY_REDEEMED: "inviteCodeAlreadyRedeemed",
  INVITE_CODE_DISABLED: "inviteCodeDisabled",
  INVITE_CODE_REDEMPTION_LIMIT_REACHED: "inviteCodeRedemptionLimitReached",
  INVALID_INVITE_CODE: "invalidInviteCode",
  OWN_REFERRAL_CODE: "ownReferralCode",
  REFERRAL_CODE_ALREADY_USED: "referralCodeAlreadyUsed",
  INVITE_WINDOW_CLOSED: "inviteWindowClosed",
} as const;

export function getInviteRedeemErrorKey(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return inviteRedeemErrorKeys[code as keyof typeof inviteRedeemErrorKeys] ?? null;
}
