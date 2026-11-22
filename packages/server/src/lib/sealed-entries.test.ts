import assert from "node:assert/strict";
import test from "node:test";
import { SEALED_NAME, holdsSealedFrom, parseRetained, redactSchemaFor, restoreSealed, sealCopy } from "./sealed-entries.js";

const AUTHOR = "author";
const COPIER = "copier";

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `name-${id}`, content: `text-${id}`, role: "lore", keywords: ["k"], conditions: [], enabled: true, position: 0, section: "system-presets", ...extra,
});
const card = () => ({
  name: "card",
  entries: [
    entry("rules", { folderId: "core" }),
    entry("ending", { folderId: "core" }),
    entry("hero", { role: "character" }),
    entry("culprit"),
    entry("opening", { role: "greeting" }),
    entry("map"),
  ],
  entryFolders: [{ id: "core", name: "Core", section: "system-presets", order: 0 }],
});
const source = { id: "w1", creatorId: AUTHOR, retained: { entryIds: ["culprit", "hero", "opening"], folderIds: ["core"] } };
const byId = (schema: unknown, id: string) => (schema as ReturnType<typeof card>).entries.find((e) => e.id === id)! as Record<string, unknown>;

test("the author is sent their own card untouched", () => {
  const schema = card();
  assert.equal(redactSchemaFor({ ...source, schema }, schema, AUTHOR, "edit"), schema);
});

test("a card nobody kept anything on is sent as it is", () => {
  const schema = card();
  assert.equal(redactSchemaFor({ id: "w1", creatorId: AUTHOR, schema }, schema, COPIER, "play"), schema);
});

test("a player gets kept entries without their text, but keeps a character's name", () => {
  const schema = card();
  const sent = redactSchemaFor({ ...source, schema }, schema, null, "play");
  for (const id of ["rules", "ending", "culprit", "hero"]) {
    assert.equal(byId(sent, id).content, "");
    assert.deepEqual(byId(sent, id).keywords, []);
    assert.deepEqual(byId(sent, id).sealed, { by: AUTHOR, from: "w1" });
  }
  assert.equal(byId(sent, "culprit").name, SEALED_NAME);
  assert.equal(byId(sent, "hero").name, "name-hero");
  assert.equal(byId(sent, "map").content, "text-map");
  // An opening is the first message every player reads: it cannot be kept.
  assert.equal(byId(sent, "opening").content, "text-opening");
  assert.equal(JSON.stringify(sent).includes("text-rules"), false);
  // The stored schema is not changed.
  assert.equal(byId(schema, "rules").content, "text-rules");
});

test("an editor never gets a kept name, and a kept folder loses its name", () => {
  const schema = card();
  const sent = redactSchemaFor({ ...source, schema }, schema, COPIER, "edit") as ReturnType<typeof card>;
  assert.equal(byId(sent, "hero").name, SEALED_NAME);
  assert.equal(sent.entryFolders[0]!.name, SEALED_NAME);
});

test("a copy carries the marks, and its owner is sent blanks", () => {
  const copy = sealCopy(card(), source);
  assert.equal(holdsSealedFrom(copy, COPIER), true);
  assert.equal(holdsSealedFrom(copy, AUTHOR), false);
  assert.equal(holdsSealedFrom(card(), COPIER), false);
  const row = { id: "w2", creatorId: COPIER, schema: copy };
  const sent = redactSchemaFor(row, copy, COPIER, "edit");
  assert.equal(JSON.stringify(sent).includes("text-culprit"), false);
  assert.equal(byId(sent, "map").content, "text-map");
  // The author opening that copy reads their own text.
  assert.equal(redactSchemaFor(row, copy, AUTHOR, "edit"), copy);
});

test("saving a copy puts the kept text back and ignores edits to it", () => {
  const stored = sealCopy(card(), source);
  const sent = redactSchemaFor({ id: "w2", creatorId: COPIER, schema: stored }, stored, COPIER, "edit") as ReturnType<typeof card>;
  const edited = {
    ...sent,
    entries: sent.entries
      .filter((e) => e.id !== "ending")
      .map((e) => (e.id === "culprit" ? { ...e, content: "mine now", name: "renamed", enabled: false, position: 9, sealed: undefined } : e))
      .map((e) => (e.id === "map" ? { ...e, content: "new map" } : e)),
    entryFolders: [{ ...sent.entryFolders[0]!, name: "renamed folder" }],
  };
  const saved = restoreSealed(stored, edited, COPIER) as ReturnType<typeof card>;
  const culprit = byId(saved, "culprit");
  assert.equal(culprit.content, "text-culprit");
  assert.equal(culprit.name, "name-culprit");
  assert.deepEqual(culprit.sealed, { by: AUTHOR, from: "w1" });
  assert.equal(culprit.enabled, false);
  assert.equal(culprit.position, 9);
  assert.equal(byId(saved, "rules").content, "text-rules");
  assert.equal(byId(saved, "map").content, "new map");
  assert.equal(saved.entries.some((e) => e.id === "ending"), false);
  assert.equal(saved.entryFolders[0]!.name, "Core");
  assert.deepEqual((saved.entryFolders[0] as Record<string, unknown>).sealed, { by: AUTHOR, from: "w1" });
});

test("a deleted kept entry cannot be brought back blank, and a blank one cannot shed its mark", () => {
  const stored = sealCopy(card(), source);
  const sent = redactSchemaFor({ id: "w2", creatorId: COPIER, schema: stored }, stored, COPIER, "edit") as ReturnType<typeof card>;
  const withoutCulprit = { ...stored, entries: (stored.entries as Array<{ id: string }>).filter((e) => e.id !== "culprit") };
  const saved = restoreSealed(withoutCulprit, sent, COPIER) as ReturnType<typeof card>;
  assert.equal(saved.entries.some((e) => e.id === "culprit"), false);
  // History kept on the server arrives with its text and keeps the mark.
  const restored = restoreSealed(withoutCulprit, stored, COPIER);
  assert.deepEqual(byId(restored, "culprit").sealed, { by: AUTHOR, from: "w1" });
  assert.equal(byId(restored, "culprit").content, "text-culprit");
});

test("a copy of a copy keeps the first author's marks", () => {
  const first = sealCopy(card(), source);
  const second = sealCopy(first, { id: "w2", creatorId: COPIER, retained: { entryIds: ["map"], folderIds: [] } });
  assert.deepEqual(byId(second, "culprit").sealed, { by: AUTHOR, from: "w1" });
  assert.deepEqual(byId(second, "map").sealed, { by: COPIER, from: "w2" });
  const sent = redactSchemaFor({ id: "w3", creatorId: "third", schema: second }, second, "third", "edit");
  assert.equal(JSON.stringify(sent).includes("text-"), true);
  assert.equal(JSON.stringify(sent).includes("text-culprit"), false);
  assert.equal(JSON.stringify(sent).includes("text-map"), false);
});

test("the stored choice is cleaned on the way in", () => {
  assert.equal(parseRetained(null), null);
  assert.equal(parseRetained({ entryIds: [], folderIds: [] }), null);
  assert.deepEqual(parseRetained({ entryIds: ["a", "a", 3, ""], folderIds: ["f"] }), { entryIds: ["a"], folderIds: ["f"] });
});
