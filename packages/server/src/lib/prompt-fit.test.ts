import assert from "node:assert/strict";
import test from "node:test";
import { fitPromptToChars } from "./prompt-fit.js";

const sys = { role: "system" as const, content: "S".repeat(10) };

test("a prompt that fits is returned as is", () => {
  const prompt = [sys, { role: "user" as const, content: "hi" }];
  assert.equal(fitPromptToChars(prompt, 100), prompt);
});

test("old history goes first, keeping the system message and the last message", () => {
  const prompt = [sys, { role: "user" as const, content: "a".repeat(50) }, { role: "assistant" as const, content: "b".repeat(50) }, { role: "user" as const, content: "now" }];
  const fitted = fitPromptToChars(prompt, 70);
  assert.deepEqual(fitted.map((m) => m.content), [sys.content, "b".repeat(50), "now"]);
});

test("a single oversized message keeps its end", () => {
  const fitted = fitPromptToChars([sys, { role: "user", content: "old " + "x".repeat(40) + " recent" }], 30);
  const total = fitted.reduce((n, m) => n + (m.content as string).length, 0);
  assert.ok(total <= 30, `got ${total}`);
  assert.ok((fitted.at(-1)!.content as string).endsWith(" recent"));
});
