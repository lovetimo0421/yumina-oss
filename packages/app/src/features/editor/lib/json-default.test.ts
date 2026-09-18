import assert from "node:assert/strict";
import test from "node:test";
import { variableSchema } from "../../../../../engine/src/world/schema";
import { invalidJsonDefault, jsonDefaultText, jsonDefaultUpdate } from "./json-default";

test("schema round trip retains exact whitespace and key order after JSONB reorders objects", () => {
  const source = '{\n  "z": {"last": 2, "first": 1},\n  "a": [2, 1]\n}';
  const stored = variableSchema.parse({
    id: "inventory", name: "Inventory", type: "json",
    ...jsonDefaultUpdate(source),
    defaultValue: { a: [2, 1], z: { first: 1, last: 2 } },
  });
  assert.equal(jsonDefaultText(stored), source);
  assert.equal(stored.defaultValueText, source);
});

test("external value changes override stale valid authoring text", () => {
  const changed = { defaultValue: { a: [1, 2] }, defaultValueText: '{"a":[2,1]}' };
  assert.deepEqual(JSON.parse(jsonDefaultText(changed)), changed.defaultValue);
});

test("unfinished input is retained without replacing the valid runtime value", () => {
  const variable = {
    id: "v", name: "V", type: "json" as const,
    defaultValue: { score: 10 }, ...jsonDefaultUpdate('{"score":'),
  };
  assert.equal(jsonDefaultText(variable), '{"score":');
  assert.deepEqual(variable.defaultValue, { score: 10 });
  assert.equal(invalidJsonDefault([variable]), variable);
  const repaired = { ...variable, ...jsonDefaultUpdate('{"score":20}') };
  assert.equal(invalidJsonDefault([repaired]), undefined);
  assert.deepEqual(repaired.defaultValue, { score: 20 });
});

test("empty, primitive and null defaults are rejected; legacy objects remain editable", () => {
  for (const text of ["", "null", "5", '"hello"']) {
    const variable = { id: "v", name: "V", type: "json" as const, defaultValue: {}, ...jsonDefaultUpdate(text) };
    assert.equal(invalidJsonDefault([variable]), variable);
  }
  assert.equal(jsonDefaultText({ defaultValue: { a: 1 } }), '{\n  "a": 1\n}');
});
