import test from "node:test";
import assert from "node:assert/strict";
import {
  canEditAsTurns,
  removeTurnAt,
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

test("multiple <START> blocks survive a parse/serialize round trip", () => {
  const content = "<START>\n{{user}}: a\n{{char}}: b\n<START>\n{{user}}: c\n{{char}}: d";
  const turns = parseExampleContent(content);
  assert.equal(turns.length, 4);
  assert.equal(turns[2]!.startsBlock, true);
  assert.equal(turns[1]!.content, "b");
  assert.equal(serializeTurns(turns), content);
  assert.equal(canEditAsTurns(content), true);
});

test("editing one turn keeps the other block boundaries", () => {
  const content = "<START>\n{{user}}: a\n{{char}}: b\n<START>\n{{user}}: c\n{{char}}: d";
  const turns = parseExampleContent(content).map((t, i) => (i === 3 ? { ...t, content: "D!" } : t));
  assert.equal(
    serializeTurns(turns),
    "<START>\n{{user}}: a\n{{char}}: b\n<START>\n{{user}}: c\n{{char}}: D!",
  );
});

test("prose-only examples cannot be edited as turns", () => {
  assert.equal(canEditAsTurns("The narrator describes a quiet tavern.\nNobody speaks."), false);
  assert.deepEqual(parseExampleContent("Just prose."), []);
});

test("text before the first role line forces the plain-text editor", () => {
  assert.equal(canEditAsTurns("<START>\nScene: a tavern\n{{user}}: hi\n{{char}}: hello"), false);
});

test("lossy legacy formats fall back to plain text instead of being rewritten", () => {
  // Missing separator space / missing <START> / lowercase marker would all be
  // silently rewritten by serializeTurns.
  assert.equal(canEditAsTurns("{{user}}:Hello\n{{char}}:Hi"), false);
  assert.equal(canEditAsTurns("<start>\n{{user}}: Hello"), false);
  assert.equal(canEditAsTurns("{{user}}: Hello"), false);
});

test("blank content and the new-entry template are editable as turns", () => {
  assert.equal(canEditAsTurns(""), true);
  assert.equal(canEditAsTurns("  \n"), true);
  assert.equal(canEditAsTurns("<START>\n{{user}}: \n{{char}}: "), true);
});

test("CRLF content is compared after line-ending normalization", () => {
  assert.equal(canEditAsTurns("<START>\r\n{{user}}: a\r\n{{char}}: b"), true);
});

test("removing the first turn of a block hands the boundary to the next turn", () => {
  const turns = parseExampleContent("<START>\n{{user}}: a\n{{char}}: b\n<START>\n{{user}}: c\n{{char}}: d");
  assert.equal(
    serializeTurns(removeTurnAt(turns, 2)),
    "<START>\n{{user}}: a\n{{char}}: b\n<START>\n{{char}}: d",
  );
  // Removing the very first turn never leaves a doubled leading <START>.
  const firstGone = removeTurnAt(parseExampleContent("<START>\n{{user}}: a\n<START>\n{{user}}: c"), 0);
  assert.equal(serializeTurns(firstGone), "<START>\n{{user}}: c");
  assert.equal(firstGone[0]!.startsBlock, undefined);
});
