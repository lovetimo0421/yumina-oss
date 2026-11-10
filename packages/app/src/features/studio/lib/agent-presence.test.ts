import test from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { presenceForTool } from "./agent-presence-target";

const t = (key: string) => key;
const world = {
  entries: [{ id: "e2", name: "林晚", content: "", role: "character" }],
  variables: [{ id: "trust", name: "信任", type: "number", defaultValue: 10 }],
} as unknown as WorldDefinition;

test("an entry being written marks its row first, then its block", () => {
  const p = presenceForTool("write_entry", JSON.stringify({ id: "e2", content: "…" }), world, t);
  assert.ok(Array.isArray(p?.target));
  assert.match((p!.target as string[])[0]!, /entry:e2/);
  assert.match(p!.label, /林晚/);
});

test("a new entry found by name once it exists", () => {
  const p = presenceForTool("write_entry", JSON.stringify({ name: "林晚" }), world, t);
  assert.match((p!.target as string[])[0]!, /entry:e2/);
});

test("while arguments stream there is no row yet: the block glows", () => {
  const p = presenceForTool("write_variable", undefined, world, t);
  assert.equal(typeof p?.target, "string");
  assert.match(p!.target as string, /block:state/);
});

test("reads and searches mark nothing", () => {
  assert.equal(presenceForTool("read_entities", "{}", world, t), null);
  assert.equal(presenceForTool("grep_world", "{}", world, t), null);
});
