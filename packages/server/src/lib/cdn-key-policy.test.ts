import assert from "node:assert/strict";
import test from "node:test";
import { resolvePublicCdnKey } from "./cdn-key-policy.js";

test("CDN lookup rejects private database keys without caching them", async () => {
  const cached: string[] = [];
  const key = await resolvePublicCdnKey(null,
    async () => "private-session-media/player/objects/image/main.webp",
    (value) => cached.push(value));
  assert.equal(key, null);
  assert.deepEqual(cached, []);
});

test("CDN lookup never reuses a forbidden cached key", async () => {
  const privateKey = "private-session-media/player/pending/upload";
  for (const result of [null, privateKey]) {
    let lookups = 0;
    const key = await resolvePublicCdnKey(privateKey, async () => {
      lookups++;
      return result;
    }, () => assert.fail("Forbidden keys must not be cached"));
    assert.equal(key, null);
    assert.equal(lookups, 1);
  }
});

test("CDN lookup permits public database keys and reuses validated cache hits", async () => {
  const publicKey = "users/player/registered/image";
  const cached: string[] = [];
  assert.equal(await resolvePublicCdnKey(null, async () => publicKey,
    (key) => cached.push(key)), publicKey);
  assert.deepEqual(cached, [publicKey]);
  assert.equal(await resolvePublicCdnKey(publicKey,
    async () => assert.fail("Public cache hit should not query the database"),
    () => assert.fail("Cache hit should not be stored again")), publicKey);
});

test("CDN lookup rejects traversal and backslash keys returned by the database", async () => {
  for (const value of ["users/../private-session-media/image", "users/player\\image"]) {
    assert.equal(await resolvePublicCdnKey(null, async () => value,
      () => assert.fail("Invalid key must not be cached")), null);
  }
});
