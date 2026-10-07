import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, afterEach, beforeEach } from "node:test";
import { createServer } from "vite";
import type { WorldDefinition } from "@yumina/engine";

const memory = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} });
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const vite = await createServer({
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
});
const { useEditorStore: store } = await vite.ssrLoadModule("/src/stores/editor.ts") as typeof import("./editor");
const initial = structuredClone(store.getState().worldDraft);

beforeEach(() => {
  store.setState({
    worldDraft: structuredClone(initial), serverWorldId: "card", isDirty: false, saving: false,
    guestMode: false, readOnlyInspect: false, _baseSchema: structuredClone(initial), _past: [], _future: [],
  });
});
afterEach(() => { store.getState().stopAutosave(); });
after(async () => {
  await vite.close();
  memory.clear();
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const draft = (): WorldDefinition => store.getState().worldDraft;

test("a card with no interface of its own gets one whose only content is the theme", () => {
  assert.equal(draft().uiDoc, undefined);
  store.getState().applyUiTheme({ id: "night" });

  const doc = draft().uiDoc!;
  assert.equal(doc.surface, "chat", "the platform's chat is what the theme is applied TO");
  assert.deepEqual(doc.pages.map(page => page.elements), [[]], "nothing is arranged; that is still the creator's to do");
  assert.equal(doc.theme?.preset?.id, "night");
  // Compiled on the spot: a card whose board said "entry file not found" until
  // the first save looks broken at the moment the creator is being sold on it.
  assert.equal(draft().rootComponent?.generatedFrom, "uiDoc");
  const code = draft().rootComponent!.files["index.tsx"]!;
  assert.match(code, /<Chat \/>/);
  assert.match(code, /--yc-text/);
});

test("switching themes replaces the look and keeps the creator's own CSS and fonts", () => {
  store.getState().applyUiTheme({ id: "night" });
  const fonts = [{ family: "Mine", ref: "@asset:1" }];
  store.getState().setUiDoc({ ...draft().uiDoc!, theme: { ...draft().uiDoc!.theme, fonts, css: ".play-message-block { letter-spacing: 0.02em }" } });

  store.getState().applyUiTheme({ id: "paper", accent: "#8c3b3b" });
  const theme = draft().uiDoc!.theme!;
  assert.equal(theme.preset!.id, "paper");
  assert.equal(theme.preset!.accent, "#8c3b3b");
  assert.deepEqual(theme.fonts, fonts, "an uploaded font belongs to the card, not to last week's theme");
  assert.match(theme.css!, /letter-spacing/);
});

test("clearing the theme hands the card back its default look without touching anything else", () => {
  store.getState().applyUiTheme({ id: "terminal" });
  store.getState().applyUiTheme(null);
  assert.equal(draft().uiDoc!.theme, undefined);
  assert.equal(draft().uiDoc!.surface, "chat", "the document survives; only the look is gone");
});

test("a card that already has an arrangement keeps every element", () => {
  store.getState().adoptUiDoc();
  const before = draft().uiDoc!.pages[0]!.elements.map(el => el.id);
  assert.ok(before.length > 0, "the builder's starting document has a transcript and a composer");

  store.getState().applyUiTheme({ id: "blossom", radius: "sharp" });
  assert.deepEqual(draft().uiDoc!.pages[0]!.elements.map(el => el.id), before);
  assert.equal(draft().uiDoc!.theme!.tokens!["--yc-bubble-radius"], "0px");
});

test("an unknown theme changes nothing at all", () => {
  store.getState().applyUiTheme({ id: "not-a-theme" });
  assert.equal(draft().uiDoc, undefined);
  assert.equal(store.getState().isDirty, false);
});

// Built the way the picker builds them: from what the layout itself declares.
const engine = await vite.ssrLoadModule("/../engine/src/index.ts") as typeof import("@yumina/engine");
const template = engine.getUiTemplate("portrait-scene")!;
const layoutStrings: Record<string, string> = { title: "Lin Zhou" };
for (const key of template.stringKeys) layoutStrings[key] = `word:${key}`;
const names = Object.fromEntries(template.needs.map(need => [need.key, `N:${need.key}`]));

test("a layout arrives with the variables it is bound to, seeded from the card's own art", () => {
  store.setState({ worldDraft: { ...draft(), avatar: "https://cdn.example/cover.png" } });
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);

  const made = draft().variables;
  assert.deepEqual(made.map(v => v.name), template.needs.map(need => `N:${need.key}`));
  const portrait = made.find(v => v.name === "N:portrait")!;
  assert.equal(portrait.defaultValue, "https://cdn.example/cover.png", "the card's cover IS the portrait until someone changes it");
  const affinity = made.find(v => v.name === "N:affinity")!;
  assert.deepEqual([affinity.type, affinity.min, affinity.max, affinity.defaultValue], ["number", 0, 100, 50]);
  // A json variable is authored through its text field; writing only the value
  // leaves the editor's own box blank next to a list that renders fine.
  const bag = made.find(v => v.name === "N:inventory")!;
  assert.deepEqual([bag.type, bag.defaultValue, bag.defaultValueText], ["json", [], "[]"]);

  // And the layout points at those variables rather than at anything baked in.
  const el = draft().uiDoc!.pages[0]!.elements.find(e => e.id === "tpl-portrait")!;
  assert.equal(el.type === "image" && el.src.kind === "variable" && el.src.variableId, portrait.id);
  assert.equal(draft().rootComponent?.generatedFrom, "uiDoc");
  assert.deepEqual(draft().uiDoc!.pages.map(p => p.id), ["page-1", "page-details"]);
});

test("a localized starting value reaches the variable, but only where one makes sense", () => {
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names, { location: "药庐", affinity: "nope" });
  const made = draft().variables;
  assert.equal(made.find(v => v.name === "N:location")!.defaultValue, "药庐");
  assert.equal(made.find(v => v.name === "N:affinity")!.defaultValue, 50, "a number keeps the engine's value");
});

test("a name the card already uses is reused, not duplicated beside itself", () => {
  // The creator's own affection meter, made before they went looking for a layout.
  store.setState({ worldDraft: { ...draft(), variables: [
    { id: "mine", name: "N:affinity", type: "number", defaultValue: 12, description: "" },
  ] } });
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);

  const affection = draft().variables.filter(v => v.name === "N:affinity");
  assert.equal(affection.length, 1, "one meter, not the creator's and the layout's side by side");
  assert.equal(affection[0]!.id, "mine");
  assert.equal(affection[0]!.defaultValue, 12, "and their value survives — the layout binds, it does not reset");

  const meter = draft().uiDoc!.pages[0]!.elements.find(e => e.id === "tpl-meter-1")!;
  assert.equal(meter.type === "meter" && meter.value.kind === "variable" && meter.value.variableId, "mine");
});

test("picking the same layout twice does not leave the card with two affection meters", () => {
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);
  const first = draft().variables.map(v => v.id);
  assert.equal(first.length, template.needs.length);
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);
  assert.deepEqual(draft().variables.map(v => v.id), first);
});

test("switching to another layout keeps the variables the two have in common", () => {
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);
  const affinityId = draft().variables.find(v => v.name === "N:affinity")!.id;

  const hud = engine.getUiTemplate("adventure-hud")!;
  const hudStrings: Record<string, string> = { title: "Lin Zhou" };
  for (const key of hud.stringKeys) hudStrings[key] = key.endsWith("Format") ? "{day}" : `word:${key}`;
  const hudNames = Object.fromEntries(hud.needs.map(need => [need.key, `N:${need.key}`]));
  store.getState().applyUiTemplate("adventure-hud", hudStrings, hudNames);

  // adventure-hud does not use affinity, so that variable simply stays put —
  // a behaviour may be driving it, and a layout change is not a state wipe.
  assert.ok(draft().variables.some(v => v.id === affinityId), "the old meter is not deleted");
  const stamina = draft().variables.filter(v => v.name === "N:stamina");
  assert.equal(stamina.length, 1, "both layouts want stamina; they share one");
  assert.equal(engine.detectUiTemplate(draft().uiDoc), "adventure-hud");
});

test("a layout arrives in its own colours, and a theme keeps the layout", () => {
  store.getState().applyUiTheme({ id: "terminal" });
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);
  assert.equal(draft().uiDoc!.theme!.preset!.id, template.look!.id, "picking the layout is picking its colours");
  const sheet = engine.getUiTemplate("character-sheet")!;
  const sheetStrings: Record<string, string> = { title: "Lin Zhou" };
  for (const key of sheet.stringKeys) sheetStrings[key] = key.endsWith("Format") ? "{age}" : `word:${key}`;
  store.getState().applyUiTemplate("character-sheet", sheetStrings, Object.fromEntries(sheet.needs.map(need => [need.key, `N:${need.key}`])));
  assert.equal(draft().uiDoc!.theme!.preset!.id, sheet.look!.id);

  store.getState().applyUiTheme({ id: "terminal" });
  const ids = draft().uiDoc!.pages[0]!.elements.map(el => el.id);
  assert.ok(ids.includes("tpl-messages") && ids.includes("tpl-composer"), "recolouring is not a rearrangement");
});

test("putting the layout away leaves the variables alone — a behaviour may be driving them by now", () => {
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);
  const made = draft().variables.map(v => v.id);
  store.getState().applyUiTemplate(null, layoutStrings, names);
  assert.deepEqual(draft().uiDoc!.pages[0]!.elements, []);
  assert.equal(draft().uiDoc!.surface, "chat");
  assert.equal(draft().uiDoc!.theme, undefined, "the platform's chat is in the platform's look");
  assert.deepEqual(draft().variables.map(v => v.id), made);
});

test("an unknown layout changes nothing at all", () => {
  store.getState().applyUiTemplate("not-a-layout", layoutStrings, names);
  assert.equal(draft().uiDoc, undefined);
  assert.deepEqual(draft().variables, []);
});

const hud = engine.getUiTemplate("adventure-hud")!;
const hudStrings: Record<string, string> = { title: "Lin Zhou" };
for (const key of hud.stringKeys) hudStrings[key] = key.endsWith("Format") ? "{day}" : `word:${key}`;
const hudNames = Object.fromEntries(hud.needs.map(need => [need.key, `N:${need.key}`]));

test("switching layouts lists what the old one left behind, and clearing removes exactly that", () => {
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);
  assert.equal(store.getState().templateLeftovers, null, "the first layout leaves nothing behind");
  const affinityId = draft().variables.find(v => v.name === "N:affinity")!.id;
  const staminaId = draft().variables.find(v => v.name === "N:stamina")!.id;

  store.getState().applyUiTemplate("adventure-hud", hudStrings, hudNames);
  const left = store.getState().templateLeftovers!;
  assert.ok(left.variableIds.includes(affinityId), "affinity is bound by nothing now");
  assert.ok(!left.variableIds.includes(staminaId), "stamina is shared with the new layout");
  assert.ok(draft().variables.some(v => v.id === affinityId), "listed, not deleted");

  const before = draft().variables.length;
  store.getState().discardTemplateLeftovers();
  assert.equal(draft().variables.length, before - left.variableIds.length);
  assert.ok(!draft().variables.some(v => v.id === affinityId));
  assert.equal(store.getState().templateLeftovers, null);
  assert.ok(store.getState().canUndo, "clearing is one undo step like any edit");
});

test("a leftover that grew a behaviour between the offer and the clearing stays", () => {
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);
  const affinityId = draft().variables.find(v => v.name === "N:affinity")!.id;
  store.getState().applyUiTemplate("adventure-hud", hudStrings, hudNames);
  assert.ok(store.getState().templateLeftovers!.variableIds.includes(affinityId));
  store.setState({ worldDraft: { ...draft(), reactions: [
    { id: "r", name: "cheer", enabled: true, priority: 0, when: { kind: "turn" }, conditions: [{ variableId: affinityId, operator: ">", value: 10 }], actions: [] },
  ] as never } });
  store.getState().discardTemplateLeftovers();
  assert.ok(draft().variables.some(v => v.id === affinityId), "re-checked at clearing time");
  assert.equal(store.getState().templateLeftovers, null);
});

test("keeping the leftovers only puts the offer away", () => {
  store.getState().applyUiTemplate("portrait-scene", layoutStrings, names);
  store.getState().applyUiTemplate(null, layoutStrings, names);
  const left = store.getState().templateLeftovers!;
  assert.equal(left.variableIds.length, template.needs.length, "back to plain chat, every layout variable is a leftover");
  const before = draft().variables.length;
  store.getState().keepTemplateLeftovers();
  assert.equal(draft().variables.length, before);
  assert.equal(store.getState().templateLeftovers, null);
});
