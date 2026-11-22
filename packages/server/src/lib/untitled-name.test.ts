import { strict as assert } from "node:assert";
import { test } from "node:test";
import { nextUntitledName } from "./untitled-name";

test("the first untitled card keeps the plain name, the next ones count up", () => {
  assert.equal(nextUntitledName("Untitled World", []), "Untitled World");
  assert.equal(nextUntitledName("Untitled World", ["Untitled World"]), "Untitled World 1");
  assert.equal(nextUntitledName("Untitled World", ["Untitled World", "Untitled World 1"]), "Untitled World 2");
});

test("numbers follow the highest one, and other names do not count", () => {
  assert.equal(nextUntitledName("Untitled World", ["Untitled World 4", "Untitled Worlds", "Untitled World 2b", "Rain"]), "Untitled World 5");
  assert.equal(nextUntitledName("未命名世界", ["未命名世界", "未命名世界 1"]), "未命名世界 2");
});
