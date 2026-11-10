import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition } from "@yumina/engine";
import { worldDefinitionSchema } from "@yumina/engine";
import { executeApplyChanges, type SchemaChange } from "./tool-executor.js";
import { BACKGROUND_FALLBACK_MODEL, lookupCatalogModel, setModelCatalogForTests } from "./model-catalog.js";
import { STUDIO_TOOLS } from "./tools.js";

const CATALOG = [
  { id: "google/gemini-3.1-flash-lite", minPlan: "free" },
  { id: "deepseek/deepseek-chat-v3.1", minPlan: "free" },
  { id: "anthropic/claude-sonnet-4.5", minPlan: "plus" },
];

beforeEach(() => setModelCatalogForTests(CATALOG));
afterEach(() => setModelCatalogForTests(null));

function makeWorld(overrides?: Partial<WorldDefinition>): WorldDefinition {
  return {
    id: "w", version: "19.0.0", name: "W", description: "", author: "t",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 4000, temperature: 1.0, playerName: "User" },
    ...overrides,
  } as WorldDefinition;
}

const settings = (data: Record<string, unknown>, world = makeWorld()) =>
  executeApplyChanges(world, [{ action: "update", entityType: "settings", id: "settings", data } as SchemaChange]);
const station = (st: Record<string, unknown>, world = makeWorld()) =>
  executeApplyChanges(world, [{ action: "create", entityType: "worldbook", id: "wb-ai", data: { name: "AI", station: st } } as SchemaChange]);

// ── update_settings ──

test("update_settings clamps silly values into sane ranges and reports each one", () => {
  const r = settings({ maxTokens: 1, temperature: 2, topK: 1_000_000, topP: 0, minP: 0.9, frequencyPenalty: -2, lorebookScanDepth: 100000, lorebookBudgetPercent: 0 });
  assert.equal(r.success, true);
  const s = r.world.settings as unknown as Record<string, number>;
  assert.equal(s.maxTokens, 256);
  assert.equal(s.temperature, 1.5);
  assert.equal(s.topK, 200);
  assert.equal(s.topP, 0.05);
  assert.equal(s.minP, 0.5);
  assert.equal(s.frequencyPenalty, -1);
  assert.equal(s.lorebookScanDepth, 20);
  assert.equal(s.lorebookBudgetPercent, 5);
  const note = r.results[0]!.note ?? "";
  assert.match(note, /adjusted to the allowed range: .*maxTokens 1 → 256.*temperature 2 → 1\.5/);
  assert.match(note, /lorebookScanDepth 100000 → 20/);
  assert.match(note, /lorebookBudgetPercent 0 → 5/);
  assert.equal(r.success && worldDefinitionSchema.safeParse(r.world).success, true);
  // maxTokens upper bound too.
  assert.equal((settings({ maxTokens: 999_999 }).world.settings as { maxTokens: number }).maxTokens, 32768);
});

test("card sampling written while the card follows the player is saved but reported inactive", () => {
  const r = settings({ temperature: 0.7 });
  assert.equal(r.success, true);
  assert.match(r.results[0]!.note ?? "", /temperature saved but inactive.*samplingPolicy "author"/);

  const author = settings({ samplingPolicy: "author", temperature: 0.7 });
  assert.equal(author.world.settings.samplingPolicy, "author");
  assert.doesNotMatch(author.results[0]!.note ?? "", /inactive/);

  const back = settings({ samplingPolicy: "player" }, author.world);
  assert.equal("samplingPolicy" in back.world.settings, false);

  const bad = settings({ samplingPolicy: "always", temperature: 0.5 });
  assert.equal(bad.success, false);
  assert.match(bad.results[0]!.error ?? "", /samplingPolicy must be "player" or "author"/);
  assert.equal(bad.world.settings.temperature, 1.0, "nothing half-applied");
});

test("recommendedModel must be a catalog model; '' removes it", () => {
  const ok = settings({ recommendedModel: " anthropic/claude-sonnet-4.5 " });
  assert.equal(ok.success, true);
  assert.equal(ok.world.settings.recommendedModel, "anthropic/claude-sonnet-4.5");

  const typo = settings({ recommendedModel: "anthropic/claude-sonet-4.5" });
  assert.equal(typo.success, false);
  assert.match(typo.results[0]!.error ?? "", /not a model players can run.*Close matches: "anthropic\/claude-sonnet-4\.5"/);

  const cleared = settings({ recommendedModel: "" }, ok.world);
  assert.equal("recommendedModel" in cleared.world.settings, false);
});

test("a model cannot be written while the catalog is unavailable", () => {
  setModelCatalogForTests("unavailable");
  assert.equal(lookupCatalogModel("anthropic/claude-sonnet-4.5").kind, "unavailable");
  const r = settings({ recommendedModel: "anthropic/claude-sonnet-4.5" });
  assert.equal(r.success, false);
  assert.match(r.results[0]!.error ?? "", /could not be loaded/);
});

test("update_settings schema describes every numeric param and exposes the policy", () => {
  const tool = STUDIO_TOOLS.find((t) => t.function.name === "update_settings")!;
  const params = tool.function.parameters as { properties: Record<string, { type?: string; description?: string; enum?: string[] }> };
  for (const [key, p] of Object.entries(params.properties)) {
    if (p.type === "number") assert.ok(p.description && p.description.length > 10, `${key} has a description`);
  }
  assert.deepEqual(params.properties.samplingPolicy!.enum, ["player", "author"]);
  assert.ok(params.properties.recommendedModel);
  assert.match(tool.function.description, /follow the PLAYER by default/);
});

// ── write_worldbook station ──

test("station model must be a catalog model", () => {
  const r = station({ kind: "worker", task: "写三行", trigger: { on: "turns", every: 3 }, model: "gpt-9-ultra-max" });
  assert.equal(r.success, false);
  assert.match(r.results[0]!.error ?? "", /station\.model: "gpt-9-ultra-max" is not a model players can run/);
  assert.equal(r.world.worldbooks, undefined, "nothing written");

  const free = station({ kind: "worker", task: "写三行", trigger: { on: "turns", every: 3 }, model: "deepseek/deepseek-chat-v3.1" });
  assert.equal(free.success, true);
  assert.equal(free.world.worldbooks![0]!.station!.model, "deepseek/deepseek-chat-v3.1");
  assert.equal(free.results[0]!.note, undefined);
});

test("a paid station model says what free players run instead", () => {
  const worker = station({ kind: "worker", task: "写三行", trigger: { on: "turns", every: 3 }, model: "anthropic/claude-sonnet-4.5" });
  assert.equal(worker.success, true);
  assert.match(worker.results[0]!.note ?? "", new RegExp(`needs the Platinum plan: free players .* will run ${BACKGROUND_FALLBACK_MODEL.replace(/[./]/g, "\\$&")} instead`));

  const narrator = station({ kind: "narrator", model: "anthropic/claude-sonnet-4.5" });
  assert.equal(narrator.success, true);
  assert.match(narrator.results[0]!.note ?? "", /will run their own chosen model instead/);
});

test("station temperature and maxTokens: stored when valid, an error when not, never a silent drop", () => {
  const ok = station({ kind: "worker", trigger: { on: "ui" }, temperature: 0.3, maxTokens: 1200 });
  assert.equal(ok.success, true);
  const st = ok.world.worldbooks![0]!.station!;
  assert.equal(st.temperature, 0.3);
  assert.equal(st.maxTokens, 1200);
  assert.equal(worldDefinitionSchema.safeParse(ok.world).success, true);

  const hot = station({ kind: "worker", trigger: { on: "ui" }, temperature: 3 });
  assert.equal(hot.success, false);
  assert.match(hot.results[0]!.error ?? "", /station\.temperature must be a number from 0 to 1\.5 \(got 3\)/);

  const short = station({ kind: "worker", trigger: { on: "ui" }, maxTokens: 10 });
  assert.equal(short.success, false);
  assert.match(short.results[0]!.error ?? "", /station\.maxTokens must be a whole number from 50 to 4000 \(got 10\)/);

  const huge = station({ kind: "worker", trigger: { on: "ui" }, maxTokens: 100000 });
  assert.equal(huge.success, false);
});

test("a narrator ignores temperature/maxTokens with a note: it uses the player's settings", () => {
  const r = station({ kind: "narrator", temperature: 0.9, maxTokens: 2000 });
  assert.equal(r.success, true);
  const st = r.world.worldbooks![0]!.station!;
  assert.equal(st.temperature, undefined);
  assert.equal(st.maxTokens, undefined);
  assert.match(r.results[0]!.note ?? "", /station\.temperature ignored: a narrator answers the player with the player's own sampling settings/);
  assert.match(r.results[0]!.note ?? "", /station\.maxTokens ignored/);
});

test("a custom AI keeps its model and sampling: api.callAi runs with them", () => {
  const ok = station({ kind: "custom", name: "好感度裁判", model: "deepseek/deepseek-chat-v3.1", temperature: 0.2, maxTokens: 400 });
  assert.equal(ok.success, true);
  const st = ok.world.worldbooks![0]!.station!;
  assert.deepEqual([st.model, st.temperature, st.maxTokens], ["deepseek/deepseek-chat-v3.1", 0.2, 400]);
  assert.equal(worldDefinitionSchema.safeParse(ok.world).success, true);

  const bad = station({ kind: "custom", model: "gpt-9-ultra-max" });
  assert.equal(bad.success, false);
});

test("updating a station re-checks its settings", () => {
  const created = station({ kind: "worker", trigger: { on: "ui" } });
  const bad = executeApplyChanges(created.world, [{ action: "update", entityType: "worldbook", id: "wb-ai", data: { station: { kind: "worker", trigger: { on: "ui" }, temperature: -1 } } } as SchemaChange]);
  assert.equal(bad.success, false);
  assert.equal(bad.world.worldbooks![0]!.station!.temperature, undefined);
});

test("write_worldbook station schema offers temperature", () => {
  const tool = STUDIO_TOOLS.find((t) => t.function.name === "write_worldbook")!;
  const st = (tool.function.parameters as { properties: { station: { properties: Record<string, { description?: string }> } } }).properties.station;
  assert.ok(st.properties.temperature?.description?.includes("0–1.5"));
  assert.match(st.properties.model!.description ?? "", /catalog/);
});

test("the background fallback named in notes is the real default summary model", async () => {
  const { DEFAULT_STORY_SUMMARY_MODEL } = await import("../session-compaction.js");
  assert.equal(BACKGROUND_FALLBACK_MODEL, DEFAULT_STORY_SUMMARY_MODEL);
});
