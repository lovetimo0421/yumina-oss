import assert from "node:assert/strict";
import test from "node:test";
import { LIST_DESCRIPTION_CHARS, listDescription } from "./list-description.js";

test("short descriptions and empty values pass through unchanged", () => {
  assert.equal(listDescription("A short premise."), "A short premise.");
  assert.equal(listDescription("x".repeat(LIST_DESCRIPTION_CHARS)), "x".repeat(LIST_DESCRIPTION_CHARS));
  assert.equal(listDescription(null), null);
  assert.equal(listDescription(undefined), undefined);
  assert.equal(listDescription(""), "");
});

test("long descriptions are cut to the list length with an ellipsis", () => {
  const out = listDescription("a".repeat(30_000));
  assert.equal(out, `${"a".repeat(LIST_DESCRIPTION_CHARS)}…`);
});

test("a cut never leaves half an image tag, link or macro", () => {
  const pad = "b".repeat(LIST_DESCRIPTION_CHARS - 20);
  for (const tail of ["![](@asset:b835f79b-c99b-491f-bd5f-f73d3286fcb3) more", "[a link](https://example.com/x) more", "{{getvar::relationship_stage}} more"]) {
    const out = listDescription(`${pad} ${tail}${"c".repeat(100)}`)!;
    assert.equal(out, `${pad}…`, tail);
  }
});

test("a cut never splits an emoji", () => {
  const out = listDescription(`${"d".repeat(LIST_DESCRIPTION_CHARS - 1)}😀${"e".repeat(50)}`)!;
  assert.equal(out, `${"d".repeat(LIST_DESCRIPTION_CHARS - 1)}…`);
});
