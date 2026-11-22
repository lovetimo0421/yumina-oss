import assert from "node:assert/strict";
import { test } from "node:test";
import { WORLD_OPS, worldOpKind } from "./world-ops.js";

test("an outside AI gets the workbench library: elements and skills", () => {
  for (const name of ["list_elements", "create_element", "list_skills", "use_skill"]) assert.ok(WORLD_OPS.some((t) => t.function.name === name), name);
  assert.equal(worldOpKind("list_elements"), "read");
  assert.equal(worldOpKind("create_element"), "run", "it writes the creator's library: not read-only");
});

test("an outside AI gets the free behavior check, as a read", () => {
  assert.ok(WORLD_OPS.some((t) => t.function.name === "simulate_behaviors"));
  assert.equal(worldOpKind("simulate_behaviors"), "read");
});

test("an outside AI's playtest rule speaks of its own chat, not the editor's jobs", () => {
  const description = WORLD_OPS.find((t) => t.function.name === "playtest")!.function.description;
  assert.match(description, /say how many moves you will play before you do/);
  assert.doesNotMatch(description, /job the creator started/);
  assert.match(description, /simulate_behaviors, which is free/);
});
