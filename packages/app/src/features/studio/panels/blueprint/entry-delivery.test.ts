import { strict as assert } from "node:assert";
import { test } from "node:test";
import { filterEntriesByActiveLoreSlots, filterEntriesByActiveWorldbooks, LorebookMatcher, PromptBuilder, worldDefinitionSchema } from "@yumina/engine";
import type { GameState, LoreUiBinding, Worldbook, WorldEntry } from "@yumina/engine";
import { getEntryDeliverySummary } from "./entry-delivery";

const base: WorldEntry = {
  id: "setting", name: "Setting", content: "A secret behind the gate.", role: "lore",
  section: "system-presets", position: 0, enabled: true, alwaysSend: true,
  keywords: [], conditions: [], conditionLogic: "all",
};
const state = (open: boolean): GameState => ({ worldId: "review", turnCount: 0, variables: { open }, metadata: {} });
const matcher = new LorebookMatcher();

test("a stale always-send flag cannot make a condition-gated entry read as unconditional", () => {
  const entry: WorldEntry = { ...base, conditions: [{ variableId: "open", operator: "eq", value: true }] };
  assert.equal(getEntryDeliverySummary(entry).mode, "conditions");
  assert.equal(matcher.match([entry], [], state(false)).length, 0);
  assert.equal(matcher.match([entry], [], state(true)).length, 1);
});

test("disabled conditional entries remain disabled after matching and final prompt assembly", () => {
  const entry: WorldEntry = {
    ...base, enabled: false, alwaysSend: false,
    conditions: [{ variableId: "open", operator: "eq", value: true }],
  };
  const world = worldDefinitionSchema.parse({ id: "review", name: "Review", description: "", author: "", entries: [entry], settings: {} });
  const matched = matcher.matchWithBudget([entry], [], state(true));
  // The matcher admits condition-bound candidates despite enabled=false, but
  // the final prompt still excludes them. The summary describes AI delivery.
  assert.equal(matched.triggered.length, 1);
  assert.deepEqual(new PromptBuilder().buildTriggeredSystemMessages(world, state(true), matched.triggered), []);
  assert.deepEqual(new PromptBuilder().collectEntries(world, matched.triggered, undefined, undefined, state(true)), []);
  assert.equal(getEntryDeliverySummary(entry).mode, "disabled");
});

test("keyword-plus-condition summaries retain both gates and the secondary keyword restriction", () => {
  const entry: WorldEntry = {
    ...base, alwaysSend: false, keywords: ["gate"], secondaryKeywords: ["sealed"], secondaryKeywordLogic: "NOT_ANY",
    conditions: [{ variableId: "open", operator: "eq", value: true }],
  };
  const summary = getEntryDeliverySummary(entry);
  assert.equal(summary.mode, "keywords-and-conditions");
  assert.equal(summary.secondaryKeywords, true);
  assert.equal(matcher.match([entry], ["gate"], state(false)).length, 0);
  assert.equal(matcher.match([entry], ["sealed gate"], state(true)).length, 0);
  assert.equal(matcher.match([entry], ["gate"], state(true)).length, 1);
});

test("always-send entries retain module and frontend scope limits in their explanation", () => {
  const entry = { ...base, worldbookId: "chapter" };
  const worldbooks: Worldbook[] = [{ id: "chapter", name: "Chapter", order: 0, activation: { mode: "conditions", conditions: [{ variableId: "open", operator: "eq", value: true }], conditionLogic: "all" } }];
  const loreUiBindings: LoreUiBinding[] = [{ entryId: entry.id, slotId: "secret", conditions: [], conditionLogic: "all" }];
  const summary = getEntryDeliverySummary(entry, { worldbooks, loreUiBindings });
  assert.equal(summary.mode, "always");
  assert.equal(summary.moduleScoped, true);
  assert.equal(summary.frontendScoped, true);
  assert.equal(filterEntriesByActiveWorldbooks([entry], worldbooks, state(false)).length, 0);
  assert.equal(filterEntriesByActiveLoreSlots([entry], loreUiBindings, state(true)).length, 0);
  assert.equal(filterEntriesByActiveLoreSlots([entry], loreUiBindings, { ...state(true), metadata: { activeLoreSlots: ["secret"] } }).length, 1);
  // Dangling module references have no runtime gate and must not invent one.
  assert.equal(getEntryDeliverySummary(entry).moduleScoped, false);
});

test("enabled alone does not promise delivery without a trigger, and disabled entries stay distinct", () => {
  const entry = { ...base, alwaysSend: false };
  assert.equal(getEntryDeliverySummary(entry).mode, "unconfigured");
  assert.equal(matcher.match([entry], ["any message"], state(true)).length, 0);
  assert.equal(getEntryDeliverySummary({ ...base, enabled: false }).mode, "disabled");
  assert.equal(matcher.match([{ ...base, enabled: false }], [], state(true)).length, 0);
  const loreUiBindings: LoreUiBinding[] = [{ entryId: entry.id, slotId: "secret", conditions: [], conditionLogic: "all" }];
  assert.equal(getEntryDeliverySummary(entry, { loreUiBindings }).mode, "frontend");
});
