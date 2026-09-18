import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { expandMacros } from "../prompts/macros.js";
import type { WorldDefinition, GameState } from "../types/index.js";
import {
  createMockWorld,
  createMockEntry,
  createMockGameState,
  createMockVariable,
  resetIdCounter,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** World with a character entry and player name configured */
function worldWithChar(
  charName: string,
  playerName?: string,
  overrides: Partial<WorldDefinition> = {}
): WorldDefinition {
  return createMockWorld({
    entries: [
      createMockEntry({
        role: "character",
        name: charName,
        enabled: true,
      }),
    ],
    settings: {
      maxTokens: 4000,
      temperature: 1.0,
      playerName,
    },
    ...overrides,
  });
}

/** Minimal world with no character entries */
function bareWorld(overrides: Partial<WorldDefinition> = {}): WorldDefinition {
  return createMockWorld(overrides);
}

/** State with metadata pre-populated */
function stateWithMetadata(
  metadata: Record<string, unknown>,
  overrides: Partial<GameState> = {}
): GameState {
  return createMockGameState({ metadata, ...overrides });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("expandMacros", () => {
  beforeEach(() => {
    resetIdCounter();
  });

  // ── {{char}} ──

  describe("{{char}}", () => {
    it("replaces {{char}} with the first enabled character entry name", () => {
      const world = worldWithChar("Elara");
      const state = createMockGameState();
      expect(expandMacros("Hello, {{char}}!", world, state)).toBe(
        "Hello, Elara!"
      );
    });

    it("defaults to 'Assistant' when no character entry exists", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{char}} says hi", world, state)).toBe(
        "Assistant says hi"
      );
    });

    it("skips disabled character entries", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            role: "character",
            name: "DisabledChar",
            enabled: false,
          }),
          createMockEntry({
            role: "character",
            name: "EnabledChar",
            enabled: true,
          }),
        ],
      });
      const state = createMockGameState();
      expect(expandMacros("{{char}}", world, state)).toBe("EnabledChar");
    });
  });

  // ── {{user}} ──

  describe("{{user}}", () => {
    it("replaces {{user}} with the player name from settings", () => {
      const world = worldWithChar("NPC", "Alice");
      const state = createMockGameState();
      expect(expandMacros("{{user}} enters the room.", world, state)).toBe(
        "Alice enters the room."
      );
    });

    it("defaults to 'Player' when playerName is not set", () => {
      // No persona, no playerName: the engine's final anchor is the literal
      // "Player". This is intentionally NOT "User" — that label was the
      // original placeholder that leaked through every drift regression.
      const world = worldWithChar("NPC");
      const state = createMockGameState();
      expect(expandMacros("Greetings, {{user}}.", world, state)).toBe(
        "Greetings, Player."
      );
    });

    it("defaults to 'Player' when playerName is empty string", () => {
      const world = worldWithChar("NPC", "");
      const state = createMockGameState();
      expect(expandMacros("{{user}}", world, state)).toBe("Player");
    });

    // Regression guard: the {{user}} resolution chain has been broken 3+ times
    // (a6d4d762, 70df57db, 3f03f22d, and the post-split restorer). Every time
    // the symptom is the same: no-persona users see literal "User" / "Player"
    // in greetings because the server-populated personaName slot is empty.
    // Locked here so the next refactor has to actively break it.
    //
    // Resolution chain:
    //   1. state.metadata.personaName  (server writes: active persona name OR
    //                                   account username — unified in persona-metadata.ts)
    //   2. world.settings.playerName   (creator default)
    //   3. "Player"                    (engine anchor — NEVER literal "User")
    describe("resolution chain", () => {
      it("resolves {{user}} to personaName when server populated it", () => {
        // Covers both paths: active persona (server writes persona.name)
        // AND no-persona-but-logged-in (server writes account.username).
        const world = worldWithChar("NPC", "CreatorDefault");
        const state = createMockGameState({
          metadata: { personaName: "Alice" },
        });
        expect(expandMacros("{{user}}", world, state)).toBe("Alice");
      });

      it("falls through to world playerName when personaName is absent", () => {
        const world = worldWithChar("NPC", "CreatorDefault");
        const state = createMockGameState({ metadata: {} });
        expect(expandMacros("{{user}}", world, state)).toBe("CreatorDefault");
      });

      it("final anchor is 'Player' — never literal 'User'", () => {
        // The creator hasn't set playerName and there's no metadata. The engine
        // must produce a usable word. This used to be "User" which looked like a
        // placeholder leak to real players. Now it's "Player".
        const world = worldWithChar("NPC");
        const state = createMockGameState();
        const rendered = expandMacros("Hello {{user}}!", world, state);
        expect(rendered).toBe("Hello Player!");
        expect(rendered).not.toContain("User");
      });

      it("treats empty-string personaName as absent (no silent empty rendering)", () => {
        // The sandbox must not render `Welcome, !` — empty-string persona name
        // is the engine's `??` weakness (only nullish falls through). Parent
        // code (chat-view.tsx / persona-metadata.ts) MUST treat empty strings
        // as absent before putting them in metadata, otherwise {{user}} is "".
        const world = worldWithChar("NPC", "CreatorDefault");
        const state = createMockGameState({
          metadata: { personaName: "" },
        });
        expect(expandMacros("{{user}}", world, state)).toBe("");
      });
    });
  });

  // ── Persona macros ──

  describe("persona macros", () => {
    it("renders active persona fields", () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        personaActive: true,
        personaName: "Alex",
        personaAppearance: "silver hair",
        personaPersonality: "reserved",
        personaBackstory: "from the old city",
      });

      expect(expandMacros("{{persona_name}}", world, state)).toBe("Alex");
      expect(expandMacros("{{persona}}", world, state)).toBe(
        "Name: Alex\nAppearance: silver hair\nPersonality: reserved\nBackstory: from the old city"
      );
    });

    it("renders every persona macro empty when personas are explicitly disabled", () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        personaActive: false,
        // Account fallback remains available to {{user}}, while these stale
        // values prove no persona-specific macro can leak them into a prompt.
        personaName: "account-name",
        personaAppearance: "stale appearance",
        personaPersonality: "stale personality",
        personaBackstory: "stale backstory",
      });

      expect(expandMacros("{{user}}", world, state)).toBe("account-name");
      expect(
        expandMacros(
          "{{persona_name}}{{persona_appearance}}{{persona_personality}}{{persona_backstory}}{{persona}}",
          world,
          state
        )
      ).toBe("");
    });
  });

  // ── {{trim}} ──

  describe("{{trim}}", () => {
    it("removes surrounding whitespace at trim markers", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(
        expandMacros("Hello   {{trim}}   World", world, state)
      ).toBe("HelloWorld");
    });

    it("handles trim at the beginning of a string", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{trim}}  Hello", world, state)).toBe("Hello");
    });

    it("handles trim at the end of a string", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("Hello  {{trim}}", world, state)).toBe("Hello");
    });

    it("handles multiple trim markers", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(
        expandMacros("A  {{trim}}  B  {{trim}}  C", world, state)
      ).toBe("ABC");
    });
  });

  // ── {{//comment}} ──

  describe("{{//comment}}", () => {
    it("removes comment macros from output", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(
        expandMacros("Hello{{//this is a comment}} World", world, state)
      ).toBe("Hello World");
    });

    it("handles multiple comments", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(
        expandMacros(
          "A{{// first comment}}B{{// second comment}}C",
          world,
          state
        )
      ).toBe("ABC");
    });

    it("removes empty comments", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{//}}", world, state)).toBe("");
    });
  });

  // ── {{turnCount}} ──

  describe("{{turnCount}}", () => {
    it("returns the current turn count", () => {
      const world = bareWorld();
      const state = createMockGameState({ turnCount: 5 });
      expect(expandMacros("Turn: {{turnCount}}", world, state)).toBe(
        "Turn: 5"
      );
    });

    it("returns 0 when turnCount is undefined", () => {
      const world = bareWorld();
      // GameState requires turnCount, but test via ?? 0 fallback
      const state = createMockGameState({ turnCount: 0 });
      expect(expandMacros("{{turnCount}}", world, state)).toBe("0");
    });
  });

  // ── {{date}} ──

  describe("{{date}}", () => {
    it("returns a date string", () => {
      const world = bareWorld();
      const state = createMockGameState();
      const result = expandMacros("{{date}}", world, state);
      // toLocaleDateString() returns a locale-dependent string
      // Just check it's non-empty and not the raw macro
      expect(result).not.toBe("{{date}}");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ── {{time}} ──

  describe("{{time}}", () => {
    it("returns a time in HH:MM format", () => {
      const world = bareWorld();
      const state = createMockGameState();
      const result = expandMacros("{{time}}", world, state);
      // Should match HH:MM pattern
      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });
  });

  // ── {{weekday}} ──

  describe("{{weekday}}", () => {
    it("returns a full weekday name", () => {
      const world = bareWorld();
      const state = createMockGameState();
      const result = expandMacros("{{weekday}}", world, state);
      const validDays = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      expect(validDays).toContain(result);
    });
  });

  // ── {{isodate}} ──

  describe("{{isodate}}", () => {
    it("returns a date in YYYY-MM-DD format", () => {
      const world = bareWorld();
      const state = createMockGameState();
      const result = expandMacros("{{isodate}}", world, state);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  // ── {{isotime}} ──

  describe("{{isotime}}", () => {
    it("returns a time in HH:MM:SS format", () => {
      const world = bareWorld();
      const state = createMockGameState();
      const result = expandMacros("{{isotime}}", world, state);
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });
  });

  // ── {{idle}} ──

  describe("{{idle}}", () => {
    it('returns "unknown" when no lastUserMessageAt metadata', () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{idle}}", world, state)).toBe("unknown");
    });

    it('returns "just now" when idle < 60 seconds', () => {
      const world = bareWorld();
      const now = new Date();
      const state = stateWithMetadata({
        lastUserMessageAt: new Date(now.getTime() - 10_000).toISOString(), // 10 seconds ago
      });
      expect(expandMacros("{{idle}}", world, state)).toBe("just now");
    });

    it('returns "1 minute" for exactly 1 minute idle', () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastUserMessageAt: new Date(
          Date.now() - 60_000 - 500 // slightly over 1 minute to ensure floor gives 1
        ).toISOString(),
      });
      expect(expandMacros("{{idle}}", world, state)).toBe("1 minute");
    });

    it("returns plural minutes", () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastUserMessageAt: new Date(
          Date.now() - 5 * 60_000
        ).toISOString(),
      });
      expect(expandMacros("{{idle}}", world, state)).toBe("5 minutes");
    });

    it('returns "1 hour" for exactly 1 hour idle', () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastUserMessageAt: new Date(
          Date.now() - 60 * 60_000 - 500
        ).toISOString(),
      });
      expect(expandMacros("{{idle}}", world, state)).toBe("1 hour");
    });

    it("returns plural hours", () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastUserMessageAt: new Date(
          Date.now() - 3 * 60 * 60_000
        ).toISOString(),
      });
      expect(expandMacros("{{idle}}", world, state)).toBe("3 hours");
    });

    it('returns "1 day" for exactly 1 day idle', () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastUserMessageAt: new Date(
          Date.now() - 24 * 60 * 60_000 - 500
        ).toISOString(),
      });
      expect(expandMacros("{{idle}}", world, state)).toBe("1 day");
    });

    it("returns plural days", () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastUserMessageAt: new Date(
          Date.now() - 7 * 24 * 60 * 60_000
        ).toISOString(),
      });
      expect(expandMacros("{{idle}}", world, state)).toBe("7 days");
    });

    it('returns "just now" for future timestamps (negative diff)', () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastUserMessageAt: new Date(
          Date.now() + 60_000
        ).toISOString(),
      });
      expect(expandMacros("{{idle}}", world, state)).toBe("just now");
    });
  });

  // ── {{lastMessage}} ──

  describe("{{lastMessage}}", () => {
    it("returns the last message from metadata", () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastMessage: "The dragon roars!",
      });
      expect(expandMacros("{{lastMessage}}", world, state)).toBe(
        "The dragon roars!"
      );
    });

    it("returns empty string when metadata not set", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{lastMessage}}", world, state)).toBe("");
    });
  });

  // ── {{lastUserMessage}} ──

  describe("{{lastUserMessage}}", () => {
    it("returns the last user message from metadata", () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastUserMessage: "I attack the goblin.",
      });
      expect(expandMacros("{{lastUserMessage}}", world, state)).toBe(
        "I attack the goblin."
      );
    });

    it("returns empty string when metadata not set", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{lastUserMessage}}", world, state)).toBe("");
    });
  });

  // ── {{lastCharMessage}} ──

  describe("{{lastCharMessage}}", () => {
    it("returns the last character message from metadata", () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        lastCharMessage: "The goblin dodges your attack.",
      });
      expect(expandMacros("{{lastCharMessage}}", world, state)).toBe(
        "The goblin dodges your attack."
      );
    });

    it("returns empty string when metadata not set", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{lastCharMessage}}", world, state)).toBe("");
    });
  });

  // ── {{model}} ──

  describe("{{model}}", () => {
    it("returns the model name from metadata", () => {
      const world = bareWorld();
      const state = stateWithMetadata({
        model: "google/gemini-3.1-pro-preview",
      });
      expect(expandMacros("{{model}}", world, state)).toBe(
        "google/gemini-3.1-pro-preview"
      );
    });

    it("returns empty string when model not set in metadata", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{model}}", world, state)).toBe("");
    });
  });

  // ── {{random::a::b::c}} ──

  describe("{{random::...}}", () => {
    it("returns one of the provided options", () => {
      const world = bareWorld();
      const state = createMockGameState();
      const options = ["alpha", "beta", "gamma"];
      const results = new Set<string>();
      // Run multiple times to collect possible outputs
      for (let i = 0; i < 100; i++) {
        const result = expandMacros(
          "{{random::alpha::beta::gamma}}",
          world,
          state
        );
        results.add(result);
        expect(options).toContain(result);
      }
      // With 100 iterations, we should have hit at least 2 options
      expect(results.size).toBeGreaterThanOrEqual(2);
    });

    it("handles a single option", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{random::only}}", world, state)).toBe("only");
    });
  });

  // ── {{pick::a::b::c}} ──

  describe("{{pick::...}}", () => {
    it("returns one of the provided options deterministically for same turnCount and macroIndex", () => {
      const world = bareWorld();
      const state = createMockGameState({ turnCount: 3 });
      const options = ["alpha", "beta", "gamma"];

      // Same input = same output
      const result1 = expandMacros("{{pick::alpha::beta::gamma}}", world, state);
      const result2 = expandMacros("{{pick::alpha::beta::gamma}}", world, state);
      expect(options).toContain(result1);
      expect(result1).toBe(result2);
    });

    it("produces different results for different turnCounts", () => {
      const world = bareWorld();
      const options = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const optionStr = options.join("::");
      const results = new Set<string>();
      for (let turn = 0; turn < 50; turn++) {
        const state = createMockGameState({ turnCount: turn });
        const result = expandMacros(`{{pick::${optionStr}}}`, world, state);
        expect(options).toContain(result);
        results.add(result);
      }
      // With 50 turns and 8 options, we should see variety
      expect(results.size).toBeGreaterThanOrEqual(2);
    });

    it("handles a single option", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{pick::only}}", world, state)).toBe("only");
    });
  });

  // ── {{roll::NdS}} ──

  describe("{{roll::NdS}}", () => {
    it("returns a number within the valid range for 1d6", () => {
      const world = bareWorld();
      const state = createMockGameState();
      for (let i = 0; i < 50; i++) {
        const result = parseInt(
          expandMacros("{{roll::1d6}}", world, state),
          10
        );
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(6);
      }
    });

    it("returns a number within the valid range for 2d10", () => {
      const world = bareWorld();
      const state = createMockGameState();
      for (let i = 0; i < 50; i++) {
        const result = parseInt(
          expandMacros("{{roll::2d10}}", world, state),
          10
        );
        expect(result).toBeGreaterThanOrEqual(2);
        expect(result).toBeLessThanOrEqual(20);
      }
    });

    it("handles positive modifier NdS+M", () => {
      const world = bareWorld();
      const state = createMockGameState();
      for (let i = 0; i < 50; i++) {
        const result = parseInt(
          expandMacros("{{roll::1d6+3}}", world, state),
          10
        );
        // 1d6 = [1..6], +3 => [4..9]
        expect(result).toBeGreaterThanOrEqual(4);
        expect(result).toBeLessThanOrEqual(9);
      }
    });

    it("handles negative modifier NdS-M", () => {
      const world = bareWorld();
      const state = createMockGameState();
      for (let i = 0; i < 50; i++) {
        const result = parseInt(
          expandMacros("{{roll::2d6-2}}", world, state),
          10
        );
        // 2d6 = [2..12], -2 => [0..10]
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(10);
      }
    });

    it("is case-insensitive for 'd'", () => {
      const world = bareWorld();
      const state = createMockGameState();
      const result = expandMacros("{{roll::1D6}}", world, state);
      const num = parseInt(result, 10);
      expect(num).toBeGreaterThanOrEqual(1);
      expect(num).toBeLessThanOrEqual(6);
    });

    it("leaves invalid roll expressions as literal macros", () => {
      const world = bareWorld();
      const state = createMockGameState();
      // Invalid: no 'd' separator
      expect(expandMacros("{{roll::abc}}", world, state)).toBe(
        "{{roll::abc}}"
      );
    });
  });

  // ── Variable fallback ──

  describe("variable fallback", () => {
    it("resolves a variable ID to its current value (number)", () => {
      const world = bareWorld();
      const state = createMockGameState({
        variables: { health: 75, gold: 100 },
      });
      expect(expandMacros("HP: {{health}}, Gold: {{gold}}", world, state)).toBe(
        "HP: 75, Gold: 100"
      );
    });

    it("resolves a variable ID to its current value (string)", () => {
      const world = bareWorld();
      const state = createMockGameState({
        variables: { playerClass: "Warrior" },
      });
      expect(expandMacros("Class: {{playerClass}}", world, state)).toBe(
        "Class: Warrior"
      );
    });

    it("resolves a variable ID to its current value (boolean)", () => {
      const world = bareWorld();
      const state = createMockGameState({
        variables: { isAlive: true },
      });
      expect(expandMacros("Alive: {{isAlive}}", world, state)).toBe(
        "Alive: true"
      );
    });

    it("does not resolve non-word-character variable names", () => {
      const world = bareWorld();
      const state = createMockGameState({
        variables: {},
      });
      // Contains spaces, not a valid word identifier
      expect(expandMacros("{{not a var}}", world, state)).toBe(
        "{{not a var}}"
      );
    });
  });

  // ── Unknown macros ──

  describe("unknown macros", () => {
    it("leaves unknown simple macros as literal text", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{unknownMacro}}", world, state)).toBe(
        "{{unknownMacro}}"
      );
    });

    it("leaves unknown macros with special characters as literal text", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{{some-thing}}", world, state)).toBe(
        "{{some-thing}}"
      );
    });
  });

  // ── Nested macros ──

  describe("nested / multiple macros", () => {
    it("expands multiple different macros in the same string", () => {
      const world = worldWithChar("Elara", "Bob");
      const state = createMockGameState({ turnCount: 3 });
      expect(
        expandMacros(
          "{{char}} greets {{user}} on turn {{turnCount}}.",
          world,
          state
        )
      ).toBe("Elara greets Bob on turn 3.");
    });

    it("expands repeated macros", () => {
      const world = worldWithChar("Luna");
      const state = createMockGameState();
      expect(
        expandMacros("{{char}} says: I am {{char}}!", world, state)
      ).toBe("Luna says: I am Luna!");
    });

    it("handles macros adjacent to each other", () => {
      const world = worldWithChar("A", "B");
      const state = createMockGameState();
      expect(expandMacros("{{char}}{{user}}", world, state)).toBe("AB");
    });
  });

  // ── Trim + other macros ──

  describe("trim with other macros", () => {
    it("trim collapses whitespace between other macro expansions", () => {
      const world = worldWithChar("Elara");
      const state = createMockGameState();
      expect(
        expandMacros("{{char}}   {{trim}}   says hi", world, state)
      ).toBe("Elarasays hi");
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("handles empty template string", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("", world, state)).toBe("");
    });

    it("handles template with no macros", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("Just plain text.", world, state)).toBe(
        "Just plain text."
      );
    });

    it("handles single braces (not macros)", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(expandMacros("{notAMacro}", world, state)).toBe("{notAMacro}");
    });

    it("handles triple braces (no match due to nested brace rejection)", () => {
      const world = worldWithChar("Zara");
      const state = createMockGameState();
      // {{{char}}} — the macro regex rejects inner content containing }}
      // so it cannot match anything and the text is left as-is
      expect(expandMacros("{{{char}}}", world, state)).toBe("{{{char}}}");
    });

    it("handles empty macro braces", () => {
      const world = bareWorld();
      const state = createMockGameState();
      // {{}} — inner is "", not a word, so left as literal
      expect(expandMacros("{{}}", world, state)).toBe("{{}}");
    });

    it("variable value of 0 is resolved (not treated as undefined)", () => {
      const world = bareWorld();
      const state = createMockGameState({
        variables: { score: 0 },
      });
      expect(expandMacros("Score: {{score}}", world, state)).toBe("Score: 0");
    });

    it("variable value of false is resolved (not treated as undefined)", () => {
      const world = bareWorld();
      const state = createMockGameState({
        variables: { flag: false },
      });
      expect(expandMacros("Flag: {{flag}}", world, state)).toBe("Flag: false");
    });

    it("variable value of empty string is resolved (not treated as undefined)", () => {
      const world = bareWorld();
      const state = createMockGameState({
        variables: { name: "" },
      });
      expect(expandMacros("Name: {{name}}", world, state)).toBe("Name: ");
    });
  });

  // ── Handler priority (first match wins) ──

  describe("handler priority", () => {
    it("built-in macros take precedence over variable fallback", () => {
      // If there's a variable named "char", the {{char}} handler wins
      const world = worldWithChar("Elara");
      const state = createMockGameState({
        variables: { char: "should-not-appear" },
      });
      expect(expandMacros("{{char}}", world, state)).toBe("Elara");
    });

    it("built-in macros take precedence over variable for 'user'", () => {
      const world = worldWithChar("NPC", "Alice");
      const state = createMockGameState({
        variables: { user: "should-not-appear" },
      });
      expect(expandMacros("{{user}}", world, state)).toBe("Alice");
    });

    it("built-in macros take precedence over variable for 'turnCount'", () => {
      const world = bareWorld();
      const state = createMockGameState({
        turnCount: 7,
        variables: { turnCount: 999 },
      });
      expect(expandMacros("{{turnCount}}", world, state)).toBe("7");
    });
  });

  // ── Comment edge cases ──

  describe("comment edge cases", () => {
    it("only matches comments that start with //", () => {
      const world = bareWorld();
      const state = createMockGameState();
      // This is a regular unknown macro, not a comment
      expect(expandMacros("{{/ not a comment}}", world, state)).toBe(
        "{{/ not a comment}}"
      );
    });

    it("preserves text around comments", () => {
      const world = bareWorld();
      const state = createMockGameState();
      expect(
        expandMacros(
          "before{{// removed}}after",
          world,
          state
        )
      ).toBe("beforeafter");
    });
  });

  // ── Random with special characters ──

  describe("random with various content", () => {
    it("handles options containing spaces", () => {
      const world = bareWorld();
      const state = createMockGameState();
      const options = ["option one", "option two"];
      for (let i = 0; i < 50; i++) {
        const result = expandMacros(
          "{{random::option one::option two}}",
          world,
          state
        );
        expect(options).toContain(result);
      }
    });
  });

  // ── Pick determinism ──

  describe("pick determinism details", () => {
    it("different macro positions produce different picks even in same template", () => {
      const world = bareWorld();
      const state = createMockGameState({ turnCount: 42 });
      // Two pick macros in the same template — they should have different macroIndex
      // values, so they may (and usually do) produce different results
      const template = "{{pick::a::b::c::d::e::f::g::h}} and {{pick::a::b::c::d::e::f::g::h}}";
      // Run a few times to verify they're not always the same
      const results: string[] = [];
      for (let i = 0; i < 5; i++) {
        // turnCount changes produce different results
        const st = createMockGameState({ turnCount: i });
        results.push(expandMacros(template, world, st));
      }
      // At least one result should have different picks for the two positions
      const hasDifferentPicks = results.some((r) => {
        const parts = r.split(" and ");
        return parts[0] !== parts[1];
      });
      expect(hasDifferentPicks).toBe(true);
    });
  });

  // ── Roll edge case ──

  describe("roll edge cases", () => {
    it("handles large dice expressions", () => {
      const world = bareWorld();
      const state = createMockGameState();
      for (let i = 0; i < 20; i++) {
        const result = parseInt(
          expandMacros("{{roll::10d100}}", world, state),
          10
        );
        expect(result).toBeGreaterThanOrEqual(10);
        expect(result).toBeLessThanOrEqual(1000);
      }
    });

    it("returns a numeric string", () => {
      const world = bareWorld();
      const state = createMockGameState();
      const result = expandMacros("{{roll::3d6}}", world, state);
      expect(result).toMatch(/^-?\d+$/);
    });
  });
});
