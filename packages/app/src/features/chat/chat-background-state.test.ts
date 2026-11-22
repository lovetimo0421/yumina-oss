import assert from "node:assert/strict";
import test from "node:test";
import { resolveBackground, type WorldDefinition } from "@yumina/engine";
import { chatBackgroundState } from "./chat-background-state";

// The shape of a real card (11/08): every background tied to openings, none free.
const backgrounds = [
  { id: "bg1", url: "@cover", name: "Cover", scene: "Default.", isDefault: true, dim: 33, opacity: 75, blur: 0, greetingIds: ["interview", "thief"] },
  { id: "bg3", url: "https://cdn.test/bar.png", name: "Bar", scene: "At the bar", isDefault: false, blur: 0, greetingIds: ["bar"] },
] as unknown as WorldDefinition["backgrounds"];

const resolve = (sessionState: unknown, vars: Record<string, unknown> | null) => {
  const state = chatBackgroundState(sessionState, vars);
  return resolveBackground({ backgrounds }, state, { activeGreetingId: state.activeGreetingId, coverUrl: "https://cdn.test/cover.jpg" });
};

test("a background tied to the opening being played shows in chat", () => {
  const live = { hp: 1 };
  assert.equal(resolve({ variables: live, activeGreetingId: "interview" }, live)?.url, "https://cdn.test/cover.jpg");
  assert.equal(resolve({ variables: live, activeGreetingId: "bar" }, live)?.url, "https://cdn.test/bar.png");
});

test("the variables map alone (what chat used to pass) finds nothing for such a card", () => {
  const live = { hp: 1 };
  assert.equal(resolveBackground({ backgrounds }, live as never, { activeGreetingId: null, coverUrl: "https://cdn.test/cover.jpg" }), null);
});

test("the AI's pick in session metadata wins over the opening", () => {
  assert.equal(resolve({ variables: {}, metadata: { currentBg: "bg3" }, activeGreetingId: "interview" }, {})?.id, "bg3");
});

test("live variables override the session copy, and a missing session state is safe", () => {
  assert.deepEqual(chatBackgroundState({ variables: { a: 1 }, activeGreetingId: "x" }, { a: 2 }).variables, { a: 2 });
  assert.deepEqual(chatBackgroundState(null, null), { variables: {}, metadata: undefined, activeGreetingId: null });
});
