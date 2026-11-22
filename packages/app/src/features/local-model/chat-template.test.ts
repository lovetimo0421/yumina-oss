import assert from "node:assert/strict";
import test from "node:test";
import { isTemplateError, OPENING_TURN, toTemplateSafeMessages, type WireMessage } from "./chat-template";

const roles = (messages: WireMessage[]) => messages.map((m) => m.role).join(",");

test("leading system blocks become one system message", () => {
  // Qwen's template raises "System message must be at the beginning." for the
  // SECOND of two leading system messages, not just for one mid-chat.
  const out = toTemplateSafeMessages([
    { role: "system", content: "preset" },
    { role: "system", content: "persona" },
    { role: "user", content: "hi" },
  ], { systemRole: true });
  assert.deepEqual(out, [
    { role: "system", content: "preset\n\npersona" },
    { role: "user", content: "hi" },
  ]);
});

test("a system block inside the history stays where it was, as user-side text", () => {
  const out = toTemplateSafeMessages([
    { role: "system", content: "persona" },
    { role: "user", content: "I open the door." },
    { role: "assistant", content: "It creaks." },
    { role: "system", content: "[lore: the house is haunted]" },
    { role: "user", content: "I step in." },
    { role: "system", content: "<game-state>hp: 10</game-state>" },
  ], { systemRole: true });
  assert.equal(roles(out), "system,user,assistant,user");
  assert.equal(out[3]!.content, "[lore: the house is haunted]\n\nI step in.\n\n<game-state>hp: 10</game-state>");
});

test("a chat that opens on the greeting gets a user turn before it", () => {
  // Command-R and Mistral templates require the first turn to be the user's.
  const out = toTemplateSafeMessages([
    { role: "system", content: "persona" },
    { role: "assistant", content: "Welcome, traveller." },
    { role: "user", content: "Hello." },
  ], { systemRole: true });
  assert.equal(roles(out), "system,user,assistant,user");
  assert.equal(out[1]!.content, OPENING_TURN);
});

test("roles strictly alternate", () => {
  const out = toTemplateSafeMessages([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "assistant", content: "c" },
    { role: "system", content: "note" },
    { role: "assistant", content: "d" },
  ], { systemRole: true });
  assert.equal(roles(out), "user,assistant,user,assistant");
  assert.equal(out[0]!.content, "a\n\nb");
  assert.equal(out[2]!.content, "note");
});

test("without a system role the instructions open the first user turn", () => {
  const greetingFirst = toTemplateSafeMessages([
    { role: "system", content: "persona" },
    { role: "assistant", content: "Welcome." },
    { role: "user", content: "Hi." },
  ], { systemRole: false });
  assert.deepEqual(greetingFirst, [
    { role: "user", content: "persona" },
    { role: "assistant", content: "Welcome." },
    { role: "user", content: "Hi." },
  ]);

  const userFirst = toTemplateSafeMessages([
    { role: "system", content: "persona" },
    { role: "user", content: "Hi." },
  ], { systemRole: false });
  assert.deepEqual(userFirst, [{ role: "user", content: "persona\n\nHi." }]);
});

test("images survive a merge", () => {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  const out = toTemplateSafeMessages([
    { role: "user", content: [{ type: "text", text: "look" }, image] },
    { role: "system", content: "<game-state/>" },
  ], { systemRole: true });
  assert.deepEqual(out, [{ role: "user", content: [{ type: "text", text: "look" }, image, { type: "text", text: "<game-state/>" }] }]);
});

test("empty system blocks don't split or pad a turn", () => {
  const out = toTemplateSafeMessages([
    { role: "system", content: "" },
    { role: "user", content: "hi" },
    { role: "system", content: "" },
  ], { systemRole: true });
  assert.deepEqual(out, [{ role: "user", content: "hi" }]);
});

test("a system-only prompt becomes the user turn", () => {
  assert.deepEqual(
    toTemplateSafeMessages([{ role: "system", content: "persona" }, { role: "system", content: "begin" }], { systemRole: true }),
    [{ role: "user", content: "persona\n\nbegin" }],
  );
});

test("the caller's messages are not mutated", () => {
  const input: WireMessage[] = [
    { role: "user", content: "a" },
    { role: "system", content: "b" },
  ];
  const snapshot = structuredClone(input);
  toTemplateSafeMessages(input, { systemRole: true });
  assert.deepEqual(input, snapshot);
});

test("template rejections are told apart from other failures", () => {
  assert.equal(isTemplateError("the model's chat template rejected the conversation (System role not supported)"), true);
  assert.equal(isTemplateError("Conversation roles must alternate user/assistant/user/assistant/..."), true);
  assert.equal(isTemplateError("Model unloaded."), false);
  assert.equal(isTemplateError("HTTP 404"), false);
});
