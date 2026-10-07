import assert from "node:assert/strict";
import test from "node:test";
import { LorebookMatcher, PromptBuilder, worldDefinitionSchema } from "@yumina/engine";
import { defaultStateFor, turnContextView } from "./turn-context";

const entry = (id: string, extra = {}) => ({ id, name: id, content: `sentinel_${id}`, role: "lore", section: "system-presets", alwaysSend: true, ...extra });
const variable = (id: string, extra = {}) => ({ id, name: id, type: "number", defaultValue: 1, ...extra });
const world = (extra: Record<string, unknown>) => worldDefinitionSchema.parse({ id: "test", name: "Test", description: "", author: "", settings: {}, ...extra });

test("alwaysSend overrides keywords; conditional and explicit variable-bound entries are not baseline", () => {
  const card = world({ entries: [entry("constant", { keywords: ["unspoken"] }),
    entry("conditional", { conditions: [{ variableId: "open", operator: "eq", value: true }] }),
    entry("bound", { variableBound: true }), entry("disabled", { enabled: false }),
    entry("unconfigured", { alwaysSend: false })] });
  const state = defaultStateFor(card);
  const view = turnContextView(card, state, false);
  assert.equal(view.on[0]?.alwaysEntries, 1);
  assert.equal(view.standby, 2);
  const matched = new LorebookMatcher().matchWithBudget(card.entries, [], state);
  const prompt = new PromptBuilder().buildSystemMessages(card, state, matched.triggered).map((message) => message.content).join("\n");
  assert.match(prompt, /sentinel_constant/);
  assert.doesNotMatch(prompt, /sentinel_disabled|sentinel_conditional/);
});

test("frontend gates and runtime enable overrides are evaluated before baseline counting", () => {
  const card = world({ entries: [entry("slot"), entry("toggled", { enabled: false }), entry("off")],
    loreUiBindings: [{ entryId: "slot", slotId: "codex", conditions: [{ variableId: "key", operator: "eq", value: true }], conditionLogic: "all" }],
    variables: [{ id: "key", name: "Key", type: "boolean", defaultValue: false, internal: true }] });
  const state = defaultStateFor(card);
  state.ruleState!.toggledEntries = { toggled: true, off: false };
  state.metadata.activeLoreSlots = ["codex"];
  assert.equal(turnContextView(card, state, true).on[0]?.alwaysEntries, 1);
  state.variables.key = true;
  assert.equal(turnContextView(card, state, true).on[0]?.alwaysEntries, 2);
  state.metadata.activeLoreSlots = [];
  assert.equal(turnContextView(card, state, true).on[0]?.alwaysEntries, 1);
});

test("AI variable counts respect disabled, greeting, condition, internal and module gates", () => {
  const card = world({ worldbooks: [{ id: "chapter", name: "Chapter", activation: { mode: "manual" } }], variables: [
    variable("plain"), variable("off", { enabled: false }), variable("internal", { internal: true }),
    variable("hidden", { aiAccess: "none" }), variable("chapter", { worldbookId: "chapter" }),
    variable("opening", { activation: { mode: "greeting", greetingIds: ["start-b"] } }),
    variable("condition", { activation: { mode: "conditions", conditions: [{ variableId: "plain", operator: "gt", value: 3 }], conditionLogic: "all" } }),
  ] });
  const state = defaultStateFor(card);
  state.ruleState!.toggledWorldbooks = { chapter: false };
  assert.equal(turnContextView(card, state, true).on[0]?.vars, 1);
  state.activeGreetingId = "start-b";
  state.variables.plain = 4;
  state.ruleState!.toggledVariables = { off: true };
  assert.equal(turnContextView(card, state, true).on[0]?.vars, 4);
  assert.deepEqual(turnContextView(card, state, true).off.map((item) => item.id), ["chapter"]);
});

test("initial defaults do not pretend a greeting is selected and orphan entries remain core", () => {
  const card = world({ entries: [entry("orphan", { worldbookId: "deleted" })],
    worldbooks: [{ id: "opening", name: "Opening", activation: { mode: "greeting", greetingIds: ["a"] } }] });
  const state = defaultStateFor(card);
  assert.equal(state.activeGreetingId, undefined);
  assert.deepEqual(state.metadata, {});
  const view = turnContextView(card, state, false);
  assert.equal(view.live, false);
  assert.equal(view.on[0]?.alwaysEntries, 1);
  assert.deepEqual(view.off.map((item) => item.id), ["opening"]);
});
