import test from "node:test";
import assert from "node:assert/strict";
import { cleanComposeOutput, composeAssistMessages, COMPOSE_HISTORY_MESSAGES } from "../../../sandbox/chat/compose-assist";
import { composeAssistModel, FOLLOW_STORY_MODEL } from "@yumina/shared";

const turn = (role: string, content: string, status?: string) => ({ role, content, status });

test("帮我写: recent turns, then the player's own request, then the rules; failed and system rows left out", () => {
  const history = [
    turn("system", "greeting setup"),
    ...Array.from({ length: 14 }, (_, i) => turn(i % 2 ? "assistant" : "user", `line ${i}`)),
    turn("user", "lost", "failed"),
  ];
  const messages = composeAssistMessages({ history, playerName: "风浅浅" });
  assert.equal(messages.length, COMPOSE_HISTORY_MESSAGES + 2);
  assert.equal(messages.at(-3)!.content, "line 13");
  assert.ok(!messages.some((m) => m.content === "lost" || m.content === "greeting setup"));
  const ask = messages.at(-2)!;
  assert.equal(ask.role, "user");
  assert.match(ask.content, /Do not reply as the narrator/);
  assert.match(ask.content, /natural move/);
  const rules = messages.at(-1)!;
  assert.equal(rules.role, "system");
  assert.match(rules.content, /next message of 风浅浅/);
  assert.match(rules.content, /the user turns above/);
});

test("帮我写: a draft is expanded, keeping what the player wrote; no player turns yet means first person", () => {
  const request = composeAssistMessages({ history: [turn("assistant", "opening")], draft: "  我推开门  ", playerName: "" });
  assert.equal(request.length, 3);
  assert.equal(request[0]!.content, "opening");
  assert.match(request[1]!.content, /Rewrite my draft/);
  assert.ok(request[1]!.content.endsWith("\n\n我推开门"));
  assert.match(request[2]!.content, /first person/);
  assert.match(request[2]!.content, /the player/);
});

test("帮我写: a very long reply is cut to its latest part", () => {
  const [row] = composeAssistMessages({ history: [turn("assistant", "a".repeat(5000) + "END")], playerName: "x" });
  assert.ok(row!.content.length < 2500);
  assert.ok(row!.content.endsWith("END"));
});

test("帮我写: output loses a code fence, a name label and wrapping quotes", () => {
  assert.equal(cleanComposeOutput("```\nI open the door.\n```", "Ann"), "I open the door.");
  assert.equal(cleanComposeOutput("**Ann**: I open the door.", "Ann"), "I open the door.");
  assert.equal(cleanComposeOutput("风浅浅：我推开门。", "风浅浅"), "我推开门。");
  assert.equal(cleanComposeOutput("“我推开门。”", "风浅浅"), "我推开门。");
  // Quotes that are dialogue inside the message stay.
  assert.equal(cleanComposeOutput("\"Hi,\" I say. \"Bye.\"", "Ann"), "\"Hi,\" I say. \"Bye.\"");
});

test("帮我写 model: the player's pick, else the story model", () => {
  assert.equal(composeAssistModel(undefined, "story/model"), "story/model");
  assert.equal(composeAssistModel({ write: FOLLOW_STORY_MODEL }, "story/model"), "story/model");
  assert.equal(composeAssistModel({ write: "deepseek/deepseek-v3.2" }, "story/model"), "deepseek/deepseek-v3.2");
});
