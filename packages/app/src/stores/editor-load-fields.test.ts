import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";

/**
 * The load transform must not quietly drop a world's fields.
 *
 * Four hand-written field lists rebuild `worldDraft` from a loaded world, and
 * a field missing from one of them is invisible: the save writes it, the next
 * load forgets it, and the save after that writes the loss back. No error, no
 * toast. `backgrounds` shipped that way once; this test is why it cannot
 * again, and the same assertion catches the next field added to
 * WorldDefinition but not to the lists.
 */

const memory = new Map<string, string>();
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

beforeEach(() => {
  globalThis.fetch = async (url: unknown) => { throw new Error(`Unexpected network request: ${url}`); };
  memory.clear();
});
after(async () => { await vite.close(); });

/** Content that only exists inside the world's schema blob — the part a
 *  forgotten field list silently discards. */
const SCHEMA = {
  id: "w1",
  version: "1.0.0",
  name: "A rainy port",
  variables: [{ id: "v1", name: "Trust", type: "number", defaultValue: 0 }],
  customTagColors: { rain: "#123456" },
  installedBundles: [{ installId: "i1", bundleId: "b1", name: "Pack" }],
  systems: ["weather"],
  language: "zh",
  someFutureField: { kept: true },
  settings: {
    lorebookTokenBudget: 3000,
    lorebookBudgetPercent: 30,
    lorebookBudgetCap: 4000,
    structuredOutput: true,
    temperature: 0.7,
    narratorVoice: "alloy",
    voiceInputMode: "auto",
  },
};

function load() {
  store.getState().loadWorldFromData({
    id: "w1", name: "A rainy port", description: null,
    schema: SCHEMA as unknown as Record<string, unknown>, thumbnailUrl: null,
  });
  return store.getState().worldDraft as unknown as Record<string, any>;
}

const SCHEMA_CONTENT = {
  id: "w1",
  version: "1.0.0",
  name: "A rainy port",
  backgrounds: [
    { id: "bg1", name: "The quay", url: "@cover", blur: 8, dim: 55, position: "center", isDefault: true },
  ],
  sceneImages: [
    { id: "img1", name: "The lantern", url: "https://example.test/a.png", scene: "when the lamps come on" },
  ],
  audioTracks: [{ id: "t1", name: "Rain", url: "https://example.test/a.mp3", aiNote: "when it rains" }],
  variables: [{ id: "v1", name: "Trust", type: "number", defaultValue: 0, precise: true, deltaDown: 3, deltaUp: 5, options: undefined }],
  continuity: { bgm: true, images: true },
};

test("a world's backgrounds survive being loaded", () => {
  store.getState().loadWorldFromData({
    id: "w1", name: "A rainy port", description: null,
    schema: SCHEMA_CONTENT as unknown as Record<string, unknown>, thumbnailUrl: null,
  });
  const draft = store.getState().worldDraft;
  assert.equal(draft.backgrounds?.length, 1, "backgrounds were dropped by the load transform");
  assert.equal(draft.backgrounds?.[0]!.id, "bg1");
  // The processing the author set is the whole point of the block — a
  // background that reloads at someone else's blur is its own bug.
  assert.equal(draft.backgrounds?.[0]!.blur, 8);
  assert.equal(draft.backgrounds?.[0]!.dim, 55);
});

test("it does not drop the neighbours either", () => {
  // backgrounds sits between sceneImages and audioTracks in every list; this
  // pins that adding it did not displace them.
  store.getState().loadWorldFromData({
    id: "w1", name: "A rainy port", description: null,
    schema: SCHEMA_CONTENT as unknown as Record<string, unknown>, thumbnailUrl: null,
  });
  const draft = store.getState().worldDraft;
  assert.equal(draft.sceneImages?.length, 1);
  assert.equal(draft.audioTracks?.length, 1);
  assert.equal(draft.variables.length, 1);
});

test("the continuity judge's settings survive being loaded", () => {
  // `continuity` is a world-level object with its own slot in every list;
  // the per-track cue and per-variable precise settings ride inside objects
  // the lists already copy whole.
  store.getState().loadWorldFromData({
    id: "w1", name: "A rainy port", description: null,
    schema: SCHEMA_CONTENT as unknown as Record<string, unknown>, thumbnailUrl: null,
  });
  const draft = store.getState().worldDraft;
  assert.deepEqual(draft.continuity, { bgm: true, images: true }, "continuity was dropped by the load transform");
  assert.equal(draft.audioTracks?.[0]!.aiNote, "when it rains");
  assert.equal(draft.variables[0]!.precise, true);
  assert.equal(draft.variables[0]!.deltaUp, 5);
});

test("fields added after the list was written survive being loaded", () => {
  // The load used to rebuild the draft from a list of names; tag colours,
  // installed packs and the narrator voice were not on it, and the next save
  // deleted them from the server.
  store.getState().loadWorldFromData({
    id: "w1", name: "A rainy port", description: null,
    schema: {
      ...SCHEMA_CONTENT,
      customTagColors: { rain: "#123456" },
      installedBundles: [{ installId: "i1", bundleId: "b1", name: "Pack" }],
      systems: ["weather"],
      settings: { narratorVoice: "alloy", lorebookBudgetCap: 4000, temperature: 0.7 },
    } as unknown as Record<string, unknown>,
    thumbnailUrl: null,
  });
  const draft = store.getState().worldDraft;
  assert.deepEqual(draft.customTagColors, { rain: "#123456" });
  assert.equal(draft.installedBundles?.[0]!.installId, "i1");
  assert.deepEqual(draft.systems, ["weather"]);
  assert.equal(draft.settings.narratorVoice, "alloy");
  assert.equal(draft.settings.lorebookBudgetCap, 4000);
  assert.equal(draft.settings.temperature, 0.7);
  // Defaults still fill what the schema does not say.
  assert.equal(draft.settings.maxTokens, 12000);
});

// Main's parallel fix (e75efaa94) pinned these too.
const LATER_SCHEMA = {
  id: "w1",
  version: "1.0.0",
  name: "A rainy port",
  variables: [{ id: "v1", name: "Trust", type: "number", defaultValue: 0 }],
  customTagColors: { rain: "#123456" },
  installedBundles: [{ installId: "i1", bundleId: "b1", name: "Pack" }],
  systems: ["weather"],
  language: "zh",
  someFutureField: { kept: true },
  settings: {
    lorebookTokenBudget: 3000,
    lorebookBudgetPercent: 30,
    lorebookBudgetCap: 4000,
    structuredOutput: true,
    temperature: 0.7,
    narratorVoice: "alloy",
    voiceInputMode: "auto",
  },
};

function loadLater() {
  store.getState().loadWorldFromData({
    id: "w1", name: "A rainy port", description: null,
    schema: LATER_SCHEMA as unknown as Record<string, unknown>, thumbnailUrl: null,
  });
  return store.getState().worldDraft as unknown as Record<string, any>;
}

test("world-level fields outside the old field list survive being loaded", () => {
  const draft = loadLater();
  assert.deepEqual(draft.customTagColors, { rain: "#123456" });
  assert.equal(draft.installedBundles?.[0]?.installId, "i1");
  assert.deepEqual(draft.systems, ["weather"]);
  assert.equal(draft.language, "zh");
  assert.deepEqual(draft.someFutureField, { kept: true }, "a field added later must ride through too");
});

test("settings outside the old field list survive, and defaults still fill gaps", () => {
  const settings = loadLater().settings;
  assert.equal(settings.lorebookTokenBudget, 3000);
  assert.equal(settings.lorebookBudgetPercent, 30);
  assert.equal(settings.lorebookBudgetCap, 4000);
  assert.equal(settings.structuredOutput, true);
  assert.equal(settings.temperature, 0.7);
  assert.equal(settings.maxTokens, 12000);
  assert.equal(settings.playerName, "User");
});

test("the continuity judge's settings and scene images survive being loaded", () => {
  // `continuity` and `sceneImages` are world-level; the per-track cue and the
  // per-variable precise settings ride inside objects the load copies whole.
  store.getState().loadWorldFromData({
    id: "w1", name: "A rainy port", description: null,
    schema: {
      ...SCHEMA,
      sceneImages: [{ id: "img1", name: "The lantern", url: "https://example.test/a.png", scene: "when the lamps come on" }],
      audioTracks: [{ id: "t1", name: "Rain", type: "bgm", url: "https://example.test/a.mp3", aiNote: "when it rains" }],
      variables: [{ id: "v1", name: "Trust", type: "number", defaultValue: 0, precise: true, deltaDown: 3, deltaUp: 5 }],
      continuity: { bgm: true, images: true },
    } as unknown as Record<string, unknown>,
    thumbnailUrl: null,
  });
  const draft = store.getState().worldDraft;
  assert.deepEqual(draft.continuity, { bgm: true, images: true }, "continuity was dropped by the load transform");
  assert.equal(draft.sceneImages?.[0]?.scene, "when the lamps come on");
  assert.equal(draft.audioTracks?.[0]!.aiNote, "when it rains");
  assert.equal(draft.variables[0]!.precise, true);
  assert.equal(draft.variables[0]!.deltaUp, 5);
});

test("voice settings survive being loaded (the next save would delete them)", () => {
  const settings = load().settings;
  assert.equal(settings.narratorVoice, "alloy");
  assert.equal(settings.voiceInputMode, "auto");
});
