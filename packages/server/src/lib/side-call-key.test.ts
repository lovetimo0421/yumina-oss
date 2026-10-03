import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAYER_KEY_DENY_TTL_MS,
  isOpenRouterUrl,
  markPlayerKeyDenied,
  playerKeyDenied,
  resetPlayerKeyDenials,
  sideCallTier,
} from "./side-call-key.js";

test("a refused player key is remembered per user, key and scope, for a short window", () => {
  resetPlayerKeyDenials();
  const key = { userId: "u", apiKey: "sk-or-v1-a" };
  const now = 1_000_000;
  markPlayerKeyDenied(key, "decisions", now);
  assert.equal(playerKeyDenied(key, "decisions", now + 1000), true);
  assert.equal(playerKeyDenied(key, "chat", now + 1000), false, "decisions access says nothing about chat");
  assert.equal(playerKeyDenied({ ...key, apiKey: "sk-or-v1-b" }, "decisions", now + 1000), false, "a new key is tried afresh");
  assert.equal(playerKeyDenied({ ...key, userId: "v" }, "decisions", now + 1000), false);
  assert.equal(playerKeyDenied(key, "decisions", now + PLAYER_KEY_DENY_TTL_MS + 1), false, "expires");
});

test("only OpenRouter over https may receive a player's key", () => {
  assert.equal(isOpenRouterUrl("https://openrouter.ai/api/alpha/decisions"), true);
  assert.equal(isOpenRouterUrl("http://openrouter.ai/api/alpha/decisions"), false);
  assert.equal(isOpenRouterUrl("https://openrouter.ai.evil.example/x"), false);
  assert.equal(isOpenRouterUrl("https://api.typesafe.example/decisions"), false);
  assert.equal(isOpenRouterUrl("not a url"), false);
});

test("usage tier: the player's key is byok, the platform's is regular", () => {
  assert.equal(sideCallTier("byok"), "byok");
  assert.equal(sideCallTier("platform"), "regular");
});
