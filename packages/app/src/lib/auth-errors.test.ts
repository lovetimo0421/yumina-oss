import assert from "node:assert/strict";
import test from "node:test";
import { getAuthErrorKey } from "./auth-errors.js";

test("known auth errors map to localized copy", () => {
  assert.equal(getAuthErrorKey({ code: "RATE_LIMITED" }), "errors.rateLimited");
});

test("retired registration cooling-off errors are no longer special-cased", () => {
  assert.equal(
    getAuthErrorKey({ code: "ACCOUNT_RE_REGISTRATION_COOLDOWN" }),
    "errors.generic",
  );
});
