import assert from "node:assert/strict";
import test from "node:test";
import type { Variable, WorldDefinition } from "@yumina/engine";
import { getVariableIdUsage, VARIABLE_USAGE_WORLD_KEYS, variableUsageInputs } from "./variable-id-references";

const hp: Variable = { id: "hp", name: "Health", type: "number", defaultValue: 10 };
export function worldWithVariables(overrides: Partial<WorldDefinition> = {}): WorldDefinition {
  return { id: "world", version: "1", name: "World", description: "", author: "", variables: [hp], entries: [], rules: [], components: [], audioTracks: [], customUI: [], settings: {}, ...overrides };
}

test("usage finds condition operands, opening seeds, module workers, behavior trigger/stop/effects and bundle ownership", () => {
  const condition = { variableId: "other", operator: "eq", value: 0, valueRef: "hp.max" };
  const draft = worldWithVariables({
    entries: [{ id: "opening", name: "Opening", content: "Health: {{ hp }}", initialVariables: { hp: 5 }, conditions: [condition] }],
    variables: [hp, { id: "other", name: "Other", type: "number", defaultValue: 0, activation: { mode: "conditions", conditions: [{ variableId: "hp", operator: "gt", value: 0 }] } }],
    worldbooks: [{ id: "dungeon", name: "Dungeon", activation: { mode: "conditions", conditions: [condition] }, station: { kind: "worker", trigger: { on: "conditions", conditions: [condition] } } }],
    reactions: [{ id: "damage", name: "Damage", when: { eventType: "state:changed", match: { variableId: { operator: "eq", value: "hp" } } }, conditions: [], stopConditions: [{ variableId: "hp", operator: "eq", value: 0 }], then: [
      { type: "set", path: "hp.current", value: 0 },
      { type: "set", path: "@vars.enabled.hp", value: true },
      { type: "set", path: "other", value: 0, valueRef: "hp" },
      { type: "set", path: "other", value: "", valueRandom: { kind: "list", candidatesVar: "hp", historyVar: "hp" } },
      { type: "set", path: "@prompt.directive.health", value: "Current {{hp}}" },
      { type: "set", path: "@prompt.directive.health-json", value: { content: "Current {{hp}}", position: "auto" } },
    ] }],
    installedBundles: [{ name: "Resource pack", variableIds: ["hp"] }],
  } as unknown as Partial<WorldDefinition>);
  const before = structuredClone(draft);
  const paths = getVariableIdUsage(draft, hp).references.map((reference) => reference.path);
  for (const expected of ["entries[0].content", 'entries[0].initialVariables["hp"]', "entries[0].conditions[0].valueRef", "variables[1].activation.conditions[0].variableId", "worldbooks[0].activation.conditions[0].valueRef", "worldbooks[0].station.trigger.conditions[0].valueRef", "reactions[0].when.match.variableId.value", "reactions[0].stopConditions[0].variableId", "reactions[0].then[0].path", "reactions[0].then[1].path", "reactions[0].then[2].valueRef", "reactions[0].then[3].valueRandom.candidatesVar", "reactions[0].then[3].valueRandom.historyVar", "installedBundles[0].variableIds"]) assert.ok(paths.includes(expected), expected);
  assert.deepEqual(draft, before, "reference inspection never changes authored data");
  assert.ok(paths.includes("reactions[0].then[4].value"), "string directive templates are references");
  assert.ok(paths.includes("reactions[0].then[5].value.content"), "structured directive templates are references");
});

test("legacy rules, UI bindings and document values, conditional audio, and spatial exits remain protected", () => {
  const draft = worldWithVariables({
    rules: [{ id: "rule", trigger: { type: "variable-crossed", variableId: "hp" }, conditions: [], actions: [{ type: "modify-variable", variableId: "other", valueRef: "hp", value: 0 }] }],
    components: [{ id: "bar", type: "stat-bar", config: { variableId: "hp", secondaryVariableId: "hp.max" } }],
    uiDoc: { pages: [{ elements: [{ body: { type: "meter", value: { kind: "variable", variableId: "hp" } } }, { body: { type: "button", actions: [{ kind: "set-variable", variableId: "hp", value: 3 }] } }, { body: { type: "text", text: { template: "HP {{hp}}" } } }] }] },
    uiBlueprint: { bindings: [{ path: "vars['hp'].current" }] },
    conditionalBGM: [{ conditions: [{ variableId: "hp", operator: "gt", value: 0 }] }],
    loreUiBindings: [{ conditions: [{ variableId: "hp", operator: "gt", value: 0 }] }],
    scenes: [{ id: "scene", exits: [{ conditionVariableId: "hp" }] }],
  } as unknown as Partial<WorldDefinition>);
  const usage = getVariableIdUsage(draft, hp);
  assert.equal(usage.references.length, 11);
  assert.ok(usage.references.some((ref) => ref.path === "uiDoc.pages[0].elements[0].body.value.variableId"));
  assert.ok(usage.references.some((ref) => ref.path === "uiBlueprint.bindings[0].path"));
});

test("plain strings, literal JSON, and longer unrelated IDs do not become references; frontend evidence stays advisory", () => {
  const draft = worldWithVariables({
    variables: [hp, { id: "data", name: "Data", type: "json", defaultValue: { variableId: "hp", content: "{{hp}}" } }],
    entries: [{ content: "hp is a label; {{hpp}} is different.", conditions: [{ variableId: "hpp", operator: "eq", value: { variableId: "hp", content: "{{hp}}" } }] }],
    reactions: [{ when: { eventType: "turn:start" }, conditions: [], then: [{ type: "set", path: "data", value: { variableId: "hp" }, valueRandom: { kind: "list", candidates: ["hp"] } }] }],
    rootComponent: { files: { "names.tsx": 'const health = api.variables.Health; api.setVariable("Health", 1);', "dynamic.tsx": "api.variables[key]; api.setVariable(target, 1);", "literal.tsx": 'const caption = "hp";' } },
  } as unknown as Partial<WorldDefinition>);
  const usage = getVariableIdUsage(draft, hp);
  assert.deepEqual(usage.references, []);
  assert.deepEqual(usage.codeReviews, [{ file: "names.tsx", reason: "name" }, { file: "dynamic.tsx", reason: "dynamic" }, { file: "literal.tsx", reason: "id" }]);
});

test("variableUsageInputs covers every world field the usage scan reads", () => {
  const read = new Set<string>();
  const world = new Proxy(worldWithVariables({ rootComponent: { name: "Root", entryFile: "index.tsx", files: { "index.tsx": "" } } } as unknown as Partial<WorldDefinition>), {
    get(target, key, receiver) {
      if (typeof key === "string") read.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
  getVariableIdUsage(world, hp);
  const covered = new Set<string>([...VARIABLE_USAGE_WORLD_KEYS, "rootComponent"]);
  for (const key of read) assert.ok(covered.has(key), "usage scan reads world." + key + " but variableUsageInputs does not track it");
  assert.equal(variableUsageInputs(world).length, VARIABLE_USAGE_WORLD_KEYS.length + 1);
});
