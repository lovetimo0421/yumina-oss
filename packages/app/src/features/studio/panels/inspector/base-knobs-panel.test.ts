import test from "node:test";
import assert from "node:assert/strict";
import type { UiKnobGroup } from "@yumina/engine";
import { knobGroupsForRegion } from "./base-knobs-panel";

const g = (id: string): UiKnobGroup => ({ id, label: id, knobs: [] });
// The shape the AI left on a real card (2026-11-04): regions "shell" and
// "phone" on the markup, groups split by kind under them.
const groups = ["shell-colors", "shell-spacing", "phone-colors", "phone-colors-feed", "phone-radius"].map(g);

test("a region opens its exact group when one exists", () => {
  assert.deepEqual(knobGroupsForRegion([g("hero"), g("hero-colors")], "hero").map((x) => x.id), ["hero"]);
});

test("a region opens every group named under it", () => {
  assert.deepEqual(knobGroupsForRegion(groups, "shell").map((x) => x.id), ["shell-colors", "shell-spacing"]);
  assert.deepEqual(knobGroupsForRegion(groups, "phone").map((x) => x.id), ["phone-colors", "phone-colors-feed", "phone-radius"]);
});

test("an unknown region or no region still opens knobs: all of them", () => {
  assert.equal(knobGroupsForRegion(groups, "footer").length, groups.length);
  assert.equal(knobGroupsForRegion(groups, null).length, groups.length);
});
