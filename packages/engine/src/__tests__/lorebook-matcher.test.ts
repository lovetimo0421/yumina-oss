import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { LorebookMatcher } from "../lorebook/lorebook-matcher.js";
import { estimateTokens, preloadTokenizer } from "../prompts/token-utils.js";
import type { WorldEntry, GameState, Condition } from "../types/index.js";
import {
  createMockEntry,
  createMockGameState,
  createMockCondition,
  resetIdCounter,
} from "./test-utils.js";

// cl100k_base ranks load lazily — await them so token-budget assertions run
// against the exact encoder rather than the char heuristic fallback.
beforeAll(() => preloadTokenizer());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to build a GameState with specific variable values */
function stateWith(variables: Record<string, number | string | boolean>): GameState {
  return createMockGameState({ variables });
}

/** Empty game state (no variables) */
function emptyState(): GameState {
  return createMockGameState();
}

/** Create a lorebook entry with keywords and content */
function loreEntry(
  keywords: string[],
  content: string,
  overrides: Partial<WorldEntry> = {},
): WorldEntry {
  return createMockEntry({
    role: "lore",
    position: 0,
    keywords,
    content,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LorebookMatcher", () => {
  let matcher: LorebookMatcher;

  beforeEach(() => {
    resetIdCounter();
    matcher = new LorebookMatcher();
  });

  // =========================================================================
  // Basic keyword matching
  // =========================================================================

  describe("basic keyword matching", () => {
    it("matches entries by case-insensitive substring", () => {
      const entries = [
        loreEntry(["dragon"], "Dragons are fearsome creatures."),
      ];
      const result = matcher.match(entries, ["I saw a Dragon flying"], emptyState());
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("Dragons are fearsome creatures.");
    });

    it("is case-insensitive for both text and keywords", () => {
      const entries = [
        loreEntry(["MAGIC"], "Magic is ancient."),
      ];
      const result = matcher.match(entries, ["there is magic everywhere"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("matches partial substrings by default", () => {
      const entries = [
        loreEntry(["sword"], "A legendary blade."),
      ];
      // "swordsman" contains "sword" as a substring
      const result = matcher.match(entries, ["The swordsman approached"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("returns no matches when keywords are not found", () => {
      const entries = [
        loreEntry(["unicorn"], "A mythical creature."),
      ];
      const result = matcher.match(entries, ["The warrior fought bravely"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("matches against multiple messages joined together", () => {
      const entries = [
        loreEntry(["potion"], "A healing brew."),
      ];
      const result = matcher.match(
        entries,
        ["I need something", "Maybe a potion?"],
        emptyState(),
      );
      expect(result).toHaveLength(1);
    });

    it("matches multiple keywords (any match triggers)", () => {
      const entries = [
        loreEntry(["fire", "flame", "blaze"], "The element of destruction."),
      ];
      const result = matcher.match(entries, ["The blaze consumed the forest"], emptyState());
      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // User regex keywords
  // =========================================================================

  describe("user regex keyword matching", () => {
    it("matches user-supplied regex patterns like /pattern/flags", () => {
      const entries = [
        loreEntry(["/drag(on|ons|onfire)/"], "Info about dragons."),
      ];
      const result = matcher.match(entries, ["The dragonfire swept through"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("applies case-insensitive matching even without i flag", () => {
      // The code always adds 'i' flag if not present
      const entries = [
        loreEntry(["/CASTLE/"], "A grand fortress."),
      ];
      const result = matcher.match(entries, ["the castle stands tall"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("respects explicit regex flags", () => {
      const entries = [
        loreEntry(["/^hello/i"], "A greeting entry."),
      ];
      const result = matcher.match(entries, ["Hello world"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("falls through gracefully on invalid regex", () => {
      // Invalid regex should not crash, falls through to substring
      const entries = [
        loreEntry(["/[invalid/"], "Some content."),
      ];
      // The keyword "/[invalid/" as substring won't match either
      const result = matcher.match(entries, ["some text about invalid things"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("matches regex with capture groups", () => {
      const entries = [
        loreEntry(["/\\d+ gold/"], "Currency info."),
      ];
      const result = matcher.match(entries, ["You received 50 gold coins"], emptyState());
      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // Whole-word matching
  // =========================================================================

  describe("whole-word boundary matching", () => {
    it("matches whole words only when matchWholeWords is true", () => {
      const entries = [
        loreEntry(["sword"], "A legendary blade.", { matchWholeWords: true }),
      ];
      const result = matcher.match(entries, ["I have a sword"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("rejects partial matches when matchWholeWords is true", () => {
      const entries = [
        loreEntry(["sword"], "A legendary blade.", { matchWholeWords: true }),
      ];
      // "swordsman" should NOT match "sword" with whole-word
      const result = matcher.match(entries, ["The swordsman approached"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("handles word boundaries at start and end of text", () => {
      const entries = [
        loreEntry(["hello"], "A greeting.", { matchWholeWords: true }),
      ];
      const result = matcher.match(entries, ["hello"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("handles keywords with special regex characters in whole-word mode", () => {
      const entries = [
        loreEntry(["c++"], "A programming language.", { matchWholeWords: true }),
      ];
      // The special chars get escaped in the regex; \b won't work with + though
      // This tests that the code doesn't crash
      const result = matcher.match(entries, ["I know c++ well"], emptyState());
      // May or may not match depending on \b behavior with special chars; no crash is the goal
      expect(result).toBeDefined();
    });
  });

  // =========================================================================
  // Condition-based filtering
  // =========================================================================

  describe("condition-based entry filtering", () => {
    it("includes entry when conditions are met (conditionLogic=all)", () => {
      const entries = [
        loreEntry(["battle"], "Epic battle lore.", {
          conditions: [
            createMockCondition({ variableId: "strength", operator: "gte", value: 10 }),
          ],
          conditionLogic: "all",
        }),
      ];
      const state = stateWith({ strength: 15 });
      const result = matcher.match(entries, ["A battle approaches"], state);
      expect(result).toHaveLength(1);
    });

    it("excludes entry when conditions fail (conditionLogic=all)", () => {
      const entries = [
        loreEntry(["battle"], "Epic battle lore.", {
          conditions: [
            createMockCondition({ variableId: "strength", operator: "gte", value: 10 }),
          ],
          conditionLogic: "all",
        }),
      ];
      const state = stateWith({ strength: 5 });
      const result = matcher.match(entries, ["A battle approaches"], state);
      expect(result).toHaveLength(0);
    });

    it("conditionLogic=any passes if any condition is true", () => {
      const entries = [
        loreEntry(["quest"], "A new quest.", {
          conditions: [
            createMockCondition({ variableId: "level", operator: "gte", value: 20 }),
            createMockCondition({ variableId: "fame", operator: "gte", value: 50 }),
          ],
          conditionLogic: "any",
        }),
      ];
      // level < 20, but fame >= 50
      const state = stateWith({ level: 5, fame: 60 });
      const result = matcher.match(entries, ["I seek a quest"], state);
      expect(result).toHaveLength(1);
    });

    it("conditionLogic=all requires all conditions true", () => {
      const entries = [
        loreEntry(["quest"], "A new quest.", {
          conditions: [
            createMockCondition({ variableId: "level", operator: "gte", value: 20 }),
            createMockCondition({ variableId: "fame", operator: "gte", value: 50 }),
          ],
          conditionLogic: "all",
        }),
      ];
      // level >= 20, but fame < 50
      const state = stateWith({ level: 25, fame: 10 });
      const result = matcher.match(entries, ["I seek a quest"], state);
      expect(result).toHaveLength(0);
    });

    it("handles eq operator", () => {
      const entries = [
        loreEntry(["class"], "Wizard class info.", {
          conditions: [
            createMockCondition({ variableId: "class", operator: "eq", value: "wizard" }),
          ],
        }),
      ];
      const state = stateWith({ class: "wizard" });
      const result = matcher.match(entries, ["My class is special"], state);
      expect(result).toHaveLength(1);
    });

    it("handles neq operator", () => {
      const entries = [
        loreEntry(["class"], "Not a warrior.", {
          conditions: [
            createMockCondition({ variableId: "class", operator: "neq", value: "warrior" }),
          ],
        }),
      ];
      const state = stateWith({ class: "mage" });
      const result = matcher.match(entries, ["My class is mage"], state);
      expect(result).toHaveLength(1);
    });

    it("handles contains operator on string variables", () => {
      const entries = [
        loreEntry(["inventory"], "You have a special item.", {
          conditions: [
            createMockCondition({ variableId: "items", operator: "contains", value: "ring" }),
          ],
        }),
      ];
      const state = stateWith({ items: "sword,ring,potion" });
      const result = matcher.match(entries, ["Check my inventory"], state);
      expect(result).toHaveLength(1);
    });

    it("returns false for undefined variable in condition", () => {
      const entries = [
        loreEntry(["test"], "Hidden entry.", {
          conditions: [
            createMockCondition({ variableId: "nonexistent", operator: "eq", value: 5 }),
          ],
        }),
      ];
      const result = matcher.match(entries, ["test message"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("entries without conditions only need keyword match", () => {
      const entries = [
        loreEntry(["forest"], "A dense forest."),
      ];
      const result = matcher.match(entries, ["The forest is dark"], emptyState());
      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // Secondary keywords
  // =========================================================================

  describe("secondary keywords with logic modes", () => {
    it("AND_ANY: passes when at least one secondary keyword matches", () => {
      const entries = [
        loreEntry(["dragon"], "Dragon in cave.", {
          secondaryKeywords: ["cave", "mountain"],
          secondaryKeywordLogic: "AND_ANY",
        }),
      ];
      const result = matcher.match(entries, ["The dragon lives in a cave"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("AND_ANY: fails when no secondary keyword matches", () => {
      const entries = [
        loreEntry(["dragon"], "Dragon in cave.", {
          secondaryKeywords: ["cave", "mountain"],
          secondaryKeywordLogic: "AND_ANY",
        }),
      ];
      const result = matcher.match(entries, ["The dragon flew over the river"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("AND_ALL: passes when all secondary keywords match", () => {
      const entries = [
        loreEntry(["dragon"], "Fire-breathing cave dragon.", {
          secondaryKeywords: ["fire", "cave"],
          secondaryKeywordLogic: "AND_ALL",
        }),
      ];
      const result = matcher.match(
        entries,
        ["The dragon breathes fire in the cave"],
        emptyState(),
      );
      expect(result).toHaveLength(1);
    });

    it("AND_ALL: fails when only some secondary keywords match", () => {
      const entries = [
        loreEntry(["dragon"], "Fire-breathing cave dragon.", {
          secondaryKeywords: ["fire", "cave"],
          secondaryKeywordLogic: "AND_ALL",
        }),
      ];
      const result = matcher.match(entries, ["The dragon breathes fire in the sky"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("NOT_ANY: passes when no secondary keyword matches", () => {
      const entries = [
        loreEntry(["dragon"], "Peaceful dragon.", {
          secondaryKeywords: ["attack", "fight", "battle"],
          secondaryKeywordLogic: "NOT_ANY",
        }),
      ];
      const result = matcher.match(entries, ["The dragon rests peacefully"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("NOT_ANY: fails when any secondary keyword matches", () => {
      const entries = [
        loreEntry(["dragon"], "Peaceful dragon.", {
          secondaryKeywords: ["attack", "fight", "battle"],
          secondaryKeywordLogic: "NOT_ANY",
        }),
      ];
      const result = matcher.match(entries, ["The dragon begins to attack"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("NOT_ALL: passes when not all secondary keywords match", () => {
      const entries = [
        loreEntry(["dragon"], "Partial match dragon.", {
          secondaryKeywords: ["fire", "ice", "lightning"],
          secondaryKeywordLogic: "NOT_ALL",
        }),
      ];
      // Only "fire" matches, not all three
      const result = matcher.match(entries, ["The dragon uses fire"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("NOT_ALL: fails when all secondary keywords match", () => {
      const entries = [
        loreEntry(["dragon"], "All elements dragon.", {
          secondaryKeywords: ["fire", "ice", "lightning"],
          secondaryKeywordLogic: "NOT_ALL",
        }),
      ];
      const result = matcher.match(
        entries,
        ["The dragon wields fire, ice, and lightning"],
        emptyState(),
      );
      expect(result).toHaveLength(0);
    });

    it("defaults to AND_ANY when secondaryKeywordLogic is not set", () => {
      const entries = [
        loreEntry(["dragon"], "Dragon info.", {
          secondaryKeywords: ["treasure"],
          // No explicit secondaryKeywordLogic — defaults to AND_ANY
        }),
      ];
      const result = matcher.match(entries, ["The dragon guards treasure"], emptyState());
      expect(result).toHaveLength(1);
    });

    it("ignores secondary keywords when the array is empty", () => {
      const entries = [
        loreEntry(["dragon"], "Dragon info.", {
          secondaryKeywords: [],
          secondaryKeywordLogic: "AND_ALL",
        }),
      ];
      // No secondary keywords means no secondary check needed
      const result = matcher.match(entries, ["A dragon appeared"], emptyState());
      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // Recursive triggering
  // =========================================================================

  describe("recursive triggering", () => {
    it("cascade-triggers entries when recursion depth > 0", () => {
      const entryA = loreEntry(["castle"], "The castle contains a throne room.", {
        id: "entry-a",
      });
      const entryB = loreEntry(["throne"], "The throne is made of gold.", {
        id: "entry-b",
      });

      const result = matcher.matchWithBudget(
        [entryA, entryB],
        ["I approach the castle"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: 1 },
      );

      // entryA matches "castle" directly. Its content has "throne",
      // which triggers entryB at recursion depth 1.
      expect(result.triggered).toHaveLength(2);
      const ids = result.triggered.map((e) => e.id);
      expect(ids).toContain("entry-a");
      expect(ids).toContain("entry-b");
    });

    it("does not cascade when recursion depth is 0", () => {
      const entryA = loreEntry(["castle"], "The castle contains a throne room.", {
        id: "entry-a",
      });
      const entryB = loreEntry(["throne"], "The throne is made of gold.", {
        id: "entry-b",
      });

      const result = matcher.matchWithBudget(
        [entryA, entryB],
        ["I approach the castle"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: 0 },
      );

      expect(result.triggered).toHaveLength(1);
      expect(result.triggered[0]!.id).toBe("entry-a");
    });

    it("supports multi-level cascading", () => {
      const entryA = loreEntry(["castle"], "The castle has a throne.", { id: "a" });
      const entryB = loreEntry(["throne"], "The throne has a jewel.", { id: "b" });
      const entryC = loreEntry(["jewel"], "The jewel glows with power.", { id: "c" });

      const result = matcher.matchWithBudget(
        [entryA, entryB, entryC],
        ["I see the castle"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: 3 },
      );

      expect(result.triggered).toHaveLength(3);
    });

    it("does not trigger the same entry twice during recursion", () => {
      // entryA and entryB reference each other
      const entryA = loreEntry(["castle"], "The castle has a dragon.", { id: "a" });
      const entryB = loreEntry(["dragon"], "The dragon guards the castle.", { id: "b" });

      const result = matcher.matchWithBudget(
        [entryA, entryB],
        ["I see the castle"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: 5 },
      );

      // Each entry activated once, no infinite loop
      expect(result.triggered).toHaveLength(2);
    });

    it("stops early when no new entries are activated", () => {
      const entryA = loreEntry(["castle"], "A plain castle.", { id: "a" });

      const result = matcher.matchWithBudget(
        [entryA],
        ["I see the castle"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: 10 },
      );

      expect(result.triggered).toHaveLength(1);
    });
  });

  // =========================================================================
  // preventRecursion / excludeRecursion flags
  // =========================================================================

  describe("preventRecursion flag", () => {
    it("prevents entry content from triggering other entries during recursion", () => {
      const entryA = loreEntry(["castle"], "The castle contains a throne room.", {
        id: "entry-a",
        preventRecursion: true,
      });
      const entryB = loreEntry(["throne"], "The throne is made of gold.", {
        id: "entry-b",
      });

      const result = matcher.matchWithBudget(
        [entryA, entryB],
        ["I approach the castle"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: 2 },
      );

      // entryA matches, but its content is NOT added to scan text,
      // so "throne" in entryA's content does not trigger entryB.
      expect(result.triggered).toHaveLength(1);
      expect(result.triggered[0]!.id).toBe("entry-a");
    });
  });

  describe("excludeRecursion flag", () => {
    it("prevents entry from being triggered during recursion scans", () => {
      const entryA = loreEntry(["castle"], "The castle has a throne.", {
        id: "entry-a",
      });
      const entryB = loreEntry(["throne"], "Secret throne info.", {
        id: "entry-b",
        excludeRecursion: true,
      });

      const result = matcher.matchWithBudget(
        [entryA, entryB],
        ["I approach the castle"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: 2 },
      );

      // entryB has excludeRecursion, so even though "throne" appears
      // in entryA's content, entryB is skipped at depth > 0
      expect(result.triggered).toHaveLength(1);
      expect(result.triggered[0]!.id).toBe("entry-a");
    });

    it("excludeRecursion entry can still match at depth 0 (initial scan)", () => {
      const entry = loreEntry(["castle"], "Castle info.", {
        id: "entry-a",
        excludeRecursion: true,
      });

      const result = matcher.matchWithBudget(
        [entry],
        ["I see the castle"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: 2 },
      );

      // At depth 0 (initial scan), excludeRecursion is not checked
      expect(result.triggered).toHaveLength(1);
    });
  });

  // =========================================================================
  // Token budget enforcement
  // =========================================================================

  describe("token budget enforcement", () => {
    it("includes entries up to the token budget", () => {
      // estimateTokens = ceil(length / 4)
      // "AAAA" = 1 token, "AAAA AAAA" = 3 tokens, etc.
      const entries = [
        loreEntry(["alpha"], "A".repeat(40), { id: "a", priority: 10 }), // 10 tokens
        loreEntry(["beta"], "B".repeat(40), { id: "b", priority: 5 }),   // 10 tokens
        loreEntry(["gamma"], "C".repeat(40), { id: "c", priority: 1 }),  // 10 tokens
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["alpha beta gamma"],
        emptyState(),
        20, // budget for 2 entries
      );

      expect(result.triggered).toHaveLength(2);
      // Sorted by priority desc, so alpha (10) and beta (5)
      expect(result.triggered[0]!.id).toBe("a");
      expect(result.triggered[1]!.id).toBe("b");
    });

    it("always includes the first entry even if it exceeds budget", () => {
      const content = "X".repeat(400);
      const entries = [
        loreEntry(["big"], content, { id: "big" }),
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["big word"],
        emptyState(),
        5, // Much smaller than the entry's real token cost
      );

      // First entry is always included even if it exceeds budget
      expect(result.triggered).toHaveLength(1);
      expect(result.triggeredTokens).toBe(estimateTokens(content));
      expect(result.triggeredTokens).toBeGreaterThan(5);
    });

    it("reports triggeredTokens accurately", () => {
      const content = "A".repeat(20);
      const entries = [
        loreEntry(["test"], content, { id: "a" }),
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["test message"],
        emptyState(),
      );

      // triggeredTokens must equal the engine's own token estimate for the content.
      expect(result.triggeredTokens).toBe(estimateTokens(content));
    });

    it("infinite budget includes all matched entries", () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        loreEntry([`kw${i}`], `Content for entry ${i}`, { id: `e-${i}` }),
      );

      const messages = [entries.map((e) => e.keywords[0]!).join(" ")];
      const result = matcher.matchWithBudget(entries, messages, emptyState(), Infinity);

      expect(result.triggered).toHaveLength(10);
    });
  });

  // =========================================================================
  // Always-send entries
  // =========================================================================

  describe("always-send entries bypass token limits", () => {
    it("always-send entries appear in alwaysSend, not triggered", () => {
      const entries = [
        loreEntry(["anything"], "Always present.", {
          id: "always",
          alwaysSend: true,
        }),
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["some message"],
        emptyState(),
      );

      expect(result.alwaysSend).toHaveLength(1);
      expect(result.alwaysSend[0]!.id).toBe("always");
      expect(result.triggered).toHaveLength(0);
    });

    it("always-send entries bypass keyword matching", () => {
      const entries = [
        loreEntry([], "Always present, no keywords.", {
          id: "always",
          alwaysSend: true,
        }),
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["nothing matches"],
        emptyState(),
      );

      expect(result.alwaysSend).toHaveLength(1);
    });

    it("always-send entries are not subject to token budget", () => {
      const entries = [
        loreEntry([], "X".repeat(4000), {
          id: "always-big",
          alwaysSend: true,
        }),
        loreEntry(["test"], "Small entry.", {
          id: "triggered",
          priority: 1,
        }),
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["test message"],
        emptyState(),
        5, // Very small budget
      );

      // Always-send is separate from budget
      expect(result.alwaysSend).toHaveLength(1);
      // Triggered entry still gets included (first entry rule)
      expect(result.triggered).toHaveLength(1);
    });

    it("legacy match() returns always-send + triggered combined", () => {
      const entries = [
        loreEntry([], "Always here.", {
          id: "always",
          alwaysSend: true,
        }),
        loreEntry(["keyword"], "Triggered entry.", {
          id: "triggered",
        }),
      ];

      const result = matcher.match(entries, ["keyword found"], emptyState());
      expect(result).toHaveLength(2);
    });
  });

  // =========================================================================
  // CJK keyword support
  // =========================================================================

  describe("CJK keyword support", () => {
    it("matches Chinese keywords", () => {
      const entries = [
        loreEntry(["\u9F99"], "\u4E1C\u65B9\u9F99\u7684\u4F20\u8BF4\u3002"), // 龙 -> 东方龙的传说。
      ];
      const result = matcher.match(
        entries,
        ["\u5168\u4E16\u754C\u90FD\u77E5\u9053\u9F99\u7684\u4F20\u8BF4"], // 全世界都知道龙的传说
        emptyState(),
      );
      expect(result).toHaveLength(1);
    });

    it("matches Japanese keywords", () => {
      const entries = [
        loreEntry(["\u6226\u58EB"], "\u52C7\u6562\u306A\u6226\u58EB\u3002"), // 戦士 -> 勇敢な戦士。
      ];
      const result = matcher.match(
        entries,
        ["\u6226\u58EB\u304C\u73FE\u308C\u305F"], // 戦士が現れた
        emptyState(),
      );
      expect(result).toHaveLength(1);
    });

    it("matches Korean keywords", () => {
      const entries = [
        loreEntry(["\uC6A9\uC0AC"], "\uC6A9\uAC10\uD55C \uC6A9\uC0AC."), // 용사 -> 용감한 용사.
      ];
      const result = matcher.match(
        entries,
        ["\uC6A9\uC0AC\uAC00 \uB098\uD0C0\uB0AC\uB2E4"], // 용사가 나타났다
        emptyState(),
      );
      expect(result).toHaveLength(1);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("skips entries with empty keywords (non-alwaysSend)", () => {
      const entries = [
        loreEntry([], "This has no keywords."),
      ];
      const result = matcher.match(entries, ["some text"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("skips disabled entries", () => {
      const entries = [
        loreEntry(["dragon"], "Disabled entry.", { enabled: false }),
      ];
      const result = matcher.match(entries, ["A dragon appeared"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("skips greeting entries", () => {
      const entries = [
        loreEntry(["hello"], "Greeting content.", { role: "greeting" }),
      ];
      const result = matcher.match(entries, ["hello world"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("handles empty messages array", () => {
      const entries = [
        loreEntry(["dragon"], "Dragon lore."),
      ];
      const result = matcher.match(entries, [], emptyState());
      expect(result).toHaveLength(0);
    });

    it("handles empty entries array", () => {
      const result = matcher.match([], ["some message"], emptyState());
      expect(result).toHaveLength(0);
    });

    it("handles empty text (joined empty messages)", () => {
      const entries = [
        loreEntry(["test"], "Test entry."),
      ];
      const result = matcher.match(entries, ["", ""], emptyState());
      expect(result).toHaveLength(0);
    });

    it("no matches when keywords do not appear in text", () => {
      const entries = [
        loreEntry(["unicorn"], "A mythical beast."),
        loreEntry(["phoenix"], "A fire bird."),
        loreEntry(["griffin"], "A noble creature."),
      ];
      const result = matcher.match(entries, ["The warrior walked silently."], emptyState());
      expect(result).toHaveLength(0);
    });
  });

  // =========================================================================
  // Priority and score sorting
  // =========================================================================

  describe("priority and score sorting", () => {
    it("sorts triggered entries by position ascending", () => {
      // The matcher orders triggered entries by `position` ascending (lower = first),
      // with keyword-match score as the tiebreak.
      const entries = [
        loreEntry(["test"], "Last.", { id: "low", position: 2 }),
        loreEntry(["test"], "First.", { id: "high", position: 0 }),
        loreEntry(["test"], "Middle.", { id: "mid", position: 1 }),
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["test message"],
        emptyState(),
      );

      expect(result.triggered[0]!.id).toBe("high");
      expect(result.triggered[1]!.id).toBe("mid");
      expect(result.triggered[2]!.id).toBe("low");
    });

    it("sorts by score (keyword match count) when priority is equal", () => {
      const entries = [
        loreEntry(["alpha"], "One match.", { id: "one", priority: 5 }),
        loreEntry(["alpha", "beta", "gamma"], "Three matches.", { id: "three", priority: 5 }),
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["alpha beta gamma delta"],
        emptyState(),
      );

      // "three" has 3 primary keyword matches, "one" has 1
      expect(result.triggered[0]!.id).toBe("three");
      expect(result.triggered[1]!.id).toBe("one");
    });

    it("secondary keywords add +1 to score", () => {
      const entries = [
        loreEntry(["alpha"], "No secondary.", { id: "no-sec", priority: 5 }),
        loreEntry(["alpha"], "Has secondary.", {
          id: "with-sec",
          priority: 5,
          secondaryKeywords: ["beta"],
          secondaryKeywordLogic: "AND_ANY",
        }),
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["alpha beta"],
        emptyState(),
      );

      // "with-sec" has score = 1 (primary) + 1 (secondary bonus) = 2
      // "no-sec" has score = 1 (primary) + 0 = 1
      expect(result.triggered[0]!.id).toBe("with-sec");
      expect(result.triggered[1]!.id).toBe("no-sec");
    });
  });

  // =========================================================================
  // checkConditions (public method)
  // =========================================================================

  describe("checkConditions", () => {
    it("returns true for empty conditions", () => {
      expect(matcher.checkConditions(emptyState(), [], "all")).toBe(true);
      expect(matcher.checkConditions(emptyState(), [], "any")).toBe(true);
    });

    it("evaluates gt operator correctly", () => {
      const conds: Condition[] = [
        createMockCondition({ variableId: "hp", operator: "gt", value: 50 }),
      ];
      expect(matcher.checkConditions(stateWith({ hp: 51 }), conds, "all")).toBe(true);
      expect(matcher.checkConditions(stateWith({ hp: 50 }), conds, "all")).toBe(false);
    });

    it("evaluates lt operator correctly", () => {
      const conds: Condition[] = [
        createMockCondition({ variableId: "hp", operator: "lt", value: 50 }),
      ];
      expect(matcher.checkConditions(stateWith({ hp: 49 }), conds, "all")).toBe(true);
      expect(matcher.checkConditions(stateWith({ hp: 50 }), conds, "all")).toBe(false);
    });

    it("evaluates lte operator correctly", () => {
      const conds: Condition[] = [
        createMockCondition({ variableId: "hp", operator: "lte", value: 50 }),
      ];
      expect(matcher.checkConditions(stateWith({ hp: 50 }), conds, "all")).toBe(true);
      expect(matcher.checkConditions(stateWith({ hp: 51 }), conds, "all")).toBe(false);
    });

    it("returns false for type mismatches in numeric operators", () => {
      const conds: Condition[] = [
        createMockCondition({ variableId: "name", operator: "gt", value: 10 }),
      ];
      // "name" is a string, operator "gt" expects numbers
      expect(matcher.checkConditions(stateWith({ name: "alice" }), conds, "all")).toBe(false);
    });
  });

  // =========================================================================
  // Recursion depth clamping
  // =========================================================================

  describe("recursion depth clamping", () => {
    it("clamps negative recursion depth to 0", () => {
      const entryA = loreEntry(["castle"], "Castle with throne.", { id: "a" });
      const entryB = loreEntry(["throne"], "Throne info.", { id: "b" });

      const result = matcher.matchWithBudget(
        [entryA, entryB],
        ["I see the castle"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: -5 },
      );

      // Negative clamped to 0, so no recursion
      expect(result.triggered).toHaveLength(1);
      expect(result.triggered[0]!.id).toBe("a");
    });

    it("clamps recursion depth to max 10", () => {
      // Build a chain of 12 entries, each triggering the next
      const entries: WorldEntry[] = [];
      for (let i = 0; i < 12; i++) {
        entries.push(
          loreEntry(
            [`kw${i}`],
            `Content with kw${i + 1}`,
            { id: `e${i}` },
          ),
        );
      }

      const result = matcher.matchWithBudget(
        entries,
        ["kw0"],
        emptyState(),
        Infinity,
        { lorebookRecursionDepth: 999 }, // Would be clamped to 10
      );

      // Depth 0 matches e0, depth 1 matches e1, ... depth 10 matches e10
      // e11 would need depth 11 but max is 10
      expect(result.triggered.length).toBeLessThanOrEqual(11);
    });
  });

  // =========================================================================
  // Combined scenarios
  // =========================================================================

  describe("combined scenarios", () => {
    it("conditions + keywords both required", () => {
      const entries = [
        loreEntry(["dragon"], "Dragon appears when brave.", {
          conditions: [
            createMockCondition({ variableId: "courage", operator: "gte", value: 80 }),
          ],
        }),
      ];

      // Keyword matches but condition fails
      const result1 = matcher.match(entries, ["The dragon rises"], stateWith({ courage: 50 }));
      expect(result1).toHaveLength(0);

      // Both keyword and condition pass
      const result2 = matcher.match(entries, ["The dragon rises"], stateWith({ courage: 90 }));
      expect(result2).toHaveLength(1);
    });

    it("mixed always-send and triggered entries with budget", () => {
      const entries = [
        loreEntry([], "System constant.", { id: "always", alwaysSend: true }),
        loreEntry(["alpha"], "A".repeat(20), { id: "alpha", priority: 10 }),
        loreEntry(["beta"], "B".repeat(20), { id: "beta", priority: 5 }),
        loreEntry(["gamma"], "C".repeat(20), { id: "gamma", priority: 1 }),
      ];

      const result = matcher.matchWithBudget(
        entries,
        ["alpha beta gamma"],
        emptyState(),
        10, // Budget for ~2 entries (5 tokens each)
      );

      expect(result.alwaysSend).toHaveLength(1);
      expect(result.triggered).toHaveLength(2);
      expect(result.triggered[0]!.id).toBe("alpha");
      expect(result.triggered[1]!.id).toBe("beta");
    });

    it("recursive trigger with conditions", () => {
      const entryA = loreEntry(["castle"], "The castle has a dragon.", { id: "a" });
      const entryB = loreEntry(["dragon"], "The dragon is hostile.", {
        id: "b",
        conditions: [
          createMockCondition({ variableId: "hostility", operator: "gte", value: 50 }),
        ],
      });

      // Recursion would trigger entryB via "dragon" in entryA's content,
      // but condition fails
      const result1 = matcher.matchWithBudget(
        [entryA, entryB],
        ["I see the castle"],
        stateWith({ hostility: 30 }),
        Infinity,
        { lorebookRecursionDepth: 2 },
      );
      expect(result1.triggered).toHaveLength(1);

      // Now condition passes
      const result2 = matcher.matchWithBudget(
        [entryA, entryB],
        ["I see the castle"],
        stateWith({ hostility: 80 }),
        Infinity,
        { lorebookRecursionDepth: 2 },
      );
      expect(result2.triggered).toHaveLength(2);
    });

    it("whole-word match — primary + rejection of partial match", () => {
      const entries = [
        loreEntry(["sword"], "Blade info.", {
          matchWholeWords: true,
        }),
      ];

      // Whole-word match should work
      const result1 = matcher.match(entries, ["I have a sword"], emptyState());
      expect(result1).toHaveLength(1);

      // Whole-word rejects partial match "swordsman"
      const result2 = matcher.match(entries, ["The swordsman arrived"], emptyState());
      expect(result2).toHaveLength(0);
    });

    it("activates condition-only entries when variables match", () => {
      const entries = [
        loreEntry([], "Town description.", {
          conditions: [createMockCondition({ variableId: "scene", operator: "eq", value: "town" })],
        }),
      ];
      const result = matcher.match(entries, ["hello"], stateWith({ scene: "town" }));
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe("Town description.");
    });

    it("skips condition-only entries when variables do not match", () => {
      const entries = [
        loreEntry([], "Town description.", {
          conditions: [createMockCondition({ variableId: "scene", operator: "eq", value: "town" })],
        }),
      ];
      const result = matcher.match(entries, ["hello"], stateWith({ scene: "forest" }));
      expect(result).toHaveLength(0);
    });

    it("matches all keyword entries regardless of legacy audience field", () => {
      const entries = [
        loreEntry(["dragon"], "Player UI lore.", { audience: "player" }),
        loreEntry(["dragon"], "AI lore.", { audience: "ai" }),
      ];
      const result = matcher.match(entries, ["I saw a dragon"], emptyState());
      expect(result).toHaveLength(2);
    });

    it("regex keyword + secondary keywords", () => {
      const entries = [
        loreEntry(["/drag(on|ons)/"], "Dragon info.", {
          secondaryKeywords: ["fire"],
          secondaryKeywordLogic: "AND_ANY",
        }),
      ];

      // Primary regex matches, secondary also matches
      const result1 = matcher.match(entries, ["The dragons breathe fire"], emptyState());
      expect(result1).toHaveLength(1);

      // Primary regex matches, secondary doesn't
      const result2 = matcher.match(entries, ["The dragons are peaceful"], emptyState());
      expect(result2).toHaveLength(0);
    });
  });
});
