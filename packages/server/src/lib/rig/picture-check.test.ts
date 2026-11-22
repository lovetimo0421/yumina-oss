import test from "node:test";
import assert from "node:assert/strict";
import { parsePictureAnswer, pictureRefusal, type PictureAnswer } from "./picture-check.js";

const ok: PictureAnswer = { characters: 1, facing: "front", eyes: "both", eyesHiddenBy: "none", size: "large", drawing: "colored", render: "flat_2d", reason: "" };

test("picture check: what the acceptance run refused, and what it let through", () => {
  assert.equal(pictureRefusal(ok), null);
  assert.equal(pictureRefusal({ ...ok, facing: "three_quarter" }), null);
  assert.equal(pictureRefusal({ ...ok, size: "medium" }), null);
  // eyes behind hair: the rig keeps them hidden (bangs_1, bangs_2)
  assert.equal(pictureRefusal({ ...ok, eyes: "none", eyesHiddenBy: "hair" }), null);
  assert.equal(pictureRefusal({ ...ok, eyes: "one", eyesHiddenBy: "hair" }), null);
  // a witch's brim over both eyes (acc_2)
  assert.equal(pictureRefusal({ ...ok, eyes: "none", eyesHiddenBy: "hat" }), "PICTURE_EYES");
  assert.equal(pictureRefusal({ ...ok, eyes: "one", eyesHiddenBy: "mask" }), "PICTURE_EYES");
  // a face in profile (side_2), a small figure in a wide scene (wide_1), two characters
  assert.equal(pictureRefusal({ ...ok, facing: "profile", eyes: "one" }), "PICTURE_SIDE");
  assert.equal(pictureRefusal({ ...ok, facing: "back" }), "PICTURE_SIDE");
  assert.equal(pictureRefusal({ ...ok, size: "small" }), "PICTURE_SMALL");
  // wide_1: a small figure seen from behind is told it's too small (the first thing to fix)
  assert.equal(pictureRefusal({ ...ok, size: "small", facing: "back", eyes: "none", eyesHiddenBy: "other" }), "PICTURE_SMALL");
  assert.equal(pictureRefusal({ ...ok, characters: 2 }), "PICTURE_MANY");
  // a pencil sketch whose hoodie is the paper's white (mono_2)
  assert.equal(pictureRefusal({ ...ok, drawing: "sketch" }), "PICTURE_SKETCH");
  // a photograph of a real person (paint_2)
  assert.equal(pictureRefusal({ ...ok, drawing: "photo" }), "PICTURE_PHOTO");
  // a Pixar-like 3D render (chibi_2); a 2D chibi or a painting is not
  assert.equal(pictureRefusal({ ...ok, render: "cg_3d" }), "PICTURE_3D");
  assert.equal(pictureRefusal({ ...ok, render: "painted_2d" }), null);
});

test("picture check: a malformed answer is no answer (the picture then passes)", () => {
  assert.equal(parsePictureAnswer({}), null);
  assert.equal(parsePictureAnswer({ characters: "one", facing: "front", eyes: "both", size: "large" }), null);
  assert.deepEqual(parsePictureAnswer({ characters: 1, facing: "front", eyes: "both", size: "large" }),
    { characters: 1, facing: "front", eyes: "both", eyesHiddenBy: "none", size: "large", drawing: "colored", render: "flat_2d", reason: "" });
});
