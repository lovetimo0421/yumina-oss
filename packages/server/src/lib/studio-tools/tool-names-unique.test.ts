import test from "node:test";
import assert from "node:assert/strict";
import { STUDIO_TOOLS } from "./tools.js";

// OpenRouter (and every provider behind it) rejects a request whose tool list
// repeats a name: "tools: Tool names must be unique". A duplicate here takes
// the whole creative assistant down, so it is pinned.
test("every Studio tool name is unique", () => {
  const names = STUDIO_TOOLS.map((t) => t.function.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, []);
});
