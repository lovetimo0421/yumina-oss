import assert from "node:assert/strict";
import test from "node:test";
import type { GameState, Worldbook } from "@yumina/engine";
import { hasGroupVoices, nextGroupVoice } from "./group-voices";

const books = [
  { id: "cat", name: "店猫", order: 0, host: "card", activation: { mode: "always" }, station: { kind: "narrator" } },
  { id: "owl", name: "猫头鹰", order: 1, host: "card", activation: { mode: "always" }, station: { kind: "narrator" } },
] as unknown as Worldbook[];
const state = { variables: {}, turnCount: 1 } as unknown as GameState;
const said = (role: string, voice?: string, status = "complete") => ({ role, status, swipes: voice ? [{ voice }] : [{}], activeSwipeIndex: 0 });

test("a card with an AI living on it has group chats; one without does not", () => {
  assert.equal(hasGroupVoices(books), true);
  assert.equal(hasGroupVoices([{ ...books[0]!, host: undefined }] as Worldbook[]), false);
});

test("after the narrator answers, the AIs on the card follow in order, once each", () => {
  assert.equal(nextGroupVoice(books, state, [said("user"), said("assistant")])?.id, "cat");
  assert.equal(nextGroupVoice(books, state, [said("user"), said("assistant"), said("assistant", "cat")])?.id, "owl");
  assert.equal(nextGroupVoice(books, state, [said("user"), said("assistant"), said("assistant", "cat"), said("assistant", "owl")]), null);
});

test("nobody follows before the first answer lands", () => {
  assert.equal(nextGroupVoice(books, state, [said("user")]), null);
  assert.equal(nextGroupVoice(books, state, [said("user"), said("assistant", undefined, "failed")]), null);
});
