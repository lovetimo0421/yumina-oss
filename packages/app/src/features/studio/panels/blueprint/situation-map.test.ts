import { test } from "node:test";
import assert from "node:assert/strict";
import type { Worldbook } from "@yumina/engine";
import type { FrameBox } from "./board";
import { arrangeSituations, situationGroupId } from "./situation-map";

const frame = (id: string, x = 0, y = 0): FrameBox => ({ id, x, y, width: 236, height: 118, blocks: {} });
const book = (id: string, o: Partial<Worldbook>) => ({ id, name: id, order: 0, activation: { mode: "always" }, ...o }) as Worldbook;

test("situations stand beside the card, grouped by how the player gets in", () => {
  const books = new Map<string, Worldbook>([
    ["module:hos", book("hos", { activation: { mode: "keywords", keywords: ["传送"], exclusive: true } })],
    ["module:tomb", book("tomb", { activation: { mode: "keywords", keywords: ["古墓"], exclusive: true } })],
    ["module:train", book("train", { activation: { mode: "greeting", greetingIds: ["g"] } })],
    ["module:rec", book("rec", { station: { kind: "worker" } })],
  ]);
  const boxes = new Map<string, FrameBox>([["frame:card", frame("frame:card")], ...[...books.keys()].map((id) => [id, frame(id)] as const)]);
  const groups = arrangeSituations(boxes, (id) => books.get(id), { startX: 1000, startY: 0, pinned: {} });
  assert.deepEqual(groups.map((g) => g.id), [situationGroupId("opening"), situationGroupId("word"), situationGroupId("worker")]);
  const [opening, word, worker] = groups;
  assert.ok(opening!.y < word!.y && word!.y < worker!.y, "the groups stand in a column");
  for (const id of ["module:hos", "module:tomb"]) {
    const b = boxes.get(id)!;
    assert.ok(b.x >= word!.x && b.y >= word!.y && b.y + b.height <= word!.y + word!.height, `${id} is inside its group`);
  }
  assert.equal(boxes.get("frame:card")!.x, 0, "the card is not moved");
});

test("a situation the author dragged keeps its place", () => {
  const books = new Map<string, Worldbook>([["module:a", book("a", {})]]);
  const boxes = new Map<string, FrameBox>([["module:a", frame("module:a", 42, 99)]]);
  arrangeSituations(boxes, (id) => books.get(id), { startX: 1000, startY: 0, pinned: { "module:a": { x: 42, y: 99 } } });
  assert.deepEqual([boxes.get("module:a")!.x, boxes.get("module:a")!.y], [42, 99]);
});

test("a situation laid out by its group goes round one the author dragged into the column", () => {
  const books = new Map<string, Worldbook>([
    ["module:a", book("a", {})],
    ["module:b", book("b", {})],
  ]);
  // "a" was dragged to exactly where the group's first slot is.
  const boxes = new Map<string, FrameBox>([["module:a", frame("module:a", 1016, 40)], ["module:b", frame("module:b")]]);
  arrangeSituations(boxes, (id) => books.get(id), { startX: 1000, startY: 0, pinned: { "module:a": { x: 1016, y: 40 } } });
  const a = boxes.get("module:a")!;
  const b = boxes.get("module:b")!;
  const overlap = b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  assert.equal(overlap, false);
});
