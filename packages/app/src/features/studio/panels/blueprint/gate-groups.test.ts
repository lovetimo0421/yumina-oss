import { test } from "node:test";
import assert from "node:assert/strict";
import type { Variable, WorldEntry } from "@yumina/engine";
import { gateGrouping, gateLabel } from "./gate-groups";

const vol: Variable = { id: "vol", name: "卷", type: "number", defaultValue: 0, min: 0, max: 5 } as Variable;
const entry = (id: string, conditions: WorldEntry["conditions"], extra: Partial<WorldEntry> = {}): WorldEntry =>
  ({ id, name: id, content: "", role: "lore", alwaysSend: false, keywords: [], conditions, conditionLogic: "all", enabled: true, position: 0, section: "system-presets", ...extra }) as WorldEntry;
const only = (n: number) => [{ variableId: "vol", operator: "eq" as const, value: n }];
const span = (a: number, b: number) => [{ variableId: "vol", operator: "gte" as const, value: a }, { variableId: "vol", operator: "lte" as const, value: b }];

function card(): WorldEntry[] {
  const out: WorldEntry[] = [];
  for (let v = 1; v <= 5; v++) for (let k = 0; k < 3; k++) out.push(entry(`v${v}-${k}`, only(v)));
  out.push(entry("late", span(3, 5)));
  out.push(entry("pov", [{ variableId: "pov", operator: "eq", value: "you" }]));
  out.push(entry("secret", [...only(2), { variableId: "knows", operator: "eq", value: true }]));
  return out;
}

test("a block gated mostly by one variable is grouped by the values each entry is sent at", () => {
  const g = gateGrouping(card(), [vol])!;
  assert.ok(g);
  assert.equal(g.variableId, "vol");
  assert.deepEqual(g.domain, [0, 1, 2, 3, 4, 5]);
  assert.equal(g.defaultIndex, 0);
  const labels = g.groups.map((group) => gateLabel(group, g.domain));
  assert.deepEqual(labels[0], { kind: "one", value: 1 });
  assert.ok(labels.some((l) => l.kind === "range" && l.from === 3 && l.to === 5), "a span is its own group");
  assert.deepEqual(labels.at(-1), { kind: "other" }, "entries gated by something else come last");
  const two = g.groups.find((group) => gateLabel(group, g.domain).kind === "one" && (gateLabel(group, g.domain) as { value: number }).value === 2)!;
  assert.deepEqual(two.entryIds.sort(), ["secret", "v2-0", "v2-1", "v2-2"]);
  assert.ok(g.alsoGated.has("secret"), "an entry that also waits on another condition is only 'may be sent'");
});

test("a short block, a block with folders or one without a dominant variable is left as it is", () => {
  assert.equal(gateGrouping(card().slice(0, 10), [vol]), null);
  assert.equal(gateGrouping(card().map((e, i) => (i === 0 ? { ...e, folderId: "f" } : e)), [vol]), null);
  const mixed = Array.from({ length: 20 }, (_, i) => entry(`m${i}`, [{ variableId: `x${i % 4}`, operator: "eq", value: 1 }]));
  assert.equal(gateGrouping(mixed, [vol]), null);
});

test("「任一」 with another condition cannot be placed by this variable alone", () => {
  const entries = [...card(), entry("either", [...only(1), { variableId: "pov", operator: "eq", value: "you" }], { conditionLogic: "any" })];
  const g = gateGrouping(entries, [vol])!;
  const other = g.groups.find((group) => group.on === null)!;
  assert.ok(other.entryIds.includes("either"));
});

test("a block the variable alone cannot place keeps its rows", () => {
  const many = (make: (i: number) => WorldEntry["conditions"]) => Array.from({ length: 20 }, (_, i) => entry(`e${i}`, make(i)));
  const affection: Variable = { id: "aff", name: "好感", type: "number", defaultValue: 0 } as Variable;
  assert.equal(gateGrouping(many((i) => [{ variableId: "aff", operator: "gt", value: (i % 4) * 100 }]), [affection]), null, "thresholds far apart are not a timeline");
  assert.equal(gateGrouping(many((i) => [{ variableId: "ghost", operator: "eq", value: i % 3 }]), [vol]), null, "a variable the card does not have");
  assert.equal(gateGrouping(many((i) => [{ variableId: "stats.vol", operator: "eq", value: i % 3 }]), [vol]), null, "a path into a json variable");
  const name: Variable = { id: "loc", name: "地点", type: "string", defaultValue: "城" } as Variable;
  assert.equal(gateGrouping(many((i) => [{ variableId: "loc", operator: "contains", value: ["城", "林", "塔"][i % 3] }]), [name]), null, "「包含」 is not decided by the values named");
  const g = gateGrouping([...card(), entry("ref", [{ variableId: "vol", operator: "gte", value: 0, valueRef: "goal" }])], [vol])!;
  assert.ok(g.groups.find((group) => group.on === null)!.entryIds.includes("ref"), "compared with another variable: under the other conditions");
});
