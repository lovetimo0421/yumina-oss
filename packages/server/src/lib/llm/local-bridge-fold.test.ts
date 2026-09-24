import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTrailingSystemIntoUser } from "./local-bridge.js";
import type { GenerateParams } from "./types.js";

type Msgs = GenerateParams["messages"];

const text = (m: Msgs[number]) => (typeof m.content === "string" ? m.content : "");

test("a prompt already ending on the player's turn is untouched", () => {
  const input: Msgs = [
    { role: "system", content: "persona" },
    { role: "user", content: "hello" },
  ];
  assert.equal(foldTrailingSystemIntoUser(input), input);
});

test("trailing system blocks fold into the player's message, keeping order", () => {
  // The real shape: our pipeline appends the state block and post-history
  // entries AFTER the player's message so the nudge lands near the generation
  // point. Qwen's template rejects a prompt that ends on system.
  const input: Msgs = [
    { role: "system", content: "persona" },
    { role: "user", content: "I look around." },
    { role: "system", content: "<game-state>hp: 10</game-state>" },
    { role: "system", content: "stay in character" },
  ];
  const out = foldTrailingSystemIntoUser(input);
  assert.equal(out.length, 2);
  assert.equal(out[1]!.role, "user");
  assert.equal(text(out[1]!), "I look around.\n\n<game-state>hp: 10</game-state>\n\nstay in character");
});

test("after an assistant turn the tail becomes its own user message", () => {
  // Continue-mode replays the assistant reply verbatim — editing it would
  // change what the model is being asked to extend.
  const input: Msgs = [
    { role: "user", content: "go on" },
    { role: "assistant", content: "She turned." },
    { role: "system", content: "<game-state>hp: 9</game-state>" },
  ];
  const out = foldTrailingSystemIntoUser(input);
  assert.equal(out.length, 3);
  assert.equal(out[1]!.role, "assistant");
  assert.equal(text(out[1]!), "She turned.");
  assert.equal(out[2]!.role, "user");
  assert.equal(text(out[2]!), "<game-state>hp: 9</game-state>");
});

test("a system-only prompt becomes a user turn so the template has something to answer", () => {
  const input: Msgs = [
    { role: "system", content: "persona" },
    { role: "system", content: "begin" },
  ];
  const out = foldTrailingSystemIntoUser(input);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.role, "user");
  assert.equal(text(out[0]!), "persona\n\nbegin");
});

test("empty trailing system blocks don't leave a dangling separator", () => {
  const input: Msgs = [
    { role: "user", content: "hi" },
    { role: "system", content: "" },
  ];
  const out = foldTrailingSystemIntoUser(input);
  assert.equal(out.length, 1);
  assert.equal(text(out[0]!), "hi");
});

test("multimodal content parts are flattened to their text when folded", () => {
  const input: Msgs = [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:," } }] },
    { role: "system", content: "<game-state/>" },
  ];
  const out = foldTrailingSystemIntoUser(input);
  assert.equal(out.length, 1);
  assert.equal(text(out[0]!), "look\n\n<game-state/>");
});
