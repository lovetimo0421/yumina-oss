import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { reactionSchema, ReactionEvaluator, remapReactionReferences, type Rule, type Reaction } from "@yumina/engine";

const memory = new Map<string, string>();
globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, String(v)), removeItem: k => void memory.delete(k), clear: () => memory.clear(), key: () => null, length: 0 };
const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { useEditorStore } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const { editableBehaviors, preserveLegacyEffect } = await vite.ssrLoadModule("/src/features/editor/lib/editable-behaviors.ts") as typeof import("../features/editor/lib/editable-behaviors");
after(async () => { await vite.close(); });
afterEach(() => { useEditorStore.getState().stopAutosave(); memory.clear(); });
function fixture(trigger: Rule["trigger"] = { type: "keyword", keywords: ["door"], matchWholeWords: true, secondaryKeywords: ["open"], secondaryKeywordLogic: "AND_ALL" }) {
  const rule: Rule = { id: "old", name: "Old behavior", trigger, conditions: [], conditionLogic: "all", enabled: true, priority: 1, actions: [{ type: "inject-directive", directiveId: "hint", content: "Original hint", position: "top", persistent: true, duration: 3 }] };
  const native: Reaction = { id: "new", name: "New behavior", when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all", then: [], enabled: true, priority: 1 };
  const s = useEditorStore.getState(); s.createNew(); s.stopAutosave();
  useEditorStore.setState({ worldDraft: { ...useEditorStore.getState().worldDraft, rules: [rule], reactions: [native] } });
  return { rule, native };
}
test("legacy edits persist alongside native behaviors, retain rich triggers, and undo as one change", () => {
  const { rule } = fixture();
  const s = useEditorStore.getState();
  assert.deepEqual(editableBehaviors(s.worldDraft).map(r => r.id), ["old", "new"]);
  s.updateReaction("old", { description: "Edited", when: { eventType: "message:user", _legacyTrigger: { ...rule.trigger, keywords: ["gate"] } } });
  let d = useEditorStore.getState().worldDraft;
  assert.equal(d.rules.length, 0);
  const saved = reactionSchema.parse(JSON.parse(JSON.stringify(d.reactions![0])));
  assert.equal(saved.description, "Edited");
  assert.deepEqual(saved.when._legacyTrigger, { ...rule.trigger, keywords: ["gate"] });
  const evaluator = new ReactionEvaluator();
  const state = { worldId: "w", turnCount: 1, variables: {}, metadata: {} };
  assert.deepEqual(evaluator.evaluate({ type: "message:user", content: "open gate" }, [saved], [], state).firedIds, ["old"]);
  assert.equal(evaluator.evaluate({ type: "message:user", content: "open gates" }, [saved], [], state).firedIds.length, 0);
  assert.equal(evaluator.evaluate({ type: "message:user", content: "gate" }, [saved], [], state).firedIds.length, 0);
  s.undo(); assert.equal(useEditorStore.getState().worldDraft.rules.length, 1);
  s.redo(); assert.equal(useEditorStore.getState().worldDraft.rules.length, 0);
  s.removeReaction("old"); s.removeReaction("new");
  assert.equal(editableBehaviors(useEditorStore.getState().worldDraft).length, 0);
});
test("adding a behavior never hides legacy behaviors and deleting a legacy-only behavior persists", () => {
  fixture(); const s = useEditorStore.getState(); s.addReaction();
  assert.equal(useEditorStore.getState().worldDraft.reactions!.length, 3);
  fixture(); useEditorStore.setState({ worldDraft: { ...useEditorStore.getState().worldDraft, reactions: [] } });
  s.removeReaction("old");
  assert.equal(editableBehaviors(useEditorStore.getState().worldDraft).length, 0);
});
test("crossing trigger survives save and variable ID remapping without duplicate firing", () => {
  fixture({ type: "variable-crossed", variableId: "hp", direction: "drops-below", threshold: 20 });
  const s = useEditorStore.getState(); s.updateReaction("old", { name: "Edited threshold" });
  const saved = reactionSchema.parse(useEditorStore.getState().worldDraft.reactions![0]);
  const copied = remapReactionReferences(saved, { variableId: id => id === "hp" ? "copied-hp" : id, entryId: id => id, reactionId: id => id });
  const evaluator = new ReactionEvaluator();
  const state = { worldId: "w", turnCount: 1, variables: {}, metadata: {} };
  assert.deepEqual(evaluator.evaluate({ type: "state:changed", variableId: "copied-hp", oldValue: 25, newValue: 15 }, [copied], [], state).firedIds, ["old"]);
  assert.equal(evaluator.evaluate({ type: "state:changed", variableId: "hp", oldValue: 25, newValue: 15 }, [copied], [], state).firedIds.length, 0);
});
test("specific turn and repeated turn conditions retain their original OR semantics", () => {
  fixture({ type: "turn-count", atTurn: 3, everyNTurns: 5 });
  const s = useEditorStore.getState(); s.updateReaction("old", { description: "Edited" });
  const saved = reactionSchema.parse(useEditorStore.getState().worldDraft.reactions![0]);
  const evaluator = new ReactionEvaluator();
  for (const [turnCount, expected] of [[3, 1], [5, 1], [4, 0]]) {
    assert.equal(evaluator.evaluate({ type: "turn:complete", turnCount }, [saved], [], { worldId: "w", turnCount, variables: {}, metadata: {} }).firedIds.length, expected);
  }
});
test("editing a legacy directive keeps its lifetime, position, and directive ID", () => {
  fixture(); const before = editableBehaviors(useEditorStore.getState().worldDraft)[0]!.then[0]!;
  const changed = preserveLegacyEffect(before, { type: "set", path: "@prompt.context", value: "Edited hint" });
  assert.deepEqual(changed, { ...before, value: { content: "Edited hint", position: "top", persistent: true, duration: 3 } });
});

test("uninstalling a bundle still removes its behaviors after legacy conversion", () => {
  fixture();
  useEditorStore.setState({ worldDraft: { ...useEditorStore.getState().worldDraft, installedBundles: [{
    installId: "bundle", name: "Test bundle", colorKey: "blue", importedAt: new Date().toISOString(), originalHash: "test",
    entryIds: [], variableIds: [], ruleIds: ["old"], reactionIds: [], audioTrackIds: [], folderIds: [],
  }] } });
  const s = useEditorStore.getState();
  s.updateReaction("old", { description: "Edited" });
  const record = useEditorStore.getState().worldDraft.installedBundles![0]!;
  assert.deepEqual(record.ruleIds, []);
  assert.deepEqual(record.reactionIds, ["old"]);
  s.removeInstalledBundle("bundle");
  assert.deepEqual(editableBehaviors(useEditorStore.getState().worldDraft).map(r => r.id), ["new"]);
});

test("Studio keyword editing and deletion work through the rendered legacy behavior controls", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>');
  const React = await import("react");
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { BehaviorsSection } = await vite.ssrLoadModule("/src/features/editor/sections/behaviors-section.tsx");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  fixture();
  try {
    await React.act(async () => root.render(React.createElement(BehaviorsSection)));
    assert.match(container.textContent!, /Old behavior/);
    assert.match(container.textContent!, /New behavior/);
    const keyword = [...container.querySelectorAll("input")].find(el => el.value === "door")!;
    assert.ok(keyword, "Legacy keywords must appear in an editable input");
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(keyword, "gate");
      keyword.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    assert.deepEqual(useEditorStore.getState().worldDraft.reactions![0]!.when._legacyTrigger!.keywords, ["gate"]);
    assert.equal(keyword.value, "gate");
    const deleteButton = container.querySelector<HTMLButtonElement>('[data-tour="behaviors-detail"] button.text-destructive')!;
    assert.ok(deleteButton);
    await React.act(async () => deleteButton.click());
    await React.act(async () => deleteButton.click());
    assert.deepEqual(editableBehaviors(useEditorStore.getState().worldDraft).map(r => r.id), ["new"]);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
