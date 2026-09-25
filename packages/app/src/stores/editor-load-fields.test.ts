import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";

/**
 * Loading a world must not drop its fields. The save is a full-schema PATCH,
 * so anything the load forgets is deleted from the server on the next save —
 * silently, with no error.
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
  },
};

function load() {
  store.getState().loadWorldFromData({
    id: "w1", name: "A rainy port", description: null,
    schema: SCHEMA as unknown as Record<string, unknown>, thumbnailUrl: null,
  });
  return store.getState().worldDraft as unknown as Record<string, any>;
}

test("world-level fields outside the old field list survive being loaded", () => {
  const draft = load();
  assert.deepEqual(draft.customTagColors, { rain: "#123456" });
  assert.equal(draft.installedBundles?.[0]?.installId, "i1");
  assert.deepEqual(draft.systems, ["weather"]);
  assert.equal(draft.language, "zh");
  assert.deepEqual(draft.someFutureField, { kept: true }, "a field added later must ride through too");
});

test("settings outside the old field list survive, and defaults still fill gaps", () => {
  const settings = load().settings;
  assert.equal(settings.lorebookTokenBudget, 3000);
  assert.equal(settings.lorebookBudgetPercent, 30);
  assert.equal(settings.lorebookBudgetCap, 4000);
  assert.equal(settings.structuredOutput, true);
  assert.equal(settings.temperature, 0.7);
  assert.equal(settings.maxTokens, 12000);
  assert.equal(settings.playerName, "User");
});
