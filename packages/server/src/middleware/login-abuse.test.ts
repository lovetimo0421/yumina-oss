import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLoginIdentifier, LOGIN_STEPUP_THRESHOLD } from "./login-abuse.js";

test("extractLoginIdentifier: email is lowercased + trimmed", () => {
  assert.equal(extractLoginIdentifier({ email: "  Foo@Bar.COM " }), "foo@bar.com");
});

test("extractLoginIdentifier: falls back to username", () => {
  assert.equal(extractLoginIdentifier({ username: "Alice" }), "alice");
});

test("extractLoginIdentifier: email wins over username", () => {
  assert.equal(extractLoginIdentifier({ email: "a@b.com", username: "alice" }), "a@b.com");
});

test("extractLoginIdentifier: returns '' when neither present or non-string", () => {
  assert.equal(extractLoginIdentifier({}), "");
  assert.equal(extractLoginIdentifier({ email: 123 as unknown as string }), "");
  assert.equal(extractLoginIdentifier({ password: "x" }), "");
});

test("step-up threshold is a sane positive number", () => {
  assert.ok(LOGIN_STEPUP_THRESHOLD >= 3 && LOGIN_STEPUP_THRESHOLD <= 10);
});
