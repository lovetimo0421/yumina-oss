import assert from "node:assert/strict";
import test from "node:test";
import {
  createImageTagRegistry,
  insertBlocks,
  removeStoredImage,
  storedImageIds,
  tagsFor,
  toDisplayText,
  toStoredText,
} from "./description-image-markdown";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const img = (id: string) => `![](@asset:${id})`;

test("stored pictures show as numbered tags and round-trip", () => {
  const reg = createImageTagRegistry();
  const stored = `Cynthia\n\n${img(A)}\n\nElena\n\n${img(B)}`;
  const shown = toDisplayText(stored, reg, "Image");
  assert.equal(shown, "Cynthia\n\n[Image 1]\n\nElena\n\n[Image 2]");
  assert.equal(toStoredText(shown, reg, "Image"), stored);
});

test("a tag keeps its picture after the creator moves it", () => {
  const reg = createImageTagRegistry();
  toDisplayText(`${img(A)}\n\n${img(B)}`, reg, "图片");
  const moved = "[图片 2]\n\n[图片 1]";
  const stored = toStoredText(moved, reg, "图片");
  assert.equal(stored, `${img(B)}\n\n${img(A)}`);
  // Re-rendering from the new order must not renumber what is on screen.
  assert.equal(toDisplayText(stored, reg, "图片"), moved);
});

test("a tag nobody uploaded stays plain text", () => {
  const reg = createImageTagRegistry();
  assert.equal(toStoredText("see [Image 7]", reg, "Image"), "see [Image 7]");
});

test("new uploads go on their own paragraph at the caret", () => {
  const reg = createImageTagRegistry();
  const text = "Cynthia (Head Maid)Profile: Human";
  const at = "Cynthia (Head Maid)".length;
  const out = insertBlocks(text, at, at, tagsFor([A, B], reg, "Image"));
  assert.equal(out.text, "Cynthia (Head Maid)\n\n[Image 1]\n\n[Image 2]\n\nProfile: Human");
  assert.equal(out.text.slice(0, out.caret), "Cynthia (Head Maid)\n\n[Image 1]\n\n[Image 2]\n\n");
  assert.equal(insertBlocks("", 0, 0, ["[Image 1]"]).text, "[Image 1]");
  assert.equal(insertBlocks("Intro\n\nMore", 7, 7, ["[Image 1]"]).text, "Intro\n\n[Image 1]\n\nMore");
});

test("listing and removing pictures", () => {
  const stored = `Top\n\n${img(A)}\n\nMiddle\n\n${img(B)}`;
  assert.deepEqual(storedImageIds(stored), [A, B]);
  assert.equal(removeStoredImage(stored, A), `Top\n\nMiddle\n\n${img(B)}`);
  assert.equal(removeStoredImage(stored, B), "Top\n\n" + img(A) + "\n\nMiddle");
  assert.equal(removeStoredImage(`${img(A)}\n\nRest`, A), "Rest");
});
