import test from "node:test";
import assert from "node:assert/strict";
import { flowNodeBlockKind, learningStageHides } from "./learning-stage";
import { LEARNING_LESSONS, lessonFocus, lessonStage, lessonsOf } from "./learning-catalog";

test("a staged lesson leaves only its own kinds on the canvas, whichever node type draws them", () => {
  const stage = ["opening", "frontend"] as const;
  assert.equal(learningStageHides({ type: "writing", data: { kind: "opening" } }, stage), false);
  assert.equal(learningStageHides({ type: "starter", data: { kind: "opening" } }, stage), false);
  assert.equal(learningStageHides({ type: "block", data: { block: { kind: "frontend" } } }, stage), false);
  assert.equal(learningStageHides({ type: "writing", data: { kind: "setting" } }, stage), true, "lore waits for its own lesson");
  assert.equal(learningStageHides({ type: "block", data: { block: { kind: "state" } } }, stage), true);
  assert.equal(learningStageHides({ type: "gate", data: { frame: {} } }, stage), true, "the frame goes with the blocks it holds");
  assert.equal(learningStageHides({ type: "pieceSlot", data: {} }, stage), true);
  assert.equal(learningStageHides({ type: "gate", data: {} }, null), false, "no lesson, nothing hidden");
  assert.equal(flowNodeBlockKind({ type: "writing", data: { kind: "setting" } }), "lore");
});

test("the required lessons add one block each; every later lesson builds on all three", () => {
  const required = lessonsOf("required");
  let previous: NonNullable<ReturnType<typeof lessonStage>> = [];
  for (const lesson of required) {
    const stage = lessonStage(lesson)!;
    for (const kind of previous) assert.ok(stage.includes(kind), `${lesson.id} keeps ${kind} on the canvas`);
    assert.equal(stage.length, previous.length + 1, `${lesson.id} brings exactly one block`);
    previous = stage;
  }
  assert.deepEqual(required.map(l => l.id), ["opening", "setting", "interface"]);
  for (const lesson of lessonsOf("more")) {
    const stage = lessonStage(lesson);
    if (!stage) continue;
    for (const kind of previous) assert.ok(stage.includes(kind), `${lesson.id} keeps the three it follows`);
    assert.ok((lessonFocus(lesson) ?? []).every(kind => stage.includes(kind)), `${lesson.id}: the camera frames blocks the stage draws`);
  }
  assert.equal(new Set(LEARNING_LESSONS.map(l => l.id)).size, LEARNING_LESSONS.length);
});
