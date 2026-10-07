import test from "node:test";
import assert from "node:assert/strict";
import { getUiTemplate, type UiDoc, type Variable, type WorldDefinition } from "@yumina/engine";
import { collectBoundVariableIds, findTemplateLeftovers, isTemplateShaped } from "./template-leftovers";

const template = getUiTemplate("portrait-scene")!;
const names = Object.fromEntries(template.needs.map((need) => [need.key, `N:${need.key}`]));

/** The variables the layout would create, ids fixed so the doc can bind them. */
function layoutVariables(): Variable[] {
  return template.needs.map((need) => ({
    id: `v-${need.key}`, name: names[need.key]!, type: need.type, description: "",
    defaultValue: need.defaultValue,
    ...(need.min !== undefined ? { min: need.min } : {}),
    ...(need.max !== undefined ? { max: need.max } : {}),
  }));
}
function layoutDoc(): UiDoc {
  return template.build({ strings: { title: "T" }, variableIds: Object.fromEntries(template.needs.map((need) => [need.key, `v-${need.key}`])) });
}
const emptyDoc = (): UiDoc => ({ version: 1, entryPageId: "page-1", pages: [{ id: "page-1", name: "Main", height: 812, elements: [] }], surface: "chat" });
const world = (patch: Partial<WorldDefinition>): WorldDefinition => ({
  id: "w", name: "W", description: "", entries: [], variables: [], rules: [], reactions: [], worldbooks: [],
  ...patch,
} as unknown as WorldDefinition);

test("the layout's doc binds every variable it declares, and an empty doc binds none", () => {
  const bound = collectBoundVariableIds(layoutDoc());
  for (const need of template.needs) assert.ok(bound.has(`v-${need.key}`), need.key);
  assert.equal(collectBoundVariableIds(emptyDoc()).size, 0);
  assert.equal(collectBoundVariableIds(undefined).size, 0);
});

test("a variable is template-shaped only while it still looks exactly as the layout made it", () => {
  const made = layoutVariables();
  const portrait = made.find((v) => v.id === "v-portrait")!;
  const affinity = made.find((v) => v.id === "v-affinity")!;
  assert.ok(isTemplateShaped(affinity, template.needs, names));
  assert.ok(isTemplateShaped({ ...affinity, name: "affinity" }, template.needs, undefined), "the raw need key counts as the layout's name too");
  assert.ok(!isTemplateShaped({ ...affinity, defaultValue: 12 }, template.needs, names), "a changed starting value is the creator's");
  assert.ok(!isTemplateShaped({ ...affinity, max: 200 }, template.needs, names), "a changed range is the creator's");
  assert.ok(!isTemplateShaped({ ...affinity, name: "Trust" }, template.needs, names), "a renamed variable is the creator's");
  assert.ok(isTemplateShaped({ ...affinity, name: "Trust" }, template.needs, { location: "Where" }), "with no name on hand for this need, shape alone decides");
  assert.ok(isTemplateShaped({ ...portrait, defaultValue: "https://cdn/cover.png" }, template.needs, names), "the portrait is seeded from the cover, so its value is not evidence");
});

test("switching away from a layout lists the variables it bound that nothing uses now", () => {
  const previousDoc = layoutDoc();
  const left = findTemplateLeftovers({ world: world({ variables: layoutVariables(), uiDoc: emptyDoc() }), previousDoc, previousTemplateId: "portrait-scene", variableNames: names });
  assert.deepEqual(left.map((v) => v.id).sort(), template.needs.map((need) => `v-${need.key}`).sort());
});

test("a variable a behaviour reads, or one the creator reshaped, is not a leftover", () => {
  const variables = layoutVariables();
  const affinity = variables.find((v) => v.id === "v-affinity")!;
  affinity.defaultValue = 12;
  const reactions = [{
    id: "r1", name: "cheer", enabled: true, priority: 0,
    when: { kind: "turn" },
    conditions: [{ variableId: "v-stamina", operator: ">", value: 10 }],
    actions: [],
  }];
  const left = findTemplateLeftovers({
    world: world({ variables, reactions: reactions as never, uiDoc: emptyDoc() }),
    previousDoc: layoutDoc(), previousTemplateId: "portrait-scene", variableNames: names,
  });
  const ids = left.map((v) => v.id);
  assert.ok(!ids.includes("v-affinity"), "reshaped");
  assert.ok(!ids.includes("v-stamina"), "read by a behaviour");
  assert.ok(ids.includes("v-location"), "untouched and unread — a leftover");
});

test("nothing is a leftover when there was no layout before, or when the new layout still binds it", () => {
  assert.deepEqual(findTemplateLeftovers({ world: world({ variables: layoutVariables(), uiDoc: emptyDoc() }), previousDoc: emptyDoc(), previousTemplateId: null }), []);
  const same = layoutDoc();
  assert.deepEqual(findTemplateLeftovers({ world: world({ variables: layoutVariables(), uiDoc: same }), previousDoc: same, previousTemplateId: "portrait-scene", variableNames: names }), []);
});
