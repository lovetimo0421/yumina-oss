import assert from "node:assert/strict";
import test from "node:test";
import { __resetEditorialCache, getEditorialBoostForCandidate } from "./editorial.js";

test("getEditorialBoostForCandidate prefers languageGroup over worldId", async () => {
  __resetEditorialCache();
  const fakeRows = [
    { worldId: "w1", languageGroupId: null, scoreBoost: 5, startsAt: null, endsAt: null },
    { worldId: null, languageGroupId: "lg1", scoreBoost: 30, startsAt: null, endsAt: null },
  ];
  const candidate = { id: "w1", languageGroupId: "lg1" };
  const score = await getEditorialBoostForCandidate(candidate, async () => fakeRows);
  assert.equal(score, 30);
});

test("expired (endsAt < now) boosts are ignored", async () => {
  __resetEditorialCache();
  const past = new Date(Date.now() - 86_400_000);
  const score = await getEditorialBoostForCandidate(
    { id: "w1", languageGroupId: null },
    async () => [{ worldId: "w1", languageGroupId: null, scoreBoost: 99, startsAt: null, endsAt: past }],
  );
  assert.equal(score, 0);
});

test("loader is cached for 60 seconds", async () => {
  __resetEditorialCache();
  let calls = 0;
  const loader = async () => { calls += 1; return []; };
  await getEditorialBoostForCandidate({ id: "x", languageGroupId: null }, loader);
  await getEditorialBoostForCandidate({ id: "y", languageGroupId: null }, loader);
  assert.equal(calls, 1, "second call within TTL should hit cache");
});

test("worldId match returns its boost when no languageGroup match", async () => {
  __resetEditorialCache();
  const score = await getEditorialBoostForCandidate(
    { id: "wA", languageGroupId: null },
    async () => [{ worldId: "wA", languageGroupId: null, scoreBoost: 18, startsAt: null, endsAt: null }],
  );
  assert.equal(score, 18);
});

test("returns 0 when no matches", async () => {
  __resetEditorialCache();
  const score = await getEditorialBoostForCandidate(
    { id: "missing", languageGroupId: "missing-lg" },
    async () => [],
  );
  assert.equal(score, 0);
});
