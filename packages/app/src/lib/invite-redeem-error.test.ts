import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getInviteRedeemErrorKey } from "./invite-redeem-error.js";

const errorKeys = [
  "inviteRewardAlreadyUsed",
  "invalidInviteCodeFormat",
  "inviteCodeAlreadyRedeemed",
  "inviteCodeDisabled",
  "inviteCodeRedemptionLimitReached",
  "invalidInviteCode",
  "ownReferralCode",
  "referralCodeAlreadyUsed",
] as const;

test("maps invite redemption API errors to localized reason keys", () => {
  const cases = [
    ["INVITE_REWARD_ALREADY_USED", "inviteRewardAlreadyUsed"],
    ["INVALID_INVITE_CODE_FORMAT", "invalidInviteCodeFormat"],
    ["INVITE_CODE_ALREADY_REDEEMED", "inviteCodeAlreadyRedeemed"],
    ["INVITE_CODE_DISABLED", "inviteCodeDisabled"],
    ["INVITE_CODE_REDEMPTION_LIMIT_REACHED", "inviteCodeRedemptionLimitReached"],
    ["INVALID_INVITE_CODE", "invalidInviteCode"],
    ["OWN_REFERRAL_CODE", "ownReferralCode"],
    ["REFERRAL_CODE_ALREADY_USED", "referralCodeAlreadyUsed"],
  ] as const;

  for (const [code, key] of cases) {
    assert.equal(getInviteRedeemErrorKey(code), key);
  }
});

test("does not invent a translation for unknown API errors", () => {
  assert.equal(getInviteRedeemErrorKey("SOMETHING_NEW"), null);
  assert.equal(getInviteRedeemErrorKey(null), null);
});

test("every supported locale explains every invite redemption error", () => {
  for (const locale of ["en", "es", "ja", "zh", "zh-Hant"]) {
    const translations = JSON.parse(readFileSync(
      new URL(`../locales/${locale}/toasts.json`, import.meta.url),
      "utf8",
    )) as Record<string, unknown>;

    for (const key of errorKeys) {
      assert.equal(
        typeof translations[key],
        "string",
        `${locale} is missing toasts:${key}`,
      );
    }
  }
});
