import test from "node:test";
import assert from "node:assert/strict";
import type { WorldDefinition, WorldEntry } from "@yumina/engine";
import { computeLorebookHealth, LOREBOOK_BUDGETS, type ResolvedContext } from "./context-resolver.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { executeApplyChanges } from "./tool-executor.js";

// ── Fixtures ──
// The moco 盗墓笔记 case: 28 always-send entries ≈ 37k tokens/turn, mega-entries
// with 24+ keywords, none of it ever surfaced to the agent. These tests pin the
// bloat-detection + slim-skill auto-load chain that fixes that blind spot.

function makeEntry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id,
    role: "custom",
    section: "system-presets",
    content: "",
    enabled: true,
    keywords: [],
    position: 0,
    alwaysSend: false,
    conditions: [],
    conditionLogic: "all",
    ...overrides,
  } as WorldEntry;
}

function makeWorld(entries: WorldEntry[]): WorldDefinition {
  return {
    id: "w1",
    name: "Test World",
    version: "2.0.0",
    entries,
    variables: [],
    rules: [],
    components: [],
    settings: {},
  } as unknown as WorldDefinition;
}

/** ~5,200 CJK chars ≈ 5,200 tokens under the resolver's CJK-aware estimator. */
const BIG_CJK = "墓".repeat(5_200);
const SMALL_CJK = "墓".repeat(200);

function bloatedWorld(): WorldDefinition {
  // 5 always-send entries ≈ 26k tokens (over the 20k budget) + one broad-keyword
  // mega entry (24 keywords ≈ pseudo-always, 5.2k > 5k pool budget).
  const always = Array.from({ length: 5 }, (_, i) =>
    makeEntry({ id: `always-${i}`, alwaysSend: true, content: BIG_CJK }),
  );
  const mega = makeEntry({
    id: "mega-cast",
    section: "chat-history",
    content: BIG_CJK,
    keywords: Array.from({ length: 24 }, (_, i) => `角色${i}`),
  });
  return makeWorld([...always, mega]);
}

function leanWorld(): WorldDefinition {
  return makeWorld([
    makeEntry({ id: "core", alwaysSend: true, content: SMALL_CJK }),
    makeEntry({ id: "loc", section: "chat-history", content: SMALL_CJK, keywords: ["古墓"] }),
  ]);
}

function resolved(world: WorldDefinition): ResolvedContext {
  return {
    inventory: "stub",
    preloadedEntities: "",
    tokenEstimate: 0,
    truncated: false,
    lorebookHealth: computeLorebookHealth(world),
  };
}

// ── computeLorebookHealth ──

test("computeLorebookHealth flags a bloated world with numbered reasons", () => {
  const health = computeLorebookHealth(bloatedWorld());
  assert.equal(health.overBudget, true);
  assert.equal(health.alwaysCount, 5);
  assert.ok(health.alwaysTokens > LOREBOOK_BUDGETS.alwaysSendTokens);
  assert.equal(health.pseudoAlwaysCount, 1);
  assert.ok(health.reasons.length >= 2);
  assert.ok(health.topEntries.length === 5);
  assert.ok(health.topEntries[0]!.tokens >= health.topEntries[1]!.tokens);
});

test("computeLorebookHealth passes a lean world", () => {
  const health = computeLorebookHealth(leanWorld());
  assert.equal(health.overBudget, false);
  assert.deepEqual(health.reasons, []);
});

test("computeLorebookHealth ignores greetings and disabled entries for the always-send load", () => {
  const world = makeWorld([
    makeEntry({ id: "greet", role: "greeting", alwaysSend: true, content: BIG_CJK }),
    makeEntry({ id: "off", alwaysSend: true, enabled: false, content: BIG_CJK }),
    makeEntry({ id: "core", alwaysSend: true, content: SMALL_CJK }),
  ]);
  const health = computeLorebookHealth(world);
  assert.equal(health.alwaysCount, 1);
  assert.ok(health.alwaysTokens < 1_000);
});

// ── buildSystemPrompt auto-load ──

test("buildSystemPrompt injects <lorebook-health> and the slim skill when over budget", () => {
  const parts = buildSystemPrompt(resolved(bloatedWorld()));
  assert.ok(parts.world.includes("<lorebook-health>"), "health block missing");
  assert.ok(parts.world.includes('<skill name="slim">'), "slim skill not auto-loaded");
  // The consent rule must ride along with the injection.
  assert.ok(/without (their|the creator's) explicit (approval|consent)/i.test(parts.world));
  // Live numbers present (top entry name).
  assert.ok(parts.world.includes("always-0"));
});

test("buildSystemPrompt stays silent for a healthy world (self-healing unload)", () => {
  const parts = buildSystemPrompt(resolved(leanWorld()));
  assert.ok(!parts.world.includes("<lorebook-health>"));
  assert.ok(!parts.world.includes('<skill name="slim">'));
});

// ── write-tool cost echo ──

test("executeApplyChanges echoes per-entry size and the always-send load", () => {
  const world = leanWorld();
  const result = executeApplyChanges(world, [
    {
      action: "create",
      entityType: "entry",
      id: "new-lore",
      data: { name: "新词条", section: "chat-history", content: SMALL_CJK, keywords: ["机关"] },
    },
  ]);
  assert.equal(result.success, true);
  assert.ok(/~[\d,]+ tok/.test(result.summary), "per-entry size missing");
  assert.ok(result.summary.includes("Lorebook load: always-send"), "load echo missing");
  assert.ok(!result.summary.includes("⚠"), "lean world should not warn");
});

test("executeApplyChanges warns when a write crosses the always-send budget", () => {
  const world = bloatedWorld();
  const result = executeApplyChanges(world, [
    {
      action: "create",
      entityType: "entry",
      id: "more-rules",
      data: { name: "又一条规则", section: "system-presets", content: SMALL_CJK },
    },
  ]);
  assert.equal(result.success, true);
  assert.ok(result.summary.includes("⚠"), "over-budget warning missing");
  assert.ok(/never delete without their approval/.test(result.summary));
});
