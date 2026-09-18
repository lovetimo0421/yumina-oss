import test from "node:test";
import assert from "node:assert/strict";
import {
  parseExampleContent,
  serializeTurns,
  type ExampleTurn,
} from "./example-turns";

test("example turns preserve a trailing space while editing", () => {
  const turns: ExampleTurn[] = [
    { role: "user", content: "Hello " },
    { role: "assistant", content: "Hi there" },
  ];

  assert.deepEqual(parseExampleContent(serializeTurns(turns)), turns);
});

test("example turns preserve multiline whitespace", () => {
  const turns: ExampleTurn[] = [
    { role: "user", content: "  indented\n\nnext line\n" },
    { role: "assistant", content: "response  " },
  ];

  assert.deepEqual(parseExampleContent(serializeTurns(turns)), turns);
});

test("example turns preserve empty messages", () => {
  const turns: ExampleTurn[] = [
    { role: "user", content: "" },
    { role: "assistant", content: "" },
  ];

  assert.deepEqual(parseExampleContent(serializeTurns(turns)), turns);
});

test("example turns still parse legacy content without START or separator spaces", () => {
  assert.deepEqual(
    parseExampleContent("{{user}}:Hello\n{{char}}:Hi"),
    [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ],
  );
});
