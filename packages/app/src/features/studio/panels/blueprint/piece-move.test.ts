import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pieceMoves } from "./piece-move";

const owners: Record<string, string | null> = {
  "var:hp": null,
  "var:mood": null,
  "var:tide": "harbor",
};
const ownerOf = (id: string) => (id in owners ? owners[id] : undefined);

test("a piece dropped on a module moves every object it carries", () => {
  assert.deepEqual(pieceMoves(["var:hp", "var:mood"], ownerOf, "harbor"), ["var:hp", "var:mood"]);
});

test("objects already in the target are left alone, so one drop is one undo", () => {
  assert.deepEqual(pieceMoves(["var:hp", "var:tide"], ownerOf, "harbor"), ["var:hp"]);
  assert.deepEqual(pieceMoves(["var:tide"], ownerOf, "harbor"), []);
});

test("dropping on the card re-homes what a module owns, and only that", () => {
  assert.deepEqual(pieceMoves(["var:hp", "var:tide"], ownerOf, null), ["var:tide"]);
});

test("an object the board no longer has is skipped rather than patched", () => {
  assert.deepEqual(pieceMoves(["var:gone"], ownerOf, "harbor"), []);
});
