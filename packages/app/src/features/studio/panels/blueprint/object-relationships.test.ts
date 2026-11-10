import assert from "node:assert/strict";
import test from "node:test";
import { toGraph, type Reaction, type WorldDefinition, type WorldEntry } from "@yumina/engine";
import { getObjectRelationships } from "./object-relationships";

const entry = (id: string, extra: Partial<WorldEntry> = {}): WorldEntry => ({ id, name: id, content: "", role: "custom", section: "system-presets", alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all", enabled: true, position: 0, ...extra });
const reaction = (id: string, extra: Partial<Reaction> = {}): Reaction => ({ id, name: id, when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true, ...extra });
const world = (): WorldDefinition => ({ id: "card", name: "Card", description: "", author: "", version: "1", settings: {}, entries: [], variables: [], rules: [], reactions: [], components: [], customUI: [], audioTracks: [], worldbooks: [] });
const inspect = (draft: WorldDefinition, id: string, foldPlainEntries = false) => getObjectRelationships(draft, toGraph(draft, { foldPlainEntries }), id);

test("conditions, right-side references, variable activation and STOP WHEN appear even when the graph omits them", () => {
  const draft = world();
  draft.variables = [
    { id: "hp", name: "Health", type: "number", defaultValue: 10 },
    { id: "limit", name: "Limit", type: "number", defaultValue: 3 },
    { id: "alarm", name: "Alarm", type: "boolean", defaultValue: false, activation: { mode: "conditions", conditions: [{ variableId: "hp", operator: "lt", value: 3, valueRef: "limit" }], conditionLogic: "all" } },
  ];
  draft.reactions = [reaction("hurt", {
    conditions: [{ variableId: "hp", operator: "lt", value: 3, valueRef: "limit" }],
    stopConditions: [{ variableId: "hp", operator: "gte", value: 10 }],
    then: [{ type: "set", path: "hp", value: 1, operation: "subtract" }],
  })];
  const before = structuredClone(draft);
  const hp = inspect(draft, "var:hp");
  assert.deepEqual(hp.outgoing.map(item => [item.kind, item.target.objectId]).sort(), [
    ["activate-variable", "var:alarm"], ["condition", "reaction:hurt"], ["stop-condition", "reaction:hurt"],
  ]);
  assert.equal(hp.incoming[0]!.kind, "write-value");
  assert.equal(hp.incoming[0]!.target.objectId, "reaction:hurt");
  assert.ok(hp.incoming[0]!.edge);
  assert.deepEqual(hp.incoming[0]!.paths, ["reactions[0].then[0].path"]);
  const limit = inspect(draft, "var:limit");
  assert.equal(limit.outgoing.length, 2);
  assert.ok(limit.outgoing.every(item => item.paths[0]!.endsWith("valueRef")));
  assert.deepEqual(draft, before, "relationship inspection never alters the document");
});

test("graph and structured evidence merge without duplicating the same condition or conflating value writes with enable toggles", () => {
  const draft = world();
  draft.variables = [{ id: "hp", name: "Health", type: "boolean", defaultValue: true }];
  draft.entries = [entry("lore", { conditions: [{ variableId: "hp", operator: "eq", value: true }, { variableId: "hp", operator: "neq", value: false }] })];
  draft.reactions = [reaction("switch", { then: [
    { type: "set", path: "hp", operation: "toggle", value: true },
    { type: "set", path: "@vars.enabled.hp", value: false },
  ] })];
  const result = inspect(draft, "var:hp");
  assert.equal(result.outgoing.length, 1);
  assert.equal(result.outgoing[0]!.kind, "gate-entry");
  assert.equal(result.outgoing[0]!.edgeIds.length, 2);
  assert.equal(result.outgoing[0]!.paths.length, 2);
  assert.match(result.outgoing[0]!.label!, /= true/);
  assert.match(result.outgoing[0]!.label!, /≠ false/);
  assert.deepEqual(result.incoming.map(item => item.kind).sort(), ["toggle-variable", "write-value"]);
});

test("only real templates and structured references count; mentions, comparison literals, and JSON payloads do not", () => {
  const draft = world();
  draft.variables = [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }, { id: "hp2", name: "Other", type: "number", defaultValue: 5 }];
  draft.entries = [
    entry("prose", { content: "hp is the name mentioned in this sentence. {{hp2}}" }),
    entry("template", { content: "Remaining: {{ hp }}" }),
    entry("literal", { conditions: [{ variableId: "hp2", operator: "eq", value: "hp" }] }),
  ];
  draft.reactions = [reaction("literal-effect", { then: [{ type: "set", path: "hp2", value: { variableId: "hp", content: "{{hp}}" } }] })];
  const result = inspect(draft, "var:hp");
  assert.deepEqual(result.outgoing.map(item => [item.kind, item.target.objectId]), [["read-variable", "entry:template"]]);
  assert.equal(result.incoming.length, 0);
});

test("ownership uses the real module assignment, including orphans and entries folded out of the graph", () => {
  const draft = world();
  draft.worldbooks = [{ id: "mine", name: "Mine", activation: { mode: "always" }, order: 0 }];
  draft.entries = Array.from({ length: 7 }, (_, index) => entry(`lore-${index}`, { worldbookId: "mine" }));
  draft.entries.push(entry("orphan", { worldbookId: "deleted" }));
  const graph = toGraph(draft);
  assert.ok(graph.nodes.some(node => node.id === "module-entries:mine"));
  const mine = getObjectRelationships(draft, graph, "module:mine");
  assert.equal(mine.members.length, 7);
  assert.ok(mine.members.every(item => !item.inGraph && !item.missing && item.objectId?.startsWith("entry:")));
  assert.equal(mine.incoming.length + mine.outgoing.length, 0);
  const orphan = getObjectRelationships(draft, graph, "entry:orphan");
  assert.equal(orphan.object.missing, false);
  assert.equal(orphan.owner!.graphNodeId, "module:deleted");
  assert.equal(orphan.owner!.missing, true);
  assert.equal(orphan.owner!.objectId, null);
  assert.equal(inspect(draft, "module:deleted").members[0]!.objectId, "entry:orphan");
});

test("dangling variables, generated entry placeholders and deleted opening gates are marked missing", () => {
  const draft = world();
  draft.entries = [entry("lore", { conditions: [{ variableId: "deleted-hp", operator: "gt", value: 0 }] })];
  draft.reactions = [reaction("broken", { then: [
    { type: "set", path: "@prompt.entry.deleted-entry", value: true },
    { type: "set", path: "deleted-bag.coins", value: 1 },
  ] })];
  draft.worldbooks = [{ id: "mine", name: "Mine", activation: { mode: "greeting", greetingIds: ["deleted-opening"] }, order: 0 }];
  const lore = inspect(draft, "entry:lore");
  assert.equal(lore.incoming[0]!.target.graphNodeId, "var:deleted-hp");
  assert.equal(lore.incoming[0]!.target.missing, true);
  const broken = inspect(draft, "reaction:broken");
  const missingEntry = broken.outgoing.find(item => item.kind === "toggle-entry")!.target;
  assert.equal(missingEntry.inGraph, true, "engine placeholder node exists");
  assert.equal(missingEntry.missing, true, "placeholder is not an editable entry");
  assert.equal(missingEntry.objectId, null);
  assert.equal(broken.outgoing.find(item => item.kind === "write-value")!.target.graphNodeId, "var:deleted-bag");
  assert.equal(inspect(draft, "module:mine").incoming[0]!.target.graphNodeId, "greeting:deleted-opening");
  assert.equal(inspect(draft, "module:mine").incoming[0]!.target.missing, true);
});

test("opening seeds resolve legacy names and the card collection rail is not mistaken for a dependency", () => {
  const draft = world();
  draft.variables = [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }];
  draft.entries = [entry("opening", { role: "greeting", initialVariables: { Health: 7, "missing-variable": 2 } })];
  const result = inspect(draft, "greeting:opening");
  assert.equal(result.incoming.length, 0);
  assert.equal(result.outgoing.length, 2);
  const hp = result.outgoing.find(item => item.target.objectId === "var:hp")!;
  assert.equal(hp.kind, "seed-value");
  assert.equal(hp.label, "= 7");
  assert.deepEqual(hp.paths, ['entries[0].initialVariables["Health"]']);
  assert.equal(result.outgoing.find(item => item.target.missing)!.target.graphNodeId, "var:missing-variable");
});

test("events are meaningful non-editable triggers, and frontend reads and writes keep their directions", () => {
  const draft = world();
  draft.variables = [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }];
  draft.reactions = [reaction("turn")];
  draft.rootComponent = { id: "screen", name: "Player screen", entryFile: "App.tsx", updatedAt: "2026-09-05T00:00:00Z", files: { "App.tsx": 'export default function App(){ const n=api.variables.Health; api.setVariable("hp",2); const other=api.variables[key]; return <div>{n}</div> }' } };
  const behavior = inspect(draft, "reaction:turn");
  assert.equal(behavior.incoming[0]!.kind, "trigger");
  assert.equal(behavior.incoming[0]!.target.kind, "event");
  assert.equal(behavior.incoming[0]!.target.missing, false);
  assert.equal(behavior.incoming[0]!.target.objectId, null);
  const hp = inspect(draft, "var:hp");
  assert.deepEqual(hp.outgoing.map(item => [item.kind, item.target.objectId]), [["read-variable", "frontend"]]);
  assert.deepEqual(hp.incoming.map(item => [item.kind, item.target.objectId]), [["write-value", "frontend"]]);
  assert.equal(hp.hasDynamicCodeAccess, true);
});

test("module context and wake-on-close are distinct relations, and a track named by title resolves to its own node", () => {
  const draft = world();
  draft.worldbooks = [
    { id: "mine", name: "Mine", order: 0, activation: { mode: "always" } },
    { id: "worker", name: "Chronicler", order: 1, activation: { mode: "always" }, station: { kind: "worker", inputs: [{ kind: "memory", from: "mine", as: "history" }, { kind: "transcript", from: "mine", as: "lore", limit: 8 }], trigger: { on: "module-closed", from: "mine" } } },
  ];
  draft.audioTracks = [{ id: "rain-id", name: "Rain", type: "bgm", url: "rain.mp3", loop: true, volume: 1 }];
  draft.reactions = [reaction("music", { then: [{ type: "set", path: "@audio.bgm", value: "Rain" }] })];
  const worker = inspect(draft, "module:worker");
  assert.deepEqual(worker.incoming.map(item => item.kind), ["read-context", "read-context", "wake-module"]);
  assert.deepEqual(worker.incoming.filter(item => item.kind === "read-context").map(item => item.labelKey), ["contextWire.memory.history", "contextWire.transcript.lore"]);
  const music = inspect(draft, "reaction:music");
  assert.equal(music.outgoing[0]!.target.graphNodeId, "audio:rain-id");
  assert.equal(music.outgoing[0]!.target.objectId, "audio:rain-id");
  assert.equal(music.outgoing[0]!.target.missing, false);
  assert.equal(inspect(draft, "audio:rain-id").incoming[0]!.target.objectId, "reaction:music");
});

test("card context and missing module sources remain visible, and excluding a variable from an event is not a trigger", () => {
  const draft = world();
  draft.variables = [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }];
  draft.worldbooks = [{ id: "mine", name: "Mine", order: 0, activation: { mode: "always" }, station: { kind: "narrator", inputs: [{ kind: "memory", from: "core" }, { kind: "variables", from: "deleted-module" }] } }];
  draft.reactions = [reaction("other-state", { when: { eventType: "state:changed", match: { variableId: { operator: "neq", value: "hp" } } } })];
  const module = inspect(draft, "module:mine");
  assert.deepEqual(module.incoming.map(item => [item.kind, item.target.graphNodeId, item.target.missing]), [
    ["read-context", "world:root", false], ["read-context", "module:deleted-module", true],
  ]);
  const hp = inspect(draft, "var:hp");
  assert.deepEqual(hp.outgoing.map(item => item.kind), ["related"]);
});

test("visual interface actions are writes even before TSX compilation, while add actions also read the old value", () => {
  const draft = world();
  draft.variables = [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }];
  draft.uiDoc = { version: 1, entryPageId: "page", pages: [{ id: "page", name: "Main", height: 812, elements: [
    { id: "button", type: "button", x: 0, y: 0, w: 100, h: 40, label: { template: "Heal" }, actions: [{ kind: "set-variable", variableId: "hp", op: "set", value: 20 }, { kind: "set-variable", variableId: "missing-hp", op: "set", value: 5 }] },
  ] }] };
  const hp = inspect(draft, "var:hp");
  assert.equal(hp.outgoing.length, 0, "setting a fixed value does not read the previous state");
  assert.equal(hp.incoming[0]!.kind, "write-value");
  assert.equal(hp.incoming[0]!.target.objectId, "frontend");
  const frontend = inspect(draft, "frontend");
  assert.equal(frontend.outgoing.find(item => item.target.graphNodeId === "var:missing-hp")!.target.missing, true);
  const button = draft.uiDoc.pages[0]!.elements[0]!;
  if (button.type === "button") button.actions = [{ kind: "set-variable", variableId: "hp", op: "add", value: 2 }];
  assert.equal(inspect(draft, "var:hp").outgoing[0]!.kind, "read-variable");
});
