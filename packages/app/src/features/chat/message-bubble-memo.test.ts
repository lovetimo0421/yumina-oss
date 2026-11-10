import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// The transcript's bubbles are memoised so a streamed chunk redraws one bubble,
// not every message. What the memo compares decides whether a card's own
// bubble renderer ever sees its state change (Muv-Luv's "Insert as Someone
// Else" toggled card state and the opening never drew the name box).

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
// The sandbox bundle reads React as a global, as the iframe provides it.
const React = await import("react");
const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React };
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

const { messageBubblePropsEqual } = await import("../../../sandbox/chat/message-bubble");

const message = { id: "m1", sessionId: "s", role: "assistant" as const, content: "Hello", createdAt: "2026-10-13T00:00:00Z" };
const vars = { hp: 10 };
const base = { message, variables: vars, rendererEpoch: 3, messageIndex: 0 };

test("a bubble with nothing new is skipped", () => {
  assert.equal(messageBubblePropsEqual(base, { ...base, message: { ...message } }), true);
});

test("new game state redraws the bubble", () => {
  assert.equal(messageBubblePropsEqual(base, { ...base, variables: { hp: 9 } }), false);
});

test("the card's own state moving redraws a live bubble", () => {
  assert.equal(messageBubblePropsEqual(base, { ...base, rendererEpoch: 4 }), false);
});

test("bubbles that are not handed the epoch stay put while it moves", () => {
  const old = { ...base, rendererEpoch: undefined };
  assert.equal(messageBubblePropsEqual(old, { ...old }), true);
});
