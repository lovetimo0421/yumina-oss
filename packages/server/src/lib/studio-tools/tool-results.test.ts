import test from "node:test";
import assert from "node:assert/strict";
import { buildToolResultMessages } from "./tool-results.js";
import type { ToolResult } from "./index.js";

const ok = (id: string, result: unknown): ToolResult => ({
  tool_call_id: id,
  name: "write_entry",
  status: "success",
  result,
});
const fail = (id: string, error: string): ToolResult => ({
  tool_call_id: id,
  name: "delete_entities",
  status: "error",
  result: null,
  error,
});

test("one result per id → one message, content matches legacy serialization", () => {
  const msgs = buildToolResultMessages([ok("call_1", { status: "OK", id: "e1" })]);
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], {
    role: "tool",
    tool_call_id: "call_1",
    content: JSON.stringify({ status: "OK", id: "e1" }),
  });
});

test("single error result falls back to { error } payload (unchanged behavior)", () => {
  const msgs = buildToolResultMessages([fail("call_1", "boom")]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.content, JSON.stringify({ error: "boom" }));
});

test("multiple results sharing an id collapse into ONE message (the multi-delete bug)", () => {
  // delete_entities({ ids: [a, b, c] }) expands to 3 ToolResults, all carrying
  // the same originating tool_call_id. Anthropic rejects >1 tool_result per id.
  const msgs = buildToolResultMessages([
    ok("del_1", "delete entry \"a\": OK"),
    ok("del_1", "delete entry \"b\": OK"),
    ok("del_1", "delete entry \"c\": OK"),
  ]);
  assert.equal(msgs.length, 1, "must be exactly one tool message for the shared id");
  assert.equal(msgs[0]!.tool_call_id, "del_1");
  assert.deepEqual(JSON.parse(msgs[0]!.content), [
    "delete entry \"a\": OK",
    "delete entry \"b\": OK",
    "delete entry \"c\": OK",
  ]);
});

test("merged group preserves per-result error/result payloads", () => {
  const msgs = buildToolResultMessages([
    ok("del_1", "delete entry \"a\": OK"),
    fail("del_1", "not found: b"),
  ]);
  assert.equal(msgs.length, 1);
  assert.deepEqual(JSON.parse(msgs[0]!.content), [
    "delete entry \"a\": OK",
    { error: "not found: b" },
  ]);
});

test("distinct ids stay distinct and keep first-seen order", () => {
  const msgs = buildToolResultMessages([
    ok("read_1", { r: 1 }),
    ok("del_1", "a"),
    ok("del_1", "b"),
    ok("write_1", { w: 1 }),
  ]);
  assert.deepEqual(
    msgs.map((m) => m.tool_call_id),
    ["read_1", "del_1", "write_1"],
  );
  // exactly one message per unique tool_use id
  assert.equal(new Set(msgs.map((m) => m.tool_call_id)).size, msgs.length);
});

test("empty input → no messages", () => {
  assert.deepEqual(buildToolResultMessages([]), []);
});
