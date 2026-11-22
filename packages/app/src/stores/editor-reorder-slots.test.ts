import assert from "node:assert/strict";
import test from "node:test";
import type { WorldEntry } from "@yumina/engine";
import { slotPositions } from "./editor";

const e = (id: string, position: number, section = "system-presets") => ({ id, position, section }) as unknown as WorldEntry;
const order = (all: WorldEntry[], pos: Map<string, number>) =>
  [...all].sort((a, b) => (pos.get(a.id) ?? a.position) - (pos.get(b.id) ?? b.position)).map((x) => x.id);

test("a drag changes only the dragged entry's position", () => {
  const all = [e("a", 0), e("b", 1), e("c", 2), e("d", 3)];
  const pos = slotPositions(all, ["a", "d", "b", "c"]);
  assert.deepEqual([...pos].filter(([id, p]) => all.find((x) => x.id === id)!.position !== p).map(([id]) => id), ["d"]);
  assert.deepEqual(order(all, pos), ["a", "d", "b", "c"]);
});

test("two people's drags of different entries both hold", () => {
  const all = [e("a", 0), e("b", 1), e("c", 2), e("d", 3), e("f", 4)];
  const mine = slotPositions(all, ["a", "f", "b", "c", "d"]); // f up to second
  const theirs = slotPositions(all, ["b", "c", "d", "f", "a"]); // a to the end
  const merged = all.map((x) => ({ ...x, position: theirs.get(x.id) !== x.position ? theirs.get(x.id)! : mine.get(x.id) ?? x.position }));
  // f went in just behind a; a has since moved to the end, so f leads.
  assert.deepEqual(order(merged, new Map()), ["f", "b", "c", "d", "a"]);
});

test("ties fall back to numbering the listed entries", () => {
  const all = [e("a", 0), e("b", 0), e("c", 0)];
  assert.deepEqual([...slotPositions(all, ["c", "a", "b"])], [["c", 0], ["a", 1], ["b", 2]]);
});
