import { test } from "node:test";
import assert from "node:assert/strict";
import type { Worldbook } from "@yumina/engine";
import { memoryOf, poolColours, POOL_COLOURS, wayInOf } from "./situation-describe";

const book = (o: Partial<Worldbook>) => ({ id: "b", name: "古墓", order: 0, activation: { mode: "always" }, ...o }) as Worldbook;

test("a situation is grouped by how the player gets in", () => {
  assert.equal(wayInOf(book({ activation: { mode: "keywords", keywords: ["传送"], exclusive: true } })), "word");
  assert.equal(wayInOf(book({ activation: { mode: "greeting", greetingIds: ["g"] } })), "opening");
  assert.equal(wayInOf(book({ activation: { mode: "conditions", conditions: [], conditionLogic: "all" } })), "number");
  assert.equal(wayInOf(book({ station: { kind: "worker" } })), "worker");
});

test("every pool of one shares a colour; the card's own memory is gold", () => {
  const a = book({ id: "a", station: { kind: "narrator", history: "own" } });
  const b = book({ id: "b", station: { kind: "narrator", history: "own" } });
  const c = book({ id: "c", station: { kind: "narrator", memoryPool: "小镇" } });
  assert.equal(memoryOf(book({})), null);
  const colours = poolColours([a, b, c]);
  assert.equal(colours.get(null), POOL_COLOURS[0]);
  assert.equal(colours.get(memoryOf(a)), colours.get(memoryOf(b)));
  assert.notEqual(colours.get("小镇"), colours.get(memoryOf(a)));
});
