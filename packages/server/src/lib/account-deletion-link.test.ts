import assert from "node:assert/strict";
import test from "node:test";
import { buildAccountDeletionConfirmationUrl } from "./account-deletion-link.js";

test("account deletion link uses the configured production origin", () => {
  assert.equal(
    buildAccountDeletionConfirmationUrl(
      "https://yumina.io",
      "0123456789abcdef",
    ),
    "https://yumina.io/delete-account#token=0123456789abcdef", // gitleaks:allow (fixture, not a credential)
  );
});

test("account deletion link discards APP_URL paths and keeps tokens out of the query", () => {
  const result = buildAccountDeletionConfirmationUrl(
    "https://yumina.io/app/settings?source=test#old",
    "token with symbols + / =",
  );
  const url = new URL(result);

  assert.equal(url.origin, "https://yumina.io");
  assert.equal(url.pathname, "/delete-account");
  assert.equal(url.search, "");
  assert.equal(
    new URLSearchParams(url.hash.slice(1)).get("token"),
    "token with symbols + / =",
  );
});
