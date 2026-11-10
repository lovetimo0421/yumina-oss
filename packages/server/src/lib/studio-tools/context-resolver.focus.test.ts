import test from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { resolveContext, resolveFocusSelection } from "./context-resolver.js";
import { buildSystemPrompt } from "./system-prompt.js";

// The creator pointed the assistant at part of the card. Only that goes in
// full; the rest stays a line in the inventory the assistant can read from.

function world(): WorldDefinition {
  return {
    id: "w",
    name: "雾港钟表铺",
    entries: [
      { id: "preset", name: "Writing style", content: "PRESET-BODY always sent", role: "system", section: "system-presets", enabled: true, alwaysSend: true, keywords: [], conditions: [] },
      { id: "city", name: "城市概况", content: "CITY-BODY 雾港是一座常年起雾的海港城市", role: "lore", enabled: true, alwaysSend: true, keywords: [], conditions: [] },
      { id: "linwan", name: "林晚", content: "LINWAN-BODY 钟表铺的店主", role: "character", enabled: true, alwaysSend: false, keywords: ["林晚"], conditions: [] },
      { id: "open1", name: "开场白", content: "OPEN-BODY 雾很浓", role: "greeting", enabled: true, alwaysSend: false, keywords: [], conditions: [] },
    ],
    variables: [{ id: "trust", name: "信任", type: "number", defaultValue: 10 }],
    rules: [],
    reactions: [],
    audioTracks: [],
    components: [],
    customUI: [],
    rootComponent: { name: "UI", entryFile: "index.tsx", files: { "index.tsx": "export default function App() { return <Chat /> } // UI-CODE" }, updatedAt: "2026-09-30" },
  } as unknown as WorldDefinition;
}

test("pointing at one entry preloads that entry and nothing else in full", async () => {
  const resolved = await resolveContext(world(), "改一下林晚和城市的界面", { userId: "u", focusIds: ["entry:linwan"] });
  assert.match(resolved.preloadedEntities, /LINWAN-BODY/);
  assert.doesNotMatch(resolved.preloadedEntities, /CITY-BODY/, "a keyword match is not loaded when something is pointed at");
  assert.doesNotMatch(resolved.preloadedEntities, /PRESET-BODY/, "always-on presets are not loaded either");
  assert.doesNotMatch(resolved.preloadedEntities, /UI-CODE/, "interface code is not loaded for an entry");
  assert.deepEqual(resolved.focus?.labels, ['entry "林晚" (linwan)']);
  assert.match(resolved.inventory, /城市概况/, "the rest of the card is still listed, so it can be read on demand");
});

test("without a selection the resolver guesses as before", async () => {
  const resolved = await resolveContext(world(), "改一下林晚", { userId: "u" });
  assert.equal(resolved.focus, undefined);
  assert.match(resolved.preloadedEntities, /PRESET-BODY/);
});

test("blocks resolve to everything of their kind", () => {
  const w = world();
  assert.deepEqual(resolveFocusSelection(w, ["block:starter:opening"]).entries.map((e) => e.id), ["open1"]);
  assert.deepEqual(resolveFocusSelection(w, ["block:starter:setting"]).entries.map((e) => e.id), ["city", "linwan"]);
  assert.equal(resolveFocusSelection(w, ["block:frontend"]).wantUI, true);
  const vars = resolveFocusSelection(w, ["var:trust"]);
  assert.equal(vars.entries.length, 0);
  assert.deepEqual(vars.labels, ['variable "信任" (trust)']);
});

test("an id that matches nothing falls back to the normal context", async () => {
  const resolved = await resolveContext(world(), "改一下林晚", { userId: "u", focusIds: ["entry:gone"] });
  assert.equal(resolved.focus, undefined);
});

test("the prompt tells the assistant what was pointed at and that it can read the rest", async () => {
  const resolved = await resolveContext(world(), "缩短一点", { userId: "u", focusIds: ["entry:linwan", "var:trust"] });
  const prompt = buildSystemPrompt(resolved, {});
  const dynamic = JSON.stringify(prompt);
  assert.match(dynamic, /creator-focus/);
  assert.match(dynamic, /林晚/);
  assert.match(dynamic, /read_entities/);
});

// Asked for two characters, the assistant read the two it had just written in
// the rebuilt inventory as the card's own, and wrote two more, three times.
// The inventory now stays as of the request; when it is rebuilt mid-request
// (an editor save), what this request made is named.
test("the prompt says the inventory is as of the request and names what this request made", async () => {
  const resolved = await resolveContext(world(), "再加两个配角", { userId: "u" });
  const prompt = buildSystemPrompt(resolved, { stableInventory: true, madeThisRun: [{ type: "entry", id: "npc-maurice", name: "配角·莫里斯" }] });
  assert.match(prompt.world, /as it was when the creator sent this request/);
  assert.match(prompt.world, /in your tool results, not in this list/);
  // With the stable prompt switched off, the inventory is rebuilt after every write and says so.
  assert.match(buildSystemPrompt(resolved, {}).world, /rebuilt after every write/);
  assert.match(prompt.dynamic, /made-this-request/);
  assert.match(prompt.dynamic, /npc-maurice "配角·莫里斯"/);
  assert.doesNotMatch(buildSystemPrompt(resolved, {}).dynamic, /made-this-request/);
});

// Outside AIs (the card MCP) read the same core rules, with the Studio-only parts swapped.
test("outside AIs get the Studio's core rules with only the Studio-only parts swapped", async () => {
  const { outsideCorePrompt } = await import("./system-prompt.js");
  const text = outsideCorePrompt();
  assert.doesNotMatch(text, /You are Yumina Studio/);
  assert.match(text, /none of the skills are preloaded for you/);
  assert.match(text, /generates at once, charges the creator/);
  assert.match(text, /Ask the creator in your own chat instead/);
  assert.match(text, /<reference-integrity>/);
  assert.match(text, /<error-recovery>/);
});
