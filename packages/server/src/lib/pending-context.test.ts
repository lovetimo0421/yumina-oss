import assert from "node:assert/strict";
import test from "node:test";
import { GameStateManager } from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";
import { appendPendingContext } from "./pending-context.js";

const world = { id: "w", name: "w", version: "1", variables: [], entries: [], rules: [], reactions: [], components: [], settings: {} } as unknown as WorldDefinition;
const waiting = (m: GameStateManager) => (m.getSnapshot().metadata?.pendingContext as Array<{ message: string }> | undefined)?.map((c) => c.message);

test("two presses before the next message keep both one-shot lines", () => {
  const m = new GameStateManager(world);
  appendPendingContext(m, [{ message: "entered the Dungeon, target floor 5", role: "system" }]);
  appendPendingContext(m, [{ message: "went down to floor 2", role: "system" }]);
  assert.deepEqual(waiting(m), ["entered the Dungeon, target floor 5", "went down to floor 2"]);
});

test("nothing to add leaves the waiting list alone", () => {
  const m = new GameStateManager(world);
  appendPendingContext(m, []);
  assert.equal(waiting(m), undefined);
});

test("an idle clock behaviour cannot grow the list without end", () => {
  const m = new GameStateManager(world);
  for (let i = 0; i < 50; i++) appendPendingContext(m, [{ message: `tick ${i}`, role: "system" }]);
  const list = waiting(m)!;
  assert.equal(list.length, 20);
  assert.equal(list[19], "tick 49");
});
