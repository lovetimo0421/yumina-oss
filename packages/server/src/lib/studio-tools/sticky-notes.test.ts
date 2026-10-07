import test from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { stickyNotes } from "./sticky-notes.js";

test("sticky notes reach the AI with what each is stuck to", () => {
  const world = {
    name: "雨夜书店",
    entries: [{ id: "e1", name: "沈砚" }],
    variables: [{ id: "trust", name: "信任" }],
    worldbooks: [{ id: "attic", name: "阁楼" }],
    graphLayout: {
      version: 1,
      nodes: {},
      notes: [
        { id: "a", x: 0, y: 0, w: 200, h: 100, text: "只负责回复玩家", on: "block:ais" },
        { id: "b", x: 0, y: 0, w: 200, h: 100, text: "进阁楼要说暗号", on: "module:attic" },
        { id: "c", x: 0, y: 0, w: 200, h: 100, text: "信任满 100 解锁结局", on: "var:trust" },
        { id: "d", x: 0, y: 0, w: 200, h: 100, text: "阁楼的 AI 只读最近 10 条", on: "block:m:attic:ais" },
        { id: "e", x: 5, y: 5, w: 200, h: 100, text: "下一步：加一个结局" },
        { id: "f", x: 5, y: 5, w: 200, h: 100, text: "   " },
      ],
    },
  } as unknown as WorldDefinition;
  assert.deepEqual(stickyNotes(world).map((n) => [n.on ?? null, n.text]), [
    ["the card's AI block", "只负责回复玩家"],
    ['scenario "阁楼"', "进阁楼要说暗号"],
    ['variable "信任"', "信任满 100 解锁结局"],
    ['scenario "阁楼"\'s AI block', "阁楼的 AI 只读最近 10 条"],
    [null, "下一步：加一个结局"],
  ]);
});
