import assert from "node:assert/strict";
import test, { after } from "node:test";
import { act, createElement } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { toGraph, type Reaction, type WorldDefinition, type WorldEntry } from "@yumina/engine";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { ObjectRelationshipsPanel } = await import("./object-relationships-panel");
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { editor: { blueprint: {
  relationships: { title: "Relationships", scope: "Belongs to", members: "Contains", incoming: "Depends on", outgoing: "Used by", editObject: "View settings", missing: "Missing related object", missingObject: "This object no longer exists", empty: "No configured dependencies", configuredHint: "Configured dependencies only", kinds: { audio: "Plays audio", "write-value": "Writes value", "gate-entry": "Controls inclusion" } },
  navigation: { showInBlueprint: "Locate in global blueprint" }, rowEdit: { close: "Close" }, writing: { sharedScope: "Shared content" }, events: { eachTurn: "Each turn" },
} } } } });
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

const entry = (id: string, extra: Partial<WorldEntry> = {}): WorldEntry => ({ id, name: id, content: "", role: "custom", section: "system-presets", alwaysSend: true, keywords: [], conditions: [], conditionLogic: "all", enabled: true, position: 0, ...extra });
const reaction = (id: string, extra: Partial<Reaction> = {}): Reaction => ({ id, name: id, when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true, ...extra });
const world = (): WorldDefinition => ({ id: "card", name: "Card", description: "", author: "", version: "1", settings: {}, entries: [], variables: [], rules: [], reactions: [], components: [], customUI: [], audioTracks: [], worldbooks: [] });
const musicWorld = (): WorldDefinition => ({ ...world(),
  worldbooks: [{ id: "mine", name: "Mine", order: 0, activation: { mode: "always" } }],
  audioTracks: [{ id: "rain-id", name: "Rain", type: "bgm", url: "rain.mp3", loop: true, volume: 1 }],
  reactions: [reaction("music", { name: "Play rain", worldbookId: "mine", then: [{ type: "set", path: "@audio.bgm", value: "Rain" }] })],
});

async function withPanel(initialWorld: WorldDefinition, initialId: string, run: (context: {
  container: HTMLElement;
  opened: string[];
  edited: string[];
  located: string[];
  closed: () => number;
  button: (text: string, scope?: ParentNode) => HTMLButtonElement;
  click: (element: Element) => Promise<void>;
  render: (nextWorld: WorldDefinition, nextId?: string) => Promise<void>;
}) => Promise<void>) {
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const opened: string[] = [], edited: string[] = [], located: string[] = [];
  let closes = 0;
  let objectId = initialId;
  const render = async (draft: WorldDefinition, nextId = objectId) => {
    objectId = nextId;
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(ObjectRelationshipsPanel, {
      world: draft, graph: toGraph(draft, { foldPlainEntries: false }), objectId,
      onOpenObject: id => opened.push(id), onEditObject: id => edited.push(id), onShowInBlueprint: id => located.push(id), onClose: () => { closes++; },
    }))));
  };
  try {
    await render(initialWorld);
    await run({ container, opened, edited, located, closed: () => closes, render,
      button: (text, scope = container) => {
        const matches = [...scope.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent?.trim() === text || button.getAttribute("aria-label") === text);
        assert.equal(matches.length, 1, `expected one button named ${text}`);
        return matches[0]!;
      },
      click: async element => { await act(async () => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))); },
    });
  } finally { await act(async () => root.unmount()); }
}

test("related object and owner clicks use canonical authoring IDs, while settings and close remain distinct actions", async () => {
  const draft = musicWorld();
  const before = structuredClone(draft);
  await withPanel(draft, "reaction:music", async ({ container, opened, edited, located, closed, button, click }) => {
    const outgoing = container.querySelector('[data-relationship-direction="outgoing"]')!;
    const rain = [...outgoing.querySelectorAll("button")].find(item => item.textContent?.includes("Rain"))!;
    assert.ok(rain);
    await click(rain);
    await click(button("Mine"));
    assert.deepEqual(opened, ["audio:rain-id", "module:mine"], "the displayed track name is not its authoring ID");
    assert.deepEqual(edited, []); assert.deepEqual(located, []);
    await click(button("View settings")); assert.deepEqual(edited, ["reaction:music"]);
    await click(button("Close")); assert.equal(closed(), 1);
    assert.deepEqual(draft, before, "inspecting dependencies must not mutate their ownership or configuration");
  });
});

test("a behaviour naming a track by its title lands on the track's own node", async () => {
  const draft = musicWorld();
  // The card's node for the track is spelled with its id; a behaviour that
  // names it by title wires into that node rather than making an alias.
  assert.ok(toGraph(draft).nodes.some(node => node.id === "audio:rain-id"));
  assert.ok(!toGraph(draft).nodes.some(node => node.id === "audio:Rain"));
  await withPanel(draft, "audio:rain-id", async ({ container, edited, located, opened, button, click }) => {
    assert.equal(container.querySelector("h2")!.textContent, "Rain");
    await click(button("View settings"));
    await click(button("Locate in global blueprint"));
    assert.deepEqual(edited, ["audio:rain-id"]);
    assert.deepEqual(located, ["audio:rain-id"]);
    const incoming = container.querySelector('[data-relationship-direction="incoming"]')!;
    await click([...incoming.querySelectorAll("button")].find(item => item.textContent?.includes("Play rain"))!);
    assert.deepEqual(opened, ["reaction:music"]);
  });
});

test("missing references and event triggers are readable without exposing invalid object-edit navigation", async () => {
  const draft = world();
  draft.reactions = [reaction("broken", { name: "Broken rule", then: [{ type: "set", path: "@prompt.entry.deleted-entry", value: true }] })];
  await withPanel(draft, "reaction:broken", async ({ container, opened, edited, button, render }) => {
    const outgoing = container.querySelector('[data-relationship-direction="outgoing"]')!;
    assert.match(outgoing.textContent!, /deleted-entry.*Missing related object/);
    assert.equal(outgoing.querySelectorAll("button").length, 0, "an engine placeholder must not pretend to be an editable entry");
    const incoming = container.querySelector('[data-relationship-direction="incoming"]')!;
    assert.match(incoming.textContent!, /Each turn/);
    assert.equal(incoming.querySelectorAll("button").length, 0, "engine events are not authoring objects");
    assert.ok(button("View settings"));
    await render(draft, "entry:deleted-entry");
    assert.match(container.textContent!, /This object no longer exists/);
    assert.equal([...container.querySelectorAll("button")].some(item => item.textContent?.trim() === "View settings"), false);
    // A drawable engine placeholder can still be located; it cannot be edited.
    assert.ok(button("Locate in global blueprint"));
    await render(draft, "var:entirely-missing");
    assert.deepEqual([...container.querySelectorAll("button")].map(item => item.getAttribute("aria-label") || item.textContent?.trim()), ["Close"]);
    assert.deepEqual(opened, []); assert.deepEqual(edited, []);
  });
});

test("an open relationship panel refreshes its links and editability when the actual world changes", async () => {
  const draft = world();
  draft.variables = [{ id: "hp", name: "Health", type: "number", defaultValue: 10 }];
  draft.reactions = [reaction("hurt", { name: "Take damage", then: [{ type: "set", path: "hp", operation: "subtract", value: 1 }] })];
  await withPanel(draft, "var:hp", async ({ container, opened, button, click, render }) => {
    const panel = container.querySelector("[data-object-relationships]");
    assert.match(container.querySelector('[data-relationship-direction="incoming"]')!.textContent!, /Take damage/);
    const updated: WorldDefinition = { ...draft, variables: [{ ...draft.variables[0]!, name: "Vitality" }], reactions: [], entries: [entry("warning", { name: "Low health warning", conditions: [{ variableId: "hp", operator: "lt", value: 3 }] })] };
    await render(updated);
    assert.equal(container.querySelector("[data-object-relationships]"), panel, "the update refreshes the mounted panel instead of reopening it");
    assert.equal(container.querySelector("h2")!.textContent, "Vitality");
    assert.equal(container.querySelector('[data-relationship-direction="incoming"]'), null);
    assert.doesNotMatch(container.textContent!, /Take damage/);
    const outgoing = container.querySelector('[data-relationship-direction="outgoing"]')!;
    await click([...outgoing.querySelectorAll("button")].find(item => item.textContent?.includes("Low health warning"))!);
    assert.deepEqual(opened, ["entry:warning"]);
    assert.ok(button("View settings"));
    await render({ ...updated, variables: [] });
    assert.match(container.textContent!, /This object no longer exists/);
    assert.equal([...container.querySelectorAll("button")].some(item => item.textContent?.trim() === "View settings"), false);
  });
});
