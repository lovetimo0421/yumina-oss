import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allowsOfficialKeyFallback } from "./provider-selection-policy.js";

const source = readFileSync(new URL("./resolve-provider.ts", import.meta.url), "utf8");

test("private/BYOK mode fails closed by default", () => {
  assert.equal(allowsOfficialKeyFallback("private"), false);
  assert.equal(allowsOfficialKeyFallback("private", false), false);
});

test("private/BYOK mode permits only an explicit official-key fallback", () => {
  assert.equal(allowsOfficialKeyFallback("private", true), true);
});

test("official mode continues to use the official key path", () => {
  assert.equal(allowsOfficialKeyFallback("official"), true);
});

test("user-owned keys use the BYOK provider factory", () => {
  assert.match(source, /provider: createByokProvider\(providerName, apiKey\)/);
  assert.match(source, /provider: createByokProvider\("openrouter", orKey\)/);
});

test("the resolver enforces the fail-closed billing policy", () => {
  assert.match(
    source,
    /if \(!allowsOfficialKeyFallback\(preferredProvider, options\?\.allowOfficialFallback\)\) return null;/,
  );
});
