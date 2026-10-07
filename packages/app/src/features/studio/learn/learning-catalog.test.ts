import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEARNING_LESSONS, LEARNING_PARTS, lessonIsCurrent, lessonUnlocked, lessonsOf, nextLesson, readLearningProgress, requiredDone, writeLearningProgress } from "./learning-catalog";

test("every shipped lesson has complete copy in all supported UI languages", () => {
  const leaves = (value: Record<string, unknown>, prefix = ""): string[] => Object.entries(value).flatMap(([key, item]) =>
    typeof item === "string" ? [`${prefix}${key}`] : leaves(item as Record<string, unknown>, `${prefix}${key}.`));
  const english = JSON.parse(readFileSync(new URL("../../../locales/en/learning.json", import.meta.url), "utf8"));
  const keys = leaves(english).sort();
  assert.equal(new Set(LEARNING_LESSONS.map(l => l.id)).size, LEARNING_LESSONS.length);
  for (const locale of ["en", "zh", "zh-Hant", "es", "ja"]) {
    const copy = JSON.parse(readFileSync(new URL(`../../../locales/${locale}/learning.json`, import.meta.url), "utf8"));
    assert.deepEqual(leaves(copy).sort(), keys, `${locale}: all learning controls must be translated`);
    for (const lesson of LEARNING_LESSONS) {
      assert.ok(lesson.revision > 0);
      for (const field of ["title", "goal", "body", "bodyMobile"]) assert.ok(copy.lessons[lesson.id]?.[field]?.trim(), `${locale}: ${lesson.id}.${field}`);
    }
    for (const part of LEARNING_PARTS) for (const field of ["name", "blurb"]) assert.ok(copy.parts[part]?.[field]?.trim(), `${locale}: parts.${part}.${field}`);
  }
  assert.deepEqual(lessonsOf("required").map(step => step.id), ["opening", "setting", "interface"]);
  assert.deepEqual(lessonsOf("more").map(step => step.id), ["state", "behavior", "atmosphere", "assistant", "card", "knowledge", "looks", "modules", "ais", "canvas", "ship"]);
  assert.equal(LEARNING_LESSONS.length, lessonsOf("required").length + lessonsOf("more").length, "every lesson is required or not");
});

test("lesson revisions surface changed learning without resetting completed lessons", () => {
  const [first, second] = LEARNING_LESSONS;
  const progress = { completed: { [first.id]: first.revision, [second.id]: second.revision } };
  assert.equal(lessonIsCurrent(progress, first), true);
  assert.equal(lessonIsCurrent(progress, { ...first, revision: first.revision + 1 } as unknown as typeof first), false);
  assert.equal(lessonIsCurrent(progress, second), true);
});

test("unwritable storage retains dismissal in this page session and separates accounts", () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  const progress = { seenRelease: "test", current: "opening", completed: { setting: 1 } };
  writeLearningProgress("quota-user", progress, broken);
  assert.deepEqual(readLearningProgress("quota-user", broken), progress);
  assert.deepEqual(readLearningProgress("another-user", broken), { completed: {} });
});

test("malformed or obsolete progress does not break first entry", () => {
  assert.deepEqual(readLearningProgress("corrupt", { getItem: () => "{broken" }), { completed: {} });
  const result = readLearningProgress("obsolete", { getItem: () => JSON.stringify({ current: "removed", completed: { setting: -1, removed: 100, opening: 1 } }) });
  assert.equal(result.current, undefined);
  assert.deepEqual(result.completed, { opening: 1 });
});

test("the rest unlocks once the three required lessons are taken, whatever their revision", () => {
  const [opening, setting, screen] = lessonsOf("required");
  const variables = lessonsOf("more")[0];
  const none = { completed: {} };
  assert.equal(lessonUnlocked(none, opening), true);
  assert.equal(lessonUnlocked(none, setting), false, "the required three go in order");
  assert.equal(lessonUnlocked(none, variables), false);
  assert.equal(nextLesson(none)?.id, "opening");
  const two = { completed: { opening: 1, setting: 1 } };
  assert.equal(lessonUnlocked(two, screen), true);
  assert.equal(requiredDone(two), false);
  assert.equal(nextLesson(two)?.id, "interface");
  const three = { completed: { opening: 1, setting: 1, interface: 1 } };
  assert.equal(requiredDone(three), true, "an older revision still counts");
  assert.ok(lessonsOf("more").every(lesson => lessonUnlocked(three, lesson)));
  assert.equal(nextLesson(three)?.id, variables.id);
  assert.equal(nextLesson({ completed: Object.fromEntries(LEARNING_LESSONS.map(l => [l.id, 1])) }), null);
});
