import assert from "node:assert/strict";
import test from "node:test";
import { parseSafeAuthReturnTo, readSafeAuthReturnTo } from "./auth-return.js";

test("auth return accepts only the account-deletion landing page", () => {
  assert.equal(parseSafeAuthReturnTo("/delete-account"), "/delete-account");
  assert.equal(
    readSafeAuthReturnTo("?returnTo=%2Fdelete-account"),
    "/delete-account",
  );
});

test("auth return rejects external and unapproved destinations", () => {
  assert.equal(parseSafeAuthReturnTo("https://evil.example"), undefined);
  assert.equal(parseSafeAuthReturnTo("//evil.example"), undefined);
  assert.equal(parseSafeAuthReturnTo("/app/admin"), undefined);
});

test("auth return accepts a first-party game path, path-only", () => {
  assert.equal(parseSafeAuthReturnTo("/pvz/?join=AB12"), "/pvz/?join=AB12");
  assert.equal(readSafeAuthReturnTo("?returnTo=%2Fpvz%2F%3Fjoin%3DAB12"), "/pvz/?join=AB12");
  assert.equal(parseSafeAuthReturnTo("//pvz/evil"), undefined);
  assert.equal(parseSafeAuthReturnTo("/pvz/" + "x".repeat(300)), undefined);
});

test("auth return accepts the krew page with or without an encoded deep link", () => {
  assert.equal(parseSafeAuthReturnTo("/krew"), "/krew");
  assert.equal(
    parseSafeAuthReturnTo("/krew?path=%2Fclan%2Fabc%3Ftab%3Dmembers"),
    "/krew?path=%2Fclan%2Fabc%3Ftab%3Dmembers",
  );
  assert.equal(readSafeAuthReturnTo("?returnTo=%2Fkrew"), "/krew");
  assert.equal(parseSafeAuthReturnTo("/krewish"), undefined);
  assert.equal(parseSafeAuthReturnTo("/krew/evil"), undefined);
  assert.equal(parseSafeAuthReturnTo("//krew"), undefined);
  assert.equal(parseSafeAuthReturnTo("/krew?path=" + "x".repeat(800)), undefined);
});
