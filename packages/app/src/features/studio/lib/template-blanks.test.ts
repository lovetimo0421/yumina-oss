import { test } from "node:test";
import assert from "node:assert/strict";
import { templateBlanks } from "./template-blanks";

const chatCard = (character = "", opening = "") => [
  { id: "c", role: "character", content: character, tags: ["template-content:chat-character"] },
  { id: "w", role: "scenario", content: "", tags: ["chat:worldview", "template-content:chat-worldview"] },
  { id: "g", role: "greeting", content: opening, tags: ["template-content:chat-greeting"] },
];

test("a fresh character-chat card is missing its character, then its opening", () => {
  const blanks = templateBlanks(chatCard());
  assert.deepEqual(blanks.map((b) => b.objectId), ["entry:c", "greeting:g"]);
  assert.equal(blanks[0]!.labelKey, "chat.entries.character.name");
  assert.equal(blanks[1]!.labelKey, "chat.entries.greeting.name");
});

test("worldview and style are not required to play", () => {
  assert.equal(templateBlanks(chatCard("Mio, a barista", "The bell over the door rings.")).length, 0);
});

test("guidance stored as bracketed content still counts as blank", () => {
  assert.deepEqual(templateBlanks(chatCard("[Name]\n[Full name, nicknames]", "Hi")).map((b) => b.objectId), ["entry:c"]);
});

test("a world card asks for its overview and opening", () => {
  const blanks = templateBlanks([
    { id: "o", role: "scenario", content: "", tags: ["template-content:world-overview"] },
    { id: "n", role: "character", content: "", tags: ["template-content:world-npcA"] },
    { id: "g", role: "greeting", content: "", tags: ["template-content:world-greeting"] },
  ]);
  assert.deepEqual(blanks.map((b) => b.objectId), ["entry:o", "greeting:g"]);
});

test("a card without template rows has no blanks", () => {
  assert.equal(templateBlanks([{ id: "x", role: "greeting", content: "" }]).length, 0);
});
