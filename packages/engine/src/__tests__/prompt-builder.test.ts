import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { estimateTokens, preloadTokenizer } from "../prompts/token-utils.js";
import type { ChatMessage, UserPrompt } from "../prompts/prompt-builder.js";
import type { WorldDefinition, WorldEntry, GameState, Variable } from "../types/index.js";
import {
  createMockWorld,
  createMockEntry,
  createMockVariable,
  createMockGameState,
  resetIdCounter,
} from "./test-utils.js";

// cl100k_base ranks load lazily — await them so budget-trimming assertions
// run against the exact encoder rather than the char heuristic fallback.
beforeAll(() => preloadTokenizer());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a PromptBuilder (stateless, so one per test suite is fine) */
function createBuilder(): PromptBuilder {
  return new PromptBuilder();
}

/** Create an always-send entry at a specific position with a given priority */
function alwaysSendEntry(
  position: WorldEntry["position"],
  content: string,
  priority = 0,
  overrides: Partial<WorldEntry> = {}
): WorldEntry {
  return createMockEntry({
    content,
    position,
    priority,
    alwaysSend: true,
    enabled: true,
    ...overrides,
  });
}

/** Create a user prompt with defaults */
function userPrompt(overrides: Partial<UserPrompt> = {}): UserPrompt {
  return {
    id: "up-1",
    name: "User Prompt",
    content: "User injected content.",
    position: "bottom",
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PromptBuilder", () => {
  let pb: PromptBuilder;

  beforeEach(() => {
    resetIdCounter();
    pb = createBuilder();
  });

  // =========================================================================
  // buildSystemPrompt — position slot ordering
  // =========================================================================

  describe("buildSystemPrompt — position slot ordering", () => {
    it("assembles entries in ascending numeric position order", () => {
      // Entries are sorted by their numeric `position` (lower = earlier),
      // regardless of insertion order.
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(5, "BOTTOM"),
          alwaysSendEntry(0, "TOP"),
          alwaysSendEntry(2, "CHARACTER"),
          alwaysSendEntry(1, "BEFORE_CHAR"),
          alwaysSendEntry(3, "AFTER_CHAR"),
          alwaysSendEntry(4, "PERSONA"),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);

      const topIdx = result.indexOf("TOP");
      const beforeCharIdx = result.indexOf("BEFORE_CHAR");
      const charIdx = result.indexOf("CHARACTER");
      const afterCharIdx = result.indexOf("AFTER_CHAR");
      const personaIdx = result.indexOf("PERSONA");
      const bottomIdx = result.indexOf("BOTTOM");

      expect(topIdx).toBeLessThan(beforeCharIdx);
      expect(beforeCharIdx).toBeLessThan(charIdx);
      expect(charIdx).toBeLessThan(afterCharIdx);
      expect(afterCharIdx).toBeLessThan(personaIdx);
      expect(personaIdx).toBeLessThan(bottomIdx);
    });

    it("omits positions with no entries", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "TOP_CONTENT"),
          alwaysSendEntry(5, "BOTTOM_CONTENT"),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);
      expect(result).toContain("TOP_CONTENT");
      expect(result).toContain("BOTTOM_CONTENT");
      // Should not contain placeholder text for empty slots
      expect(result).not.toContain("before_char");
      expect(result).not.toContain("after_char");
    });
  });

  // =========================================================================
  // buildSystemPrompt — priority sorting within slots
  // =========================================================================

  describe("buildSystemPrompt — position sorting", () => {
    it("sorts entries by ascending position", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(2, "LOW_PRIO"),
          alwaysSendEntry(0, "HIGH_PRIO"),
          alwaysSendEntry(1, "MED_PRIO"),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);

      const highIdx = result.indexOf("HIGH_PRIO");
      const medIdx = result.indexOf("MED_PRIO");
      const lowIdx = result.indexOf("LOW_PRIO");

      expect(highIdx).toBeLessThan(medIdx);
      expect(medIdx).toBeLessThan(lowIdx);
    });

    it("orders entries strictly by position across the whole prompt", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(1, "TOP_LOW"),
          alwaysSendEntry(0, "TOP_HIGH"),
          alwaysSendEntry(3, "BOT_LOW"),
          alwaysSendEntry(2, "BOT_HIGH"),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);

      // Lower position first
      expect(result.indexOf("TOP_HIGH")).toBeLessThan(result.indexOf("TOP_LOW"));
      expect(result.indexOf("BOT_HIGH")).toBeLessThan(result.indexOf("BOT_LOW"));
      // Earlier positions before later ones
      expect(result.indexOf("TOP_LOW")).toBeLessThan(result.indexOf("BOT_HIGH"));
    });
  });

  // =========================================================================
  // buildSystemPrompt — worldbook activation (OUTER gate, before alwaysSend)
  // =========================================================================

  describe("buildSystemPrompt — worldbook activation gating", () => {
    function genderWorld() {
      return createMockWorld({
        worldbooks: [
          { id: "wb-girl", name: "Girl", activation: { mode: "greeting", greetingIds: ["g1"] }, order: 0 },
          { id: "wb-boy", name: "Boy", activation: { mode: "greeting", greetingIds: ["g2"] }, order: 1 },
        ],
        entries: [
          // alwaysSend, but each belongs to a greeting-bound worldbook.
          alwaysSendEntry(0, "YOU_ARE_A_GIRL", 0, { worldbookId: "wb-girl" }),
          alwaysSendEntry(1, "YOU_ARE_A_BOY", 0, { worldbookId: "wb-boy" }),
          // No worldbookId → Core → always present.
          alwaysSendEntry(2, "CORE_RULE"),
        ],
      });
    }

    it("includes only the active greeting's worldbook (g1 → girl), never the other", () => {
      const state = createMockGameState({ activeGreetingId: "g1" });
      const result = pb.buildSystemPrompt(genderWorld(), state);
      expect(result).toContain("YOU_ARE_A_GIRL");
      expect(result).toContain("CORE_RULE");
      expect(result).not.toContain("YOU_ARE_A_BOY");
    });

    it("switches with the opening (g2 → boy), never the other", () => {
      const state = createMockGameState({ activeGreetingId: "g2" });
      const result = pb.buildSystemPrompt(genderWorld(), state);
      expect(result).toContain("YOU_ARE_A_BOY");
      expect(result).toContain("CORE_RULE");
      expect(result).not.toContain("YOU_ARE_A_GIRL");
    });

    it("drops both greeting-bound books when no opening is active (Core still sent)", () => {
      const state = createMockGameState();
      const result = pb.buildSystemPrompt(genderWorld(), state);
      expect(result).toContain("CORE_RULE");
      expect(result).not.toContain("YOU_ARE_A_GIRL");
      expect(result).not.toContain("YOU_ARE_A_BOY");
    });

    it("cards without worldbooks are unaffected (back-compat)", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "PLAIN_ALWAYS_SEND", 0, { worldbookId: "ghost-wb" })],
      });
      // No worldbooks array → filter is a no-op even though the entry names a book.
      const result = pb.buildSystemPrompt(world, createMockGameState());
      expect(result).toContain("PLAIN_ALWAYS_SEND");
    });
  });

  // =========================================================================
  // buildSystemPrompt — frontend lore-binding gating (OUTER gate, before alwaysSend)
  // Regression: an alwaysSend entry bound to a <LoreSlot>/<LoreButton> must NOT
  // reach the prompt until the player toggles its slot on. (The "AI reveals the
  // secret codex 暗号 before you click" bug.)
  // =========================================================================

  describe("buildSystemPrompt — frontend lore-binding gating", () => {
    function codexWorld() {
      return createMockWorld({
        loreUiBindings: [
          { slotId: "secret-codex", entryId: "secret-entry", conditions: [], conditionLogic: "all" },
        ],
        entries: [
          // alwaysSend, but bound to a frontend slot → gated by slot activity.
          alwaysSendEntry(0, "CODEX_SECRET_1234567", 0, { id: "secret-entry" }),
          // Unbound → always present.
          alwaysSendEntry(1, "CORE_RULE"),
        ],
      });
    }

    it("EXCLUDES the bound entry while its slot is OFF (the leak bug)", () => {
      const result = pb.buildSystemPrompt(codexWorld(), createMockGameState());
      expect(result).toContain("CORE_RULE");
      expect(result).not.toContain("CODEX_SECRET_1234567");
    });

    it("INCLUDES the bound entry once its slot is active (metadata.activeLoreSlots)", () => {
      const state = createMockGameState({ metadata: { activeLoreSlots: ["secret-codex"] } });
      const result = pb.buildSystemPrompt(codexWorld(), state);
      expect(result).toContain("CODEX_SECRET_1234567");
      expect(result).toContain("CORE_RULE");
    });

    it("INCLUDES the bound entry via the __lore_{slotId} variable (LoreButton's persisted flag)", () => {
      // No activeLoreSlots metadata — only the variable LoreButton/LoreSwitch write.
      // This is the race-free path: the flag travels with the message state.
      const state = createMockGameState({ variables: { "__lore_secret-codex": true } });
      const result = pb.buildSystemPrompt(codexWorld(), state);
      expect(result).toContain("CODEX_SECRET_1234567");
    });

    it("respects the binding's extra conditions even when the slot is active", () => {
      const world = createMockWorld({
        loreUiBindings: [
          { slotId: "vault", entryId: "vault-entry", conditions: [{ variableId: "trust", operator: "gte", value: 50 }], conditionLogic: "all" },
        ],
        entries: [alwaysSendEntry(0, "VAULT_CONTENTS", 0, { id: "vault-entry" })],
      });
      // Slot active but trust too low → still gated out.
      const low = createMockGameState({ metadata: { activeLoreSlots: ["vault"] }, variables: { trust: 10 } });
      expect(pb.buildSystemPrompt(world, low)).not.toContain("VAULT_CONTENTS");
      // Slot active AND trust high enough → injected.
      const high = createMockGameState({ metadata: { activeLoreSlots: ["vault"] }, variables: { trust: 60 } });
      expect(pb.buildSystemPrompt(world, high)).toContain("VAULT_CONTENTS");
    });

    it("cards without bindings are unaffected (back-compat)", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "PLAIN_SECRET")],
      });
      const result = pb.buildSystemPrompt(world, createMockGameState());
      expect(result).toContain("PLAIN_SECRET");
    });
  });

  // =========================================================================
  // buildSystemPrompt — disabled entries excluded
  // =========================================================================

  describe("buildSystemPrompt — disabled entries", () => {
    it("excludes disabled entries from the prompt", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("top", "ENABLED_ENTRY"),
          alwaysSendEntry("top", "DISABLED_ENTRY", 0, { enabled: false }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);
      expect(result).toContain("ENABLED_ENTRY");
      expect(result).not.toContain("DISABLED_ENTRY");
    });

    it("excludes non-alwaysSend entries unless they are in matchedEntries", () => {
      const matchedEntry = createMockEntry({
        content: "MATCHED_LORE",
        position: "before_char",
        alwaysSend: false,
        enabled: true,
      });
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("top", "ALWAYS_SEND"),
          createMockEntry({
            content: "NOT_ALWAYS_SEND",
            position: "top",
            alwaysSend: false,
            enabled: true,
          }),
          matchedEntry,
        ],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state, [matchedEntry]);
      expect(result).toContain("ALWAYS_SEND");
      expect(result).not.toContain("NOT_ALWAYS_SEND");
      expect(result).toContain("MATCHED_LORE");
    });
  });

  // =========================================================================
  // buildSystemPrompt — variable summary
  // =========================================================================

  describe("buildSystemPrompt — variable summary", () => {
    it("includes variable summary when variables exist", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
        createMockVariable({ id: "gold", name: "Gold", type: "number", defaultValue: 50 }),
      ];
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "World intro.")],
        variables: vars,
      });
      const state = createMockGameState({ fromVariables: vars });

      // The variable summary now lives in the dynamic <game-state> block,
      // rendered id: value (not the legacy "Current game state:" inline list).
      const result = pb.buildFormatBlock(world, state);
      expect(result).toContain("<game-state>");
      expect(result).toContain("hp: 100");
      expect(result).toContain("gold: 50");
    });

    it("uses current state value rather than default when different", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "Intro.")],
        variables: vars,
      });
      const state = createMockGameState({ variables: { hp: 42 } });

      const result = pb.buildFormatBlock(world, state);
      expect(result).toContain("hp: 42");
      expect(result).not.toContain("hp: 100");
    });

    it("falls back to defaultValue when state has no value for a variable", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "Intro.")],
        variables: vars,
      });
      const state = createMockGameState({ variables: {} });

      const result = pb.buildFormatBlock(world, state);
      expect(result).toContain("hp: 100");
    });

    it("omits variable summary when no variables exist", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "Intro.")],
        variables: [],
      });
      const state = createMockGameState();

      const result = pb.buildFormatBlock(world, state);
      expect(result).toBe("");
    });

    it("surfaces behaviorRules in the static format block", () => {
      const vars: Variable[] = [
        createMockVariable({
          id: "hp",
          name: "Health",
          type: "number",
          defaultValue: 100,
          behaviorRules: "Decrease in combat",
        }),
      ];
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "Intro.")],
        variables: vars,
      });

      const result = pb.buildStaticFormatBlock(world);
      expect(result).toContain("<behavior-rules>");
      expect(result).toContain("[hp | Health]");
      expect(result).toContain("Decrease in combat");
    });

    it("falls back to legacy updateHints when behaviorRules is absent", () => {
      const vars: Variable[] = [
        createMockVariable({
          id: "hp",
          name: "Health",
          type: "number",
          defaultValue: 100,
          updateHints: "Decrease in combat",
        }),
      ];
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "Intro.")],
        variables: vars,
      });

      const result = pb.buildStaticFormatBlock(world);
      expect(result).toContain("Decrease in combat");
    });
  });


  // =========================================================================
  // buildFormatBlock — dynamic game-state block + update reminder
  // =========================================================================

  describe("buildFormatBlock — dynamic game-state block", () => {
    it("wraps current values in <game-state> tags", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { hp: 42 } });

      const result = pb.buildFormatBlock(world, state);
      expect(result).toContain("<game-state>");
      expect(result).toContain("hp: 42");
      expect(result).toContain("</game-state>");
    });

    it("excludes internal (engine-managed) variables from the block", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
        createMockVariable({ id: "pickhist", name: "轮换 · 最近登场", type: "json", defaultValue: [], internal: true }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { hp: 42, pickhist: ["霜月", "锦织"] } });

      const result = pb.buildFormatBlock(world, state);
      expect(result).toContain("hp: 42");
      // The cooldown-history array must never leak into the prompt.
      expect(result).not.toContain("pickhist");
      expect(result).not.toContain("霜月");
      expect(result).not.toContain("最近登场");
    });

    it("excludes aiAccess:'none' variables from the block", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
        createMockVariable({ id: "账本", name: "账本", type: "json", defaultValue: {}, aiAccess: "none" }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { hp: 42, 账本: { 金币: 5 } } });

      const result = pb.buildFormatBlock(world, state);
      expect(result).toContain("hp: 42");
      expect(result).not.toContain("账本");
      expect(result).not.toContain("金币");
    });

    it("excludes inactive variables (gate off / conditions failing) from the block", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
        createMockVariable({ id: "loot", name: "Loot", type: "number", defaultValue: 0, enabled: false }),
        createMockVariable({
          id: "直播积分",
          name: "直播积分",
          type: "number",
          defaultValue: 0,
          activation: {
            mode: "conditions",
            conditions: [{ variableId: "hp", operator: "lt", value: 10 }],
            conditionLogic: "all",
          },
        }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { hp: 42, loot: 3, 直播积分: 7 } });

      const result = pb.buildFormatBlock(world, state);
      expect(result).toContain("hp: 42");
      expect(result).not.toContain("loot");
      expect(result).not.toContain("直播积分");
    });

    it("marks aiAccess:'read' variables as read-only in the block", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "阶段", name: "阶段", type: "string", defaultValue: "观察", aiAccess: "read" }),
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { 阶段: "观察", hp: 42 } });

      const result = pb.buildFormatBlock(world, state);
      expect(result).toMatch(/阶段: "?观察"? \(read-only\)/);
      expect(result).toContain("hp: 42");
      expect(result).not.toContain("hp: 42 (read-only)");
    });

    it("shows the json dot-path nudge only when an AI-visible json variable exists", () => {
      // The only json var is engine-only — the nudge would be pure noise.
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
        createMockVariable({ id: "账本", name: "账本", type: "json", defaultValue: {}, aiAccess: "none" }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { hp: 42, 账本: {} } });

      const result = pb.buildFormatBlock(world, state);
      expect(result).not.toMatch(/dot-path/i);
    });

    it("appends a per-turn reminder, wrapped in an echo-suppressed tag", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { hp: 42 } });

      const result = pb.buildFormatBlock(world, state);
      // The call-to-action lives AFTER the closing tag, nearest the generation point.
      const reminder = result.slice(result.indexOf("</game-state>"));
      expect(reminder).toContain("<state-reminder>");
      expect(reminder).toContain("</state-reminder>");
      expect(reminder).toMatch(/changed this turn/i);
      expect(reminder).toMatch(/only those/i);
    });

    it("SAFETY: the reminder contains no parseable [..] directive literal", () => {
      // A literal bracket example here could be echoed back by the model and then
      // re-parsed as a real directive (dot-path examples even bypass the unknown-var
      // guard and corrupt state). The reminder must stay prose-only.
      const vars: Variable[] = [
        createMockVariable({ id: "npcs", name: "NPCs", type: "json", defaultValue: {} }),
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { npcs: { aria: { mood: "calm" } }, hp: 42 } });

      const result = pb.buildFormatBlock(world, state);
      const reminder = result.slice(result.indexOf("</game-state>"));
      expect(reminder).not.toContain("[");
      expect(reminder).not.toContain("]");
    });

    it("strips inline base64 images from a json variable but keeps its keys", () => {
      // Regression: a customUI portrait-upload feature stored a 2 MB base64 data
      // URI into a declared json variable via api.setVariable. Because every
      // declared variable is echoed into <game-state>, that single image blew the
      // prompt past the model's context window and every send 400'd. The image
      // must be dropped from the prompt while the variable's keys stay visible.
      const bigDataUri =
        "data:image/jpeg;base64," + "A".repeat(2_000_000);
      const vars: Variable[] = [
        createMockVariable({ id: "portraits", name: "Portraits", type: "json", defaultValue: {} }),
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({
        variables: { portraits: { "师傅|普通": bigDataUri }, hp: 42 },
      });

      const result = pb.buildFormatBlock(world, state);
      // The 2 MB payload must NOT be in the prompt.
      expect(result).not.toContain("AAAAAAAA");
      expect(result.length).toBeLessThan(5_000);
      // The key is preserved so the AI still knows the pose exists.
      expect(result).toContain("师傅|普通");
      expect(result).toContain("[image omitted]");
      // Untouched variables render normally.
      expect(result).toContain("hp: 42");
      // CRITICAL: the source state is never mutated (on-screen portraits still work).
      expect((state.variables.portraits as Record<string, string>)["师傅|普通"]).toBe(bigDataUri);
    });

    it("replaces an over-long raw string value with a short placeholder", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "blob", name: "Blob", type: "string", defaultValue: "" }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { blob: "x".repeat(100_000) } });

      const result = pb.buildFormatBlock(world, state);
      expect(result).not.toContain("xxxxxxxxxx");
      expect(result).toMatch(/omitted \d+ chars/);
    });

    it("returns an empty string (no reminder) when the world has no variables", () => {
      const world = createMockWorld({ variables: [] });
      const state = createMockGameState();

      const result = pb.buildFormatBlock(world, state);
      expect(result).toBe("");
    });

    it("adds a dot-path nudge only when the world has a json variable", () => {
      const jsonVars: Variable[] = [
        createMockVariable({ id: "npcs", name: "NPCs", type: "json", defaultValue: {} }),
      ];
      const jsonWorld = createMockWorld({ variables: jsonVars });
      const jsonResult = pb.buildFormatBlock(jsonWorld, createMockGameState({ variables: { npcs: {} } }));
      expect(jsonResult).toMatch(/JSON variables/i);
      expect(jsonResult).toContain("dot-path");

      const scalarVars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const scalarWorld = createMockWorld({ variables: scalarVars });
      const scalarResult = pb.buildFormatBlock(scalarWorld, createMockGameState({ variables: { hp: 100 } }));
      expect(scalarResult).not.toMatch(/JSON variables/i);
      expect(scalarResult).not.toContain("dot-path");
    });
  });


  // =========================================================================
  // buildFormatBlock — last-turn changes block
  // =========================================================================

  describe("buildFormatBlock — last-turn changes", () => {
    const changeVars = (): Variable[] => [
      createMockVariable({ id: "时间段", name: "时间段", type: "number", defaultValue: 1 }),
      createMockVariable({ id: "日期", name: "日期", type: "number", defaultValue: 1 }),
      createMockVariable({ id: "pickhist", name: "轮换 · 最近登场", type: "json", defaultValue: [], internal: true }),
    ];

    it("omits the block entirely when no changes are passed (back-compat)", () => {
      const world = createMockWorld({ variables: changeVars() });
      const state = createMockGameState({ variables: { 时间段: 4, 日期: 2 } });

      for (const result of [
        pb.buildFormatBlock(world, state),
        pb.buildFormatBlock(world, state, []),
      ]) {
        expect(result).not.toContain("last-turn-changes");
        expect(result).not.toContain("re-apply");
      }
    });

    it("renders `id: old → new` lines and a do-not-re-apply clause", () => {
      const world = createMockWorld({ variables: changeVars() });
      const state = createMockGameState({ variables: { 时间段: 4, 日期: 2 } });

      const result = pb.buildFormatBlock(world, state, [
        { variableId: "时间段", oldValue: 3, newValue: 4 },
      ]);
      expect(result).toContain("<last-turn-changes>");
      expect(result).toContain("时间段: 3 → 4");
      expect(result).toContain("</last-turn-changes>");
      expect(result).toMatch(/do not re-apply/i);
      // Block order: values, then changes, then the reminder.
      expect(result.indexOf("<last-turn-changes>")).toBeGreaterThan(result.indexOf("</game-state>"));
      expect(result.indexOf("<state-reminder>")).toBeGreaterThan(result.indexOf("</last-turn-changes>"));
    });

    it("collapses multiple writes to the same variable into first-old → last-new", () => {
      const world = createMockWorld({ variables: changeVars() });
      const state = createMockGameState({ variables: { 时间段: 1 } });

      // Directive bumped 5→6, then a threshold behavior reset 6→1 in the same turn.
      const result = pb.buildFormatBlock(world, state, [
        { variableId: "时间段", oldValue: 5, newValue: 6 },
        { variableId: "时间段", oldValue: 6, newValue: 1 },
      ]);
      expect(result).toContain("时间段: 5 → 1");
      expect(result).not.toContain("5 → 6");
    });

    it("hides internal variables, unknown ids, and no-op changes", () => {
      const world = createMockWorld({ variables: changeVars() });
      const state = createMockGameState({ variables: { 时间段: 4 } });

      const result = pb.buildFormatBlock(world, state, [
        { variableId: "pickhist", oldValue: [], newValue: ["霜月"] }, // internal
        { variableId: "ghost", oldValue: 0, newValue: 1 },            // not declared
        { variableId: "日期", oldValue: 2, newValue: 2 },              // no-op
      ]);
      expect(result).not.toContain("last-turn-changes");
      expect(result).not.toContain("霜月");
      expect(result).not.toContain("ghost");
    });

    it("hides changes to non-AI-visible variables (aiAccess none / inactive)", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "阶段", name: "阶段", type: "string", defaultValue: "观察", aiAccess: "read" }),
        createMockVariable({ id: "账本", name: "账本", type: "number", defaultValue: 0, aiAccess: "none" }),
        createMockVariable({ id: "loot", name: "Loot", type: "number", defaultValue: 0, enabled: false }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { 阶段: "直播", 账本: 5, loot: 2 } });

      const result = pb.buildFormatBlock(world, state, [
        { variableId: "阶段", oldValue: "观察", newValue: "直播" }, // read-only but visible → keep
        { variableId: "账本", oldValue: 0, newValue: 5 },           // engine-only → hide
        { variableId: "loot", oldValue: 0, newValue: 2 },           // inactive → hide
      ]);
      expect(result).toContain("阶段: 观察 → 直播");
      expect(result).not.toContain("账本");
      expect(result).not.toContain("loot");
    });

    it("maps dot-path change ids to their root variable", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "npcs", name: "NPCs", type: "json", defaultValue: {} }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({ variables: { npcs: { aria: { mood: "angry" } } } });

      const result = pb.buildFormatBlock(world, state, [
        { variableId: "npcs.aria.mood", oldValue: { aria: { mood: "calm" } }, newValue: { aria: { mood: "angry" } } },
      ]);
      expect(result).toContain("<last-turn-changes>");
      expect(result).toContain("npcs:");
      expect(result).toContain("angry");
    });

    it("caps the block: long values truncated, line count bounded", () => {
      const manyVars: Variable[] = Array.from({ length: 20 }, (_, i) =>
        createMockVariable({ id: `v${i}`, name: `V${i}`, type: "number", defaultValue: 0 })
      );
      manyVars.push(createMockVariable({ id: "blob", name: "Blob", type: "string", defaultValue: "" }));
      const world = createMockWorld({ variables: manyVars });
      const state = createMockGameState({ variables: { blob: "y".repeat(5_000) } });

      const changes: Array<{ variableId: string; oldValue?: unknown; newValue?: unknown }> =
        Array.from({ length: 20 }, (_, i) => ({
          variableId: `v${i}`, oldValue: i, newValue: i + 1,
        }));
      changes.push({ variableId: "blob", oldValue: "", newValue: "y".repeat(5_000) });

      const result = pb.buildFormatBlock(world, state, changes);
      const block = result.slice(result.indexOf("<last-turn-changes>"), result.indexOf("</last-turn-changes>"));
      expect(block).toMatch(/\(\+\d+ more\)/);
      expect(block.split("\n").length).toBeLessThanOrEqual(15);
      expect(block).not.toContain("y".repeat(200));
    });
  });


  // =========================================================================
  // buildSystemPrompt — user prompt injection
  // =========================================================================

  describe("buildSystemPrompt — user prompt injection", () => {
    it("injects user prompts at the specified position slots", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("top", "WORLD_TOP"),
          alwaysSendEntry("bottom", "WORLD_BOTTOM"),
        ],
      });
      const state = createMockGameState();
      const prompts: UserPrompt[] = [
        userPrompt({ id: "u1", content: "USER_TOP_INJECT", position: "top" }),
        userPrompt({ id: "u2", content: "USER_BOTTOM_INJECT", position: "bottom" }),
      ];

      const result = pb.buildSystemPrompt(world, state, [], prompts);

      expect(result).toContain("USER_TOP_INJECT");
      expect(result).toContain("USER_BOTTOM_INJECT");
    });

    it("sorts user prompts after world entries at the same position (lower effective priority)", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("top", "WORLD_ENTRY", 100),
        ],
      });
      const state = createMockGameState();
      const prompts: UserPrompt[] = [
        userPrompt({ id: "u1", content: "USER_ENTRY", position: "top", priority: 100 }),
      ];

      const result = pb.buildSystemPrompt(world, state, [], prompts);

      // World entry should come first because user prompt priority is offset by -1000
      const worldIdx = result.indexOf("WORLD_ENTRY");
      const userIdx = result.indexOf("USER_ENTRY");
      expect(worldIdx).toBeLessThan(userIdx);
    });

    it("excludes disabled user prompts", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "TOP")],
      });
      const state = createMockGameState();
      const prompts: UserPrompt[] = [
        userPrompt({ id: "u1", content: "DISABLED_PROMPT", enabled: false }),
      ];

      const result = pb.buildSystemPrompt(world, state, [], prompts);
      expect(result).not.toContain("DISABLED_PROMPT");
    });

    it("excludes user prompts with empty content", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "TOP")],
      });
      const state = createMockGameState();
      const prompts: UserPrompt[] = [
        userPrompt({ id: "u1", content: "   ", position: "top" }),
      ];

      const result = pb.buildSystemPrompt(world, state, [], prompts);
      // Should only have the world entry, directives, etc. but not the empty user prompt as its own segment
      const parts = result.split("\n\n");
      const emptyUserParts = parts.filter((p) => p.trim() === "");
      // No extra empty parts injected
      expect(emptyUserParts.length).toBe(0);
    });

    it("injects a user prompt at its numeric position between two entries", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "TOP_ENTRY"),
          alwaysSendEntry(2, "CHAR_ENTRY"),
        ],
      });
      const state = createMockGameState();
      const prompts: UserPrompt[] = [
        userPrompt({ id: "u1", content: "BEFORE_CHAR_USER", position: 1 }),
      ];

      const result = pb.buildSystemPrompt(world, state, [], prompts);
      const topIdx = result.indexOf("TOP_ENTRY");
      const beforeCharUserIdx = result.indexOf("BEFORE_CHAR_USER");
      const charIdx = result.indexOf("CHAR_ENTRY");

      expect(topIdx).toBeLessThan(beforeCharUserIdx);
      expect(beforeCharUserIdx).toBeLessThan(charIdx);
    });
  });

  // =========================================================================
  // buildSystemPrompt — regex mode directives
  // =========================================================================

  describe("buildSystemPrompt — format directives", () => {
    it("includes regex directive instructions", () => {
      // Directive-format reference now lives in the cached static format block.
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "Intro.")],
        variables: [
          createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
        ],
      });

      const result = pb.buildStaticFormatBlock(world);
      expect(result).toContain("[variableId: operation value]");
      expect(result).toContain("[hp: -10]");
    });

    it("does not include JSON format instructions", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "Intro.")],
        variables: [
          createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
        ],
      });

      const result = pb.buildStaticFormatBlock(world);
      expect(result).not.toContain("You MUST respond with a JSON object");
    });

    it("omits the directive-format block when no variable is AI-writable", () => {
      // A card whose variables are all engine-owned has nothing the AI may
      // write — teaching directive syntax would be pure noise (and an invite
      // to write anyway).
      const world = createMockWorld({
        variables: [
          createMockVariable({ id: "阶段", name: "阶段", type: "string", defaultValue: "观察", aiAccess: "read" }),
          createMockVariable({ id: "账本", name: "账本", type: "json", defaultValue: {}, aiAccess: "none" }),
        ],
      });

      const result = pb.buildStaticFormatBlock(world);
      expect(result).not.toContain("<directive-format>");
    });

    it("excludes aiAccess:'none' variables from the behavior-rules section but keeps 'read' ones", () => {
      const world = createMockWorld({
        variables: [
          createMockVariable({ id: "阶段", name: "阶段", type: "string", defaultValue: "观察", aiAccess: "read", behaviorRules: "阶段推进由系统决定" }),
          createMockVariable({ id: "账本", name: "账本", type: "json", defaultValue: {}, aiAccess: "none", behaviorRules: "内部记账说明" }),
          createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100, behaviorRules: "受伤时扣减" }),
        ],
      });

      const result = pb.buildStaticFormatBlock(world);
      expect(result).toContain("阶段推进由系统决定");
      expect(result).toContain("受伤时扣减");
      expect(result).not.toContain("内部记账说明");
    });

    it("dot-path json examples appear only when an AI-visible json variable exists", () => {
      const world = createMockWorld({
        variables: [
          createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
          createMockVariable({ id: "账本", name: "账本", type: "json", defaultValue: {}, aiAccess: "none" }),
        ],
      });

      const result = pb.buildStaticFormatBlock(world);
      expect(result).toContain("<directive-format>");
      expect(result).not.toContain("dot-path");
    });
  });

  // =========================================================================
  // buildSystemPrompt — audio track instructions
  // =========================================================================

  describe("buildSystemPrompt — audio track instructions", () => {
    it("includes audio track list and regex trigger format", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "Intro.")],
        audioTracks: [
          { id: "battle_bgm", name: "Battle Theme", type: "bgm", url: "http://example.com/battle.mp3" },
          { id: "tavern_ambient", name: "Tavern Ambience", type: "ambient", url: "http://example.com/tavern.mp3" },
        ],
      });
      // Audio track reference now lives in the cached static format block.
      const result = pb.buildStaticFormatBlock(world);
      expect(result).toContain("Available audio tracks:");
      expect(result).toContain("battle_bgm (bgm): Battle Theme");
      expect(result).toContain("tavern_ambient (ambient): Tavern Ambience");
      expect(result).toContain("[audio: battle_bgm play]");
      expect(result).toContain("[audio: tavern_ambient stop]");
    });

    it("omits audio instructions when no audio tracks exist", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "Intro.")],
        audioTracks: [],
      });

      const result = pb.buildStaticFormatBlock(world);
      expect(result).not.toContain("Available audio tracks:");
      expect(result).not.toContain("[audio:");
    });
  });

  // =========================================================================
  // buildSystemPrompt — macro interpolation
  // =========================================================================

  describe("buildSystemPrompt — macro interpolation", () => {
    it("expands {{char}} and {{user}} macros in entry content", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("character", "The character is {{char}}.", 0, {
            role: "character",
            name: "Aria",
          }),
          alwaysSendEntry("top", "The player is {{user}}."),
        ],
        settings: { maxTokens: 4000, temperature: 1.0, playerName: "Hero" },
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);
      expect(result).toContain("The character is Aria.");
      expect(result).toContain("The player is Hero.");
    });

    it("expands variable macros in entry content", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("top", "You have {{gold}} gold pieces."),
        ],
        variables: [
          createMockVariable({ id: "gold", name: "Gold", defaultValue: 100 }),
        ],
      });
      const state = createMockGameState({ variables: { gold: 250 } });

      const result = pb.buildSystemPrompt(world, state);
      expect(result).toContain("You have 250 gold pieces.");
    });
  });

  // =========================================================================
  // buildGreeting
  // =========================================================================

  describe("buildGreeting", () => {
    it("returns interpolated greeting entry content", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            content: "Welcome, {{user}}! I am {{char}}.",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: true,
            name: "Aria",
          }),
          alwaysSendEntry("character", "Main character.", 0, {
            role: "character",
            name: "Aria",
          }),
        ],
        settings: { maxTokens: 4000, temperature: 1.0, playerName: "Hero" },
      });
      const state = createMockGameState();

      const result = pb.buildGreeting(world, state);
      expect(result).toBe("Welcome, Hero! I am Aria.");
    });

    it("returns empty string when no greeting entry exists", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "No greeting here.")],
      });
      const state = createMockGameState();

      const result = pb.buildGreeting(world, state);
      expect(result).toBe("");
    });

    it("returns empty string when greeting entry is disabled", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            content: "Hello!",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: false,
          }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildGreeting(world, state);
      expect(result).toBe("");
    });

    it("uses the first enabled greeting entry if multiple exist", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            content: "First greeting.",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: true,
          }),
          createMockEntry({
            content: "Second greeting.",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: true,
          }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildGreeting(world, state);
      expect(result).toBe("First greeting.");
    });
  });

  // =========================================================================
  // buildGreetings (plural)
  // =========================================================================

  describe("buildGreetings", () => {
    it("returns all enabled greetings sorted by position", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            content: "Second greeting.",
            role: "greeting",
            position: 1,
            alwaysSend: true,
            enabled: true,
          }),
          createMockEntry({
            content: "First greeting.",
            role: "greeting",
            position: 0,
            alwaysSend: true,
            enabled: true,
          }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildGreetings(world, state);
      expect(result).toEqual(["First greeting.", "Second greeting."]);
    });

    it("returns empty array when no greeting entries exist", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "No greeting here.")],
      });
      const state = createMockGameState();

      const result = pb.buildGreetings(world, state);
      expect(result).toEqual([]);
    });

    it("skips disabled greeting entries", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            content: "Enabled greeting.",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: true,
            order: 0,
          }),
          createMockEntry({
            content: "Disabled greeting.",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: false,
            order: 1,
          }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildGreetings(world, state);
      expect(result).toEqual(["Enabled greeting."]);
    });

    it("interpolates macros in all greetings", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            content: "Hello, {{user}}!",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: true,
            order: 0,
          }),
          createMockEntry({
            content: "I am {{char}}.",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: true,
            order: 1,
            name: "Aria",
          }),
          alwaysSendEntry("character", "Main character.", 0, {
            role: "character",
            name: "Aria",
          }),
        ],
        settings: { maxTokens: 4000, temperature: 1.0, playerName: "Hero" },
      });
      const state = createMockGameState();

      const result = pb.buildGreetings(world, state);
      expect(result).toEqual(["Hello, Hero!", "I am Aria."]);
    });

    it("returns single greeting in array when only one exists", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            content: "Welcome!",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: true,
          }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildGreetings(world, state);
      expect(result).toEqual(["Welcome!"]);
    });
  });

  // =========================================================================
  // buildDepthEntries
  // =========================================================================

  describe("buildDepthEntries", () => {
    it("returns depth entries with their depth values", () => {
      // Depth entries are section "chat-history" entries that carry a depth value.
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "Depth entry at 2.", 0, { section: "chat-history", depth: 2 }),
          alwaysSendEntry(1, "Depth entry at 4.", 0, { section: "chat-history", depth: 4 }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildDepthEntries(world, state);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ content: "Depth entry at 2.", depth: 2, apiRole: "system" });
      expect(result[1]).toEqual({ content: "Depth entry at 4.", depth: 4, apiRole: "system" });
    });

    it("sorts depth entries by ascending position", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(1, "LOW_PRIO_DEPTH", 0, { section: "chat-history", depth: 2 }),
          alwaysSendEntry(0, "HIGH_PRIO_DEPTH", 0, { section: "chat-history", depth: 4 }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildDepthEntries(world, state);
      expect(result[0]!.content).toBe("HIGH_PRIO_DEPTH");
      expect(result[1]!.content).toBe("LOW_PRIO_DEPTH");
    });

    it("excludes chat-history entries without a depth value", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "Has depth.", 0, { section: "chat-history", depth: 3 }),
          alwaysSendEntry(1, "No depth value.", 0, { section: "chat-history" }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildDepthEntries(world, state);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("Has depth.");
    });

    it("returns empty array when no depth entries exist", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "Only top content.")],
      });
      const state = createMockGameState();

      const result = pb.buildDepthEntries(world, state);
      expect(result).toEqual([]);
    });

    it("interpolates macros in depth entry content", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "Remember, {{user}}, stay focused.", 0, { section: "chat-history", depth: 1 }),
          alwaysSendEntry(1, "Main char.", 0, { role: "character", name: "Guide" }),
        ],
        settings: { maxTokens: 4000, temperature: 1.0, playerName: "Adventurer" },
      });
      const state = createMockGameState();

      const result = pb.buildDepthEntries(world, state);
      expect(result[0]!.content).toBe("Remember, Adventurer, stay focused.");
    });

    it("includes matched depth entries alongside alwaysSend", () => {
      const matchedDepth = createMockEntry({
        content: "Matched depth lore.",
        position: 1,
        section: "chat-history",
        depth: 3,
        alwaysSend: false,
        enabled: true,
      });
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "Always-send depth.", 0, { section: "chat-history", depth: 2 }),
          matchedDepth,
        ],
      });
      const state = createMockGameState();

      const result = pb.buildDepthEntries(world, state, [matchedDepth]);
      expect(result).toHaveLength(2);
    });
  });

  // =========================================================================
  // buildPostHistoryEntries
  // =========================================================================

  describe("buildPostHistoryEntries", () => {
    it("returns post-history entries sorted by ascending position", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(1, "LOW_PRIO_PH", 0, { section: "post-history" }),
          alwaysSendEntry(0, "HIGH_PRIO_PH", 0, { section: "post-history" }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildPostHistoryEntries(world, state);
      expect(result).toHaveLength(2);
      expect(result[0]!.content).toBe("HIGH_PRIO_PH");
      expect(result[1]!.content).toBe("LOW_PRIO_PH");
    });

    it("returns empty array when no post_history entries exist", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, "Top content.")],
      });
      const state = createMockGameState();

      const result = pb.buildPostHistoryEntries(world, state);
      expect(result).toEqual([]);
    });

    it("interpolates macros in post_history content", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "Stay in character as {{char}}.", 0, { section: "post-history", role: "custom" }),
          alwaysSendEntry(1, "The hero.", 0, { role: "character", name: "Luna" }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildPostHistoryEntries(world, state);
      expect(result[0]!.content).toBe("Stay in character as Luna.");
    });

    it("includes user prompts with post_history section", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "WORLD_PH", 0, { section: "post-history" }),
        ],
      });
      const state = createMockGameState();
      const prompts: UserPrompt[] = [
        userPrompt({ id: "u1", content: "USER_PH", position: 1, section: "post-history" }),
      ];

      const result = pb.buildPostHistoryEntries(world, state, [], prompts);
      expect(result).toHaveLength(2);
      expect(result[0]!.content).toBe("WORLD_PH");
      expect(result[1]!.content).toBe("USER_PH");
    });

    it("excludes post_history entries from system prompt", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "TOP"),
          alwaysSendEntry(1, "POST_HISTORY", 0, { section: "post-history" }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);
      expect(result).toContain("TOP");
      // post-history entries are delivered separately, not in the system prompt
      expect(result).not.toContain("POST_HISTORY");
    });
  });

  // =========================================================================
  // buildMessageHistory
  // =========================================================================

  describe("buildMessageHistory", () => {
    it("async trimming preserves pinned blocks, chronological order and the newest oversized turn", async () => {
      const prefix: ChatMessage = { role: "system", content: "Rules" };
      const old: ChatMessage = { role: "user", content: "Earlier" };
      const newest: ChatMessage = { role: "assistant", content: "戴夫回来了。".repeat(100) };
      const suffix: ChatMessage = { role: "system", content: "Format" };
      const all = [prefix, old, newest, suffix];
      const yieldControl = async () => {};
      expect(await pb.buildMessageHistoryAsync(all, yieldControl, 20, 1, 1)).toEqual([prefix, newest, suffix]);
      expect(await pb.buildMessageHistoryAsync(all, yieldControl, 1, 1, 1)).toEqual([prefix, suffix]);
      expect(await pb.buildMessageHistoryAsync(all, yieldControl)).toEqual(all);
      expect(await pb.buildMessageHistoryAsync([], yieldControl, 20)).toEqual([]);
      for (const model of ["openrouter/free", "google/gemini-2.5-flash"]) {
        expect(await pb.buildMessageHistoryAsync(all, yieldControl, 1000, 1, 1, model))
          .toEqual(pb.buildMessageHistory(all, 1000, 1, 1, model));
      }
    });

    const messages: ChatMessage[] = [
      { role: "user", content: "Hello world" },           // 11 chars
      { role: "assistant", content: "Hi there!" },         // 9 chars
      { role: "user", content: "How are you?" },           // 12 chars
      { role: "assistant", content: "I am fine, thanks!" }, // 18 chars
      { role: "user", content: "Great!" },                 // 6 chars
    ];

    it("returns all messages when no token limit is set", () => {
      const result = pb.buildMessageHistory(messages);
      expect(result).toHaveLength(5);
      expect(result).toEqual(messages);
    });

    it("returns a copy, not the original array", () => {
      const result = pb.buildMessageHistory(messages);
      expect(result).not.toBe(messages);
    });

    it("returns empty array for empty input", () => {
      const result = pb.buildMessageHistory([]);
      expect(result).toEqual([]);
    });

    it("returns empty array for empty input even with token limit", () => {
      const result = pb.buildMessageHistory([], 100);
      expect(result).toEqual([]);
    });

    it("keeps most recent messages when token limit is exceeded", () => {
      // Real tiktoken counts: "Great!"=2, "I am fine, thanks!"=6, "How are you?"=4.
      // budget 10, working backwards: 2 + 6 = 8 ≤ 10; + 4 = 12 > 10 → stop.
      const result = pb.buildMessageHistory(messages, 10);
      expect(result).toHaveLength(2);
      expect(result[0]!.content).toBe("I am fine, thanks!");
      expect(result[1]!.content).toBe("Great!");
    });

    it("always includes at least the most recent message even if it exceeds limit", () => {
      // maxTokens = 1 → charLimit = 4
      // Most recent message is "Great!" (6 chars) which exceeds 4
      // But it should still be included because result.length === 0
      const result = pb.buildMessageHistory(messages, 1);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("Great!");
    });

    it("returns all messages when token limit is very large", () => {
      const result = pb.buildMessageHistory(messages, 100000);
      expect(result).toHaveLength(5);
    });

    it("trims from the oldest messages, preserving newest", () => {
      // 2 tokens → 8 chars
      // "Great!" (6) fits. "I am fine, thanks!" (18) → 24 > 8 and result.length > 0 → stop
      const result = pb.buildMessageHistory(messages, 2);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("Great!");
    });
  });

  // =========================================================================
  // buildPromptCostBreakdown
  // =========================================================================

  describe("buildPromptCostBreakdown", () => {
    it("returns blocks for always-send entries grouped by position", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("top", "Top content here.", 10, { name: "Main Prompt" }),
          alwaysSendEntry("character", "Character description.", 5, { name: "Protagonist" }),
        ],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const entryBlocks = breakdown.blocks.filter((b) => b.category === "entry");
      expect(entryBlocks).toHaveLength(2);
      expect(entryBlocks[0]!.label).toBe("Main Prompt");
      expect(entryBlocks[1]!.label).toBe("Protagonist");
    });

    it("includes format instructions block in regex mode", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "Intro.")],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state, false);
      const formatBlocks = breakdown.blocks.filter((b) => b.category === "format-instructions");
      expect(formatBlocks.length).toBeGreaterThanOrEqual(1);
      expect(formatBlocks[0]!.label).toBe("Directive Format Instructions");
    });

    it("does not include variable definitions block", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "Intro.")],
        variables: vars,
      });
      const state = createMockGameState({ fromVariables: vars });

      const breakdown = pb.buildPromptCostBreakdown(world, state, false);
      const varDefBlocks = breakdown.blocks.filter((b) => b.label === "Variable Definitions");
      expect(varDefBlocks).toHaveLength(0);
    });

    it("includes variable summary block when variables exist", () => {
      const vars: Variable[] = [
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "Intro.")],
        variables: vars,
      });
      const state = createMockGameState({ fromVariables: vars });

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const varSummaryBlocks = breakdown.blocks.filter((b) => b.category === "variable-summary");
      expect(varSummaryBlocks).toHaveLength(1);
      expect(varSummaryBlocks[0]!.label).toBe("Variable Summary");
    });

    it("omits variable summary block when no variables exist", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "Intro.")],
        variables: [],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const varSummaryBlocks = breakdown.blocks.filter((b) => b.category === "variable-summary");
      expect(varSummaryBlocks).toHaveLength(0);
    });

    it("includes audio instructions block when audio tracks exist", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "Intro.")],
        audioTracks: [
          { id: "bgm1", name: "Theme", type: "bgm", url: "http://example.com/theme.mp3" },
        ],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const audioBlocks = breakdown.blocks.filter((b) => b.category === "audio-instructions");
      expect(audioBlocks).toHaveLength(1);
      expect(audioBlocks[0]!.label).toBe("Audio Instructions");
    });

    it("omits audio instructions block when no audio tracks exist", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "Intro.")],
        audioTracks: [],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const audioBlocks = breakdown.blocks.filter((b) => b.category === "audio-instructions");
      expect(audioBlocks).toHaveLength(0);
    });

    it("calculates correct total tokens and chars", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "A".repeat(100), 0, { name: "Padding" })],
        variables: [],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      expect(breakdown.totalTokens).toBe(
        breakdown.blocks.reduce((sum, b) => sum + b.tokens, 0)
      );
      expect(breakdown.totalChars).toBe(
        breakdown.blocks.reduce((sum, b) => sum + b.chars, 0)
      );
    });

    it("token estimate matches the engine tokenizer", () => {
      const content = "A".repeat(200);
      const world = createMockWorld({
        entries: [alwaysSendEntry(0, content, 0, { name: "Filler" })],
        variables: [],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const entryBlock = breakdown.blocks.find((b) => b.label === "Filler");
      expect(entryBlock).toBeDefined();
      expect(entryBlock!.chars).toBe(200);
      // Token cost is the real tiktoken estimate, not a chars/4 heuristic.
      expect(entryBlock!.tokens).toBe(estimateTokens(content));
    });

    it("includes depth entries in cost breakdown", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("depth", "Depth content.", 10, { depth: 2, name: "Depth Reminder" }),
        ],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const depthBlocks = breakdown.blocks.filter((b) => b.label === "Depth Reminder");
      expect(depthBlocks).toHaveLength(1);
      expect(depthBlocks[0]!.category).toBe("entry");
    });

    it("includes post_history entries in cost breakdown", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("post_history", "Jailbreak content.", 10, { name: "Jailbreak" }),
        ],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const phBlocks = breakdown.blocks.filter((b) => b.label === "Jailbreak");
      expect(phBlocks).toHaveLength(1);
    });

    it("excludes disabled entries from cost breakdown", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("top", "Enabled.", 0, { name: "Enabled Entry" }),
          alwaysSendEntry("top", "Disabled.", 0, { name: "Disabled Entry", enabled: false }),
        ],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const labels = breakdown.blocks.map((b) => b.label);
      expect(labels).toContain("Enabled Entry");
      expect(labels).not.toContain("Disabled Entry");
    });

    it("excludes non-alwaysSend entries from cost breakdown (design-time only)", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("top", "Always.", 0, { name: "Always" }),
          createMockEntry({
            content: "Sometimes.",
            position: "top",
            alwaysSend: false,
            enabled: true,
            name: "Conditional",
          }),
        ],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const labels = breakdown.blocks.map((b) => b.label);
      expect(labels).toContain("Always");
      expect(labels).not.toContain("Conditional");
    });

    it("uses entry name as label, falls back to a section-based label", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "Named content.", 0, { name: "My Entry" }),
          alwaysSendEntry(1, "Unnamed content.", 0, { name: "" }),
        ],
      });
      const state = createMockGameState();

      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const entryBlocks = breakdown.blocks.filter((b) => b.category === "entry");
      expect(entryBlocks[0]!.label).toBe("My Entry");
      expect(entryBlocks[1]!.label).toBe("Entry (system-presets)");
    });
  });

  // =========================================================================
  // collectEntries — greeting exclusion
  // =========================================================================

  describe("collectEntries — greeting exclusion", () => {
    it("excludes greeting entries from system prompt even when alwaysSend", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry("top", "TOP"),
          createMockEntry({
            content: "Greetings!",
            role: "greeting",
            position: "greeting",
            alwaysSend: true,
            enabled: true,
          }),
        ],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);
      expect(result).toContain("TOP");
      expect(result).not.toContain("Greetings!");
    });

    it("excludes greeting entries from matched entries", () => {
      const greetingEntry = createMockEntry({
        content: "Hello!",
        role: "greeting",
        position: "greeting",
        alwaysSend: false,
        enabled: true,
      });
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", "TOP"), greetingEntry],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state, [greetingEntry]);
      expect(result).not.toContain("Hello!");
    });
  });

  // =========================================================================
  // collectEntries — deduplication
  // =========================================================================

  describe("collectEntries — deduplication", () => {
    it("does not duplicate an entry that is both alwaysSend and in matchedEntries", () => {
      const entry = createMockEntry({
        id: "shared-entry",
        content: "UNIQUE_CONTENT",
        position: "top",
        alwaysSend: true,
        enabled: true,
      });
      const world = createMockWorld({ entries: [entry] });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state, [entry]);
      // Count occurrences
      const occurrences = result.split("UNIQUE_CONTENT").length - 1;
      expect(occurrences).toBe(1);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("handles world with no entries at all", () => {
      const world = createMockWorld({ entries: [], variables: [] });
      const state = createMockGameState();

      // No entries, no variables, no directives → empty system prompt (no throw).
      const result = pb.buildSystemPrompt(world, state);
      expect(result).toBe("");
    });

    it("routes entries to the right builder by section/role", () => {
      const world = createMockWorld({
        entries: [
          alwaysSendEntry(0, "CONTENT_TOP"),
          alwaysSendEntry(1, "CONTENT_BOTTOM"),
          alwaysSendEntry(2, "CONTENT_DEPTH", 0, { section: "chat-history", depth: 2 }),
          createMockEntry({
            content: "CONTENT_GREETING",
            role: "greeting",
            position: 3,
            alwaysSend: true,
            enabled: true,
          }),
          alwaysSendEntry(4, "CONTENT_POST_HISTORY", 0, { section: "post-history" }),
        ],
      });
      const state = createMockGameState();

      // System prompt only includes system-presets entries (not chat-history,
      // post-history, greeting, or example).
      const systemPrompt = pb.buildSystemPrompt(world, state);
      expect(systemPrompt).toContain("CONTENT_TOP");
      expect(systemPrompt).toContain("CONTENT_BOTTOM");
      expect(systemPrompt).not.toContain("CONTENT_DEPTH");
      expect(systemPrompt).not.toContain("CONTENT_GREETING");
      expect(systemPrompt).not.toContain("CONTENT_POST_HISTORY");

      // Depth and post-history are delivered by their own builders.
      const depth = pb.buildDepthEntries(world, state);
      expect(depth).toHaveLength(1);

      const postHistory = pb.buildPostHistoryEntries(world, state);
      expect(postHistory).toHaveLength(1);
    });

    it("handles very long entry content gracefully", () => {
      const longContent = "x".repeat(100000);
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", longContent)],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);
      expect(result).toContain(longContent);
    });

    it("handles special characters in entry content", () => {
      const world = createMockWorld({
        entries: [alwaysSendEntry("top", 'Content with "quotes" and $pecial {chars}')],
      });
      const state = createMockGameState();

      const result = pb.buildSystemPrompt(world, state);
      expect(result).toContain('Content with "quotes" and $pecial {chars}');
    });
  });

  // =========================================================================
  // buildTriggeredSystemMessages
  // =========================================================================

  describe("buildTriggeredSystemMessages", () => {
    it("emits a system message for a keyword-triggered system-presets entry", () => {
      const triggered = createMockEntry({
        section: "system-presets",
        alwaysSend: false,
        content: "Secret lore about dragons.",
        role: "lore",
      });
      const world = createMockWorld({ entries: [triggered] });
      const state = createMockGameState();

      const result = pb.buildTriggeredSystemMessages(world, state, [triggered]);

      expect(result).toHaveLength(1);
      expect(result[0]!.role).toBe("system");
      expect(result[0]!.content).toBe("Secret lore about dragons.");
    });

    it("returns empty array when triggered is empty", () => {
      const world = createMockWorld();
      const state = createMockGameState();
      expect(pb.buildTriggeredSystemMessages(world, state, [])).toEqual([]);
    });

    it("skips chat-history entries (handled by buildDepthEntries)", () => {
      const triggered = createMockEntry({
        section: "chat-history",
        alwaysSend: false,
        depth: 4,
        content: "Chat-history triggered.",
      });
      const world = createMockWorld({ entries: [triggered] });
      const state = createMockGameState();

      expect(pb.buildTriggeredSystemMessages(world, state, [triggered])).toEqual([]);
    });

    it("skips post-history entries (handled by buildPostHistoryEntries)", () => {
      const triggered = createMockEntry({
        section: "post-history",
        alwaysSend: false,
        content: "Post-history triggered.",
      });
      const world = createMockWorld({ entries: [triggered] });
      const state = createMockGameState();

      expect(pb.buildTriggeredSystemMessages(world, state, [triggered])).toEqual([]);
    });

    it("skips example and greeting role entries", () => {
      const example = createMockEntry({
        section: "examples",
        alwaysSend: false,
        role: "example",
        content: "Example dialogue.",
      });
      const greeting = createMockEntry({
        alwaysSend: false,
        role: "greeting",
        content: "Hello!",
      });
      const world = createMockWorld({ entries: [example, greeting] });
      const state = createMockGameState();

      expect(pb.buildTriggeredSystemMessages(world, state, [example, greeting])).toEqual([]);
    });

    it("skips alwaysSend entries (already handled by buildSystemMessages)", () => {
      const always = createMockEntry({
        section: "system-presets",
        alwaysSend: true,
        content: "Always-send content.",
      });
      const world = createMockWorld({ entries: [always] });
      const state = createMockGameState();

      expect(pb.buildTriggeredSystemMessages(world, state, [always])).toEqual([]);
    });

    it("skips disabled entries", () => {
      const disabled = createMockEntry({
        section: "system-presets",
        alwaysSend: false,
        enabled: false,
        content: "Disabled.",
      });
      const world = createMockWorld({ entries: [disabled] });
      const state = createMockGameState();

      expect(pb.buildTriggeredSystemMessages(world, state, [disabled])).toEqual([]);
    });

    it("honors toggledEntries override", () => {
      const entry = createMockEntry({
        id: "t1",
        section: "system-presets",
        alwaysSend: false,
        enabled: true,
        content: "Should be toggled off.",
      });
      const world = createMockWorld({ entries: [entry] });
      const state = createMockGameState();

      const result = pb.buildTriggeredSystemMessages(world, state, [entry], { t1: false });
      expect(result).toEqual([]);
    });

    it("sorts entries by position ascending", () => {
      const a = createMockEntry({
        id: "a",
        section: "system-presets",
        alwaysSend: false,
        content: "A",
        position: 3,
      });
      const b = createMockEntry({
        id: "b",
        section: "system-presets",
        alwaysSend: false,
        content: "B",
        position: 1,
      });
      const c = createMockEntry({
        id: "c",
        section: "system-presets",
        alwaysSend: false,
        content: "C",
        position: 2,
      });
      const world = createMockWorld({ entries: [a, b, c] });
      const state = createMockGameState();

      const result = pb.buildTriggeredSystemMessages(world, state, [a, b, c]);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("B\n\nC\n\nA");
    });

    it("splits into separate messages when apiRole differs", () => {
      const sys1 = createMockEntry({
        id: "s1",
        section: "system-presets",
        alwaysSend: false,
        content: "System one.",
        apiRole: "system",
        position: 1,
      });
      const user = createMockEntry({
        id: "u",
        section: "system-presets",
        alwaysSend: false,
        content: "User injected.",
        apiRole: "user",
        position: 2,
      });
      const sys2 = createMockEntry({
        id: "s2",
        section: "system-presets",
        alwaysSend: false,
        content: "System two.",
        apiRole: "system",
        position: 3,
      });
      const world = createMockWorld({ entries: [sys1, user, sys2] });
      const state = createMockGameState();

      const result = pb.buildTriggeredSystemMessages(world, state, [sys1, user, sys2]);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ role: "system", content: "System one." });
      expect(result[1]).toEqual({ role: "user", content: "User injected." });
      expect(result[2]).toEqual({ role: "system", content: "System two." });
    });

    it("interpolates macros in content", () => {
      const charEntry = createMockEntry({
        role: "character",
        name: "Lorien",
        alwaysSend: true,
        content: "Character ref.",
      });
      const triggered = createMockEntry({
        section: "system-presets",
        alwaysSend: false,
        content: "Character name is {{char}}.",
      });
      const world = createMockWorld({ entries: [charEntry, triggered] });
      const state = createMockGameState();

      const result = pb.buildTriggeredSystemMessages(world, state, [triggered]);
      expect(result[0]!.content).toContain("Lorien");
    });
  });

  // =========================================================================
  // toggledEntries override flows through buildSystemMessages / buildExampleMessages /
  // buildDepthEntries — regression for the bug where ruleState.toggledEntries was
  // stored on the snapshot but never forwarded to the prompt builders, leaving
  // toggle-entry rule actions silently ineffective.
  // =========================================================================

  describe("toggledEntries override — reaction toggle-entry integration", () => {
    it("buildSystemMessages includes entries toggled on via override (enabled=false originally)", () => {
      const blueprint = createMockEntry({
        id: "culprit-blueprint-margaret",
        section: "system-presets",
        position: "top",
        alwaysSend: true,
        enabled: false,
        content: "BLUEPRINT_MARGARET_CONTENT",
      });
      const world = createMockWorld({ entries: [blueprint] });
      const state = createMockGameState();

      const withoutToggle = pb.buildSystemMessages(world, state);
      expect(withoutToggle.some((m) => m.content.includes("BLUEPRINT_MARGARET_CONTENT"))).toBe(false);

      const withToggle = pb.buildSystemMessages(world, state, undefined, undefined, undefined, {
        "culprit-blueprint-margaret": true,
      });
      expect(withToggle.some((m) => m.content.includes("BLUEPRINT_MARGARET_CONTENT"))).toBe(true);
    });

    it("buildSystemMessages excludes entries toggled off via override (enabled=true originally)", () => {
      const lore = createMockEntry({
        id: "lore-1",
        section: "system-presets",
        position: "top",
        alwaysSend: true,
        enabled: true,
        content: "LORE_CONTENT_ONE",
      });
      const world = createMockWorld({ entries: [lore] });
      const state = createMockGameState();

      const withToggle = pb.buildSystemMessages(world, state, undefined, undefined, undefined, {
        "lore-1": false,
      });
      expect(withToggle.some((m) => m.content.includes("LORE_CONTENT_ONE"))).toBe(false);
    });

    it("buildDepthEntries honors toggledEntries override", () => {
      const depthEntry = createMockEntry({
        id: "depth-1",
        section: "chat-history",
        position: "depth",
        depth: 2,
        alwaysSend: true,
        enabled: false,
        content: "DEPTH_ENTRY_CONTENT",
      });
      const world = createMockWorld({ entries: [depthEntry] });
      const state = createMockGameState();

      const withoutToggle = pb.buildDepthEntries(world, state);
      expect(withoutToggle).toHaveLength(0);

      const withToggle = pb.buildDepthEntries(world, state, undefined, undefined, {
        "depth-1": true,
      });
      expect(withToggle).toHaveLength(1);
      expect(withToggle[0]!.content).toBe("DEPTH_ENTRY_CONTENT");
    });

    it("collectEntries honors toggledEntries override — powers the other builders", () => {
      const toggledOn = createMockEntry({
        id: "toggled-on",
        alwaysSend: true,
        enabled: false,
      });
      const toggledOff = createMockEntry({
        id: "toggled-off",
        alwaysSend: true,
        enabled: true,
      });
      const world = createMockWorld({ entries: [toggledOn, toggledOff] });

      const withoutOverride = pb.collectEntries(world);
      expect(withoutOverride.map((e) => e.id)).toEqual(["toggled-off"]);

      const withOverride = pb.collectEntries(world, undefined, undefined, {
        "toggled-on": true,
        "toggled-off": false,
      });
      expect(withOverride.map((e) => e.id)).toEqual(["toggled-on"]);
    });
  });

  // =========================================================================
  // Variable-bound entries vs a stale alwaysSend=true — regression for the
  // bundle-import bug where deriveSectionDefaults clobbered alwaysSend back to
  // true on condition-gated entries, so they were injected every turn. The
  // matcher already routed them correctly (lorebook-matcher.ts alwaysSend
  // bucket checks isVariableBoundEntry); the prompt builders must agree.
  // =========================================================================

  describe("variable-bound entries — stale alwaysSend must not bypass conditions", () => {
    /** The corrupted shape old bundle imports produced. */
    function clobberedEntry(overrides: Partial<WorldEntry> = {}): WorldEntry {
      return createMockEntry({
        id: "vb-1",
        section: "system-presets",
        alwaysSend: true, // clobbered — author had set false when binding
        variableBound: true,
        enabled: true,
        conditions: [{ variableId: "is-inside", operator: "eq", value: true }],
        conditionLogic: "all",
        content: "INSIDE_MODE_CONTENT",
        role: "lore",
        ...overrides,
      });
    }

    it("collectEntries leaves variable-bound entries out of the alwaysSend bucket", () => {
      const world = createMockWorld({
        entries: [clobberedEntry()],
        variables: [createMockVariable({ id: "is-inside", name: "is-inside", type: "boolean", defaultValue: false })],
      });
      const collected = pb.collectEntries(world);
      expect(collected.map((e) => e.id)).toEqual([]);
    });

    it("buildSystemMessages omits a clobbered entry whose condition is not met", () => {
      const world = createMockWorld({
        entries: [clobberedEntry()],
        variables: [createMockVariable({ id: "is-inside", name: "is-inside", type: "boolean", defaultValue: false })],
      });
      const state = createMockGameState({ variables: { "is-inside": false } });
      const messages = pb.buildSystemMessages(world, state);
      expect(messages.some((m) => m.content.includes("INSIDE_MODE_CONTENT"))).toBe(false);
    });

    it("buildTriggeredSystemMessages does NOT drop a matched variable-bound entry just because alwaysSend is stale-true", () => {
      const entry = clobberedEntry();
      const world = createMockWorld({ entries: [entry] });
      const state = createMockGameState({ variables: { "is-inside": true } });
      // Simulates the matcher having triggered it (condition satisfied).
      const result = pb.buildTriggeredSystemMessages(world, state, [entry]);
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("INSIDE_MODE_CONTENT");
    });

    it("still reaches the prompt through matched entries when its condition holds", () => {
      const entry = clobberedEntry();
      const world = createMockWorld({
        entries: [entry],
        variables: [createMockVariable({ id: "is-inside", name: "is-inside", type: "boolean", defaultValue: false })],
      });
      const state = createMockGameState({ variables: { "is-inside": true } });
      // messages.ts feeds matcher.triggered into buildTriggeredSystemMessages;
      // collectEntries also merges matchedEntries for the string-prompt path.
      const collected = pb.collectEntries(world, [entry], undefined, undefined, state);
      expect(collected.map((e) => e.id)).toEqual(["vb-1"]);
    });

    it("buildPromptCostBreakdown does not count variable-bound entries as always-send", () => {
      const world = createMockWorld({
        entries: [clobberedEntry()],
        variables: [createMockVariable({ id: "is-inside", name: "is-inside", type: "boolean", defaultValue: false })],
      });
      const state = createMockGameState({ variables: { "is-inside": false } });
      const breakdown = pb.buildPromptCostBreakdown(world, state);
      const blockText = JSON.stringify(breakdown);
      expect(blockText.includes("INSIDE_MODE_CONTENT")).toBe(false);
    });

    it("entries with conditions but no explicit variableBound flag get the same gating", () => {
      // isVariableBoundEntry also treats conditions.length > 0 as bound.
      const world = createMockWorld({
        entries: [clobberedEntry({ variableBound: undefined })],
        variables: [createMockVariable({ id: "is-inside", name: "is-inside", type: "boolean", defaultValue: false })],
      });
      const state = createMockGameState({ variables: { "is-inside": false } });
      const messages = pb.buildSystemMessages(world, state);
      expect(messages.some((m) => m.content.includes("INSIDE_MODE_CONTENT"))).toBe(false);
    });
  });
});
