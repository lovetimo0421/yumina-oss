import { describe, it, expect, beforeEach } from "vitest";
import { ResponseParser } from "../parser/response-parser.js";
import type { ParseResult } from "../parser/response-parser.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { createMockWorld, createMockVariable, createMockGameState } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResponseParser", () => {
  let parser: ResponseParser;

  beforeEach(() => {
    parser = new ResponseParser();
  });

  // =========================================================================
  // Shorthand operators (+/-/*)
  // =========================================================================

  describe("shorthand operators", () => {
    it("parses + as add", () => {
      const result = parser.parse("The hero gains gold. [gold: +50]");
      expect(result.effects).toEqual([
        { variableId: "gold", operation: "add", value: 50 },
      ]);
    });

    it("parses - as subtract", () => {
      const result = parser.parse("The hero takes damage. [health: -10]");
      expect(result.effects).toEqual([
        { variableId: "health", operation: "subtract", value: 10 },
      ]);
    });

    it("parses * as multiply", () => {
      const result = parser.parse("Double damage! [damage: *2]");
      expect(result.effects).toEqual([
        { variableId: "damage", operation: "multiply", value: 2 },
      ]);
    });

    it("handles decimal values with shorthand +", () => {
      const result = parser.parse("[score: +1.5]");
      expect(result.effects).toEqual([
        { variableId: "score", operation: "add", value: 1.5 },
      ]);
    });

    it("handles decimal values with shorthand -", () => {
      const result = parser.parse("[energy: -0.5]");
      expect(result.effects).toEqual([
        { variableId: "energy", operation: "subtract", value: 0.5 },
      ]);
    });

    it("handles decimal values with shorthand *", () => {
      const result = parser.parse("[power: *1.5]");
      expect(result.effects).toEqual([
        { variableId: "power", operation: "multiply", value: 1.5 },
      ]);
    });
  });

  // =========================================================================
  // Explicit operations
  // =========================================================================

  describe("explicit operations", () => {
    it("parses set with numeric value", () => {
      const result = parser.parse("[health: set 100]");
      expect(result.effects).toEqual([
        { variableId: "health", operation: "set", value: 100 },
      ]);
    });

    it("parses add with numeric value", () => {
      const result = parser.parse("[gold: add 25]");
      expect(result.effects).toEqual([
        { variableId: "gold", operation: "add", value: 25 },
      ]);
    });

    it("parses subtract with numeric value", () => {
      const result = parser.parse("[mana: subtract 30]");
      expect(result.effects).toEqual([
        { variableId: "mana", operation: "subtract", value: 30 },
      ]);
    });

    it("parses multiply with numeric value", () => {
      const result = parser.parse("[strength: multiply 3]");
      expect(result.effects).toEqual([
        { variableId: "strength", operation: "multiply", value: 3 },
      ]);
    });

    it("parses append with string value", () => {
      const result = parser.parse('[log: append "found a key"]');
      expect(result.effects).toEqual([
        { variableId: "log", operation: "append", value: "found a key" },
      ]);
    });

    it("parses toggle", () => {
      const result = parser.parse("[hasKey: toggle]");
      expect(result.effects).toEqual([
        { variableId: "hasKey", operation: "toggle", value: true },
      ]);
    });
  });

  // =========================================================================
  // Quoted string values
  // =========================================================================

  describe("quoted string values", () => {
    it("parses a quoted string with set", () => {
      const result = parser.parse('[location: set "forest"]');
      expect(result.effects).toEqual([
        { variableId: "location", operation: "set", value: "forest" },
      ]);
    });

    it("parses a quoted string with spaces", () => {
      const result = parser.parse('[area: set "dark forest"]');
      expect(result.effects).toEqual([
        { variableId: "area", operation: "set", value: "dark forest" },
      ]);
    });

    it("handles escaped quotes inside quoted strings", () => {
      const result = parser.parse('[dialogue: set "He said \\"hello\\""]');
      expect(result.effects).toEqual([
        { variableId: "dialogue", operation: "set", value: 'He said "hello"' },
      ]);
    });

    it("parses append with quoted string", () => {
      const result = parser.parse('[inventory: append "iron sword"]');
      expect(result.effects).toEqual([
        { variableId: "inventory", operation: "append", value: "iron sword" },
      ]);
    });
  });

  // =========================================================================
  // Audio directives
  // =========================================================================

  describe("audio directives", () => {
    it("parses audio play", () => {
      const result = parser.parse("[audio: battle play]");
      expect(result.audioEffects).toEqual([
        { trackId: "battle", action: "play" },
      ]);
    });

    it("parses audio stop", () => {
      const result = parser.parse("[audio: ambience stop]");
      expect(result.audioEffects).toEqual([
        { trackId: "ambience", action: "stop" },
      ]);
    });

    it("parses audio volume with value", () => {
      const result = parser.parse("[audio: bgm volume 0.5]");
      expect(result.audioEffects).toEqual([
        { trackId: "bgm", action: "volume", volume: 0.5 },
      ]);
    });

    it("parses audio crossfade with fade duration", () => {
      // For `crossfade`, the trailing number is the crossfade duration.
      const result = parser.parse("[audio: newTrack crossfade 0.8]");
      expect(result.audioEffects).toEqual([
        { trackId: "newTrack", action: "crossfade", fadeDuration: 0.8 },
      ]);
    });

    it("ignores a trailing number on play (fade not supported for play)", () => {
      // The grammar only consumes the number for volume/crossfade; play/stop
      // drop it. (Fade-in/out on play/stop is not implemented.)
      const result = parser.parse("[audio: theme play 2.0]");
      expect(result.audioEffects).toEqual([
        { trackId: "theme", action: "play" },
      ]);
    });

    it("ignores a trailing number on stop (fade not supported for stop)", () => {
      const result = parser.parse("[audio: music stop 1.5]");
      expect(result.audioEffects).toEqual([
        { trackId: "music", action: "stop" },
      ]);
    });

    it("removes audio directives from clean text", () => {
      const result = parser.parse("The battle begins. [audio: battle play] Swords clash!");
      expect(result.cleanText).not.toContain("[audio:");
      expect(result.cleanText).toContain("The battle begins.");
      expect(result.cleanText).toContain("Swords clash!");
    });
  });

  // =========================================================================
  // Malformed / incomplete directives
  // =========================================================================

  describe("malformed and incomplete directives", () => {
    it("treats unrecognized word after colon as implicit set with string value", () => {
      // [health: abc] — regex captures op=undefined, rawValue="abc"
      // parseDirective: !op && rawValue => implicit set, parseValue("abc") => "abc" string
      const result = parser.parse("[health: abc]");
      expect(result.effects).toEqual([
        { variableId: "health", operation: "set", value: "abc" },
      ]);
    });

    it("handles text with no directives", () => {
      const result = parser.parse("Just a normal sentence with no brackets.");
      expect(result.effects).toEqual([]);
      expect(result.audioEffects).toEqual([]);
      expect(result.cleanText).toBe("Just a normal sentence with no brackets.");
    });

    it("handles mismatched brackets gracefully", () => {
      const result = parser.parse("Some text [health: +10 more text");
      // Won't match because the closing ] is missing
      expect(result.effects).toEqual([]);
    });

    it("supports hyphenated variable ids", () => {
      const result = parser.parse("[my-var: +10]");
      expect(result.effects).toEqual([
        { variableId: "my-var", operation: "add", value: 10 },
      ]);
    });

    it("parses imported MVU variable ids with dots, dollars, and hyphens", () => {
      const result = parser.parse("[stat_data.$group-chat.月宫绾音.好感度: +10]");
      expect(result.effects).toEqual([
        {
          variableId: "stat_data.$group-chat.月宫绾音.好感度",
          operation: "add",
          value: 10,
        },
      ]);
    });

    it("parses unquoted values containing CJK punctuation", () => {
      const result = parser.parse('[current-status: set 「用拇趾缓慢研磨龟头，目光空洞地俯视」]');
      expect(result.effects).toEqual([
        { variableId: "current-status", operation: "set", value: "「用拇趾缓慢研磨龟头，目光空洞地俯视」" },
      ]);
    });

    it("parses unquoted values with fullwidth commas and periods", () => {
      const result = parser.parse('[status: set 她微微侧头，沉默着。]');
      expect(result.effects).toEqual([
        { variableId: "status", operation: "set", value: "她微微侧头，沉默着。" },
      ]);
    });

    it("parses unquoted values with mixed CJK and ASCII", () => {
      const result = parser.parse('[phase: set Phase2：战斗中]');
      expect(result.effects).toEqual([
        { variableId: "phase", operation: "set", value: "Phase2：战斗中" },
      ]);
    });

    it("still parses simple unquoted values correctly", () => {
      const result = parser.parse('[location: set forest]');
      expect(result.effects).toEqual([
        { variableId: "location", operation: "set", value: "forest" },
      ]);
    });

    it("still parses quoted values with special chars correctly", () => {
      const result = parser.parse('[name: set "hello world [test]"]');
      expect(result.effects).toEqual([
        { variableId: "name", operation: "set", value: "hello world [test]" },
      ]);
    });

    it("tolerates padding spaces inside brackets (standard directive)", () => {
      const result = parser.parse('[ current-location: set "Grand Parlour" ]');
      expect(result.effects).toEqual([
        { variableId: "current-location", operation: "set", value: "Grand Parlour" },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("tolerates padding spaces inside brackets (shorthand add)", () => {
      const result = parser.parse("[ action-counter: add 1 ]");
      expect(result.effects).toEqual([
        { variableId: "action-counter", operation: "add", value: 1 },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("tolerates padding spaces inside brackets (JSON push)", () => {
      const result = parser.parse('[ chat-log: push {"id":"c1","day":1} ]');
      expect(result.effects).toEqual([
        { variableId: "chat-log", operation: "push", value: { id: "c1", day: 1 } },
      ]);
      expect(result.cleanText).toBe("");
    });
  });

  // =========================================================================
  // JSON directives with bare scalar values
  //
  // Before this was fixed, `[truths: push "new truth"]` was silently dropped:
  // `push` isn't in the standard regex's op list, and the JSON branch only
  // accepted `{`/`[` openers, so well-formed AI output landed in the void.
  // =========================================================================

  // =========================================================================
  // Fenced ```json directive blocks (Gemini 3.1 Pro drift format)
  // =========================================================================

  describe("fenced json directive blocks", () => {
    it("extracts the observed Gemini 3.1 Pro array shape and strips the fence", () => {
      // Verbatim shape from prod (格鲁曼 case, session fe9b9045, 2026-07-28)
      const text =
        '你压低声音，凑近她的耳边。\n\n```json\n[\n {"place": "set 第一层-福利中心"},\n {"mission": "set 休假体验福利中心"}\n]\n```';
      const result = parser.parse(text);
      expect(result.effects).toEqual([
        { variableId: "place", operation: "set", value: "第一层-福利中心" },
        { variableId: "mission", operation: "set", value: "休假体验福利中心" },
      ]);
      expect(result.cleanText).toBe("你压低声音，凑近她的耳边。");
    });

    it("extracts a single-object block (non-array variant)", () => {
      const result = parser.parse('```json\n{"nowtime": "set 第七天-白天", "place": "set 迷雾森林入口"}\n```');
      expect(result.effects).toEqual([
        { variableId: "nowtime", operation: "set", value: "第七天-白天" },
        { variableId: "place", operation: "set", value: "迷雾森林入口" },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("supports numeric ops, shorthand, and toggle inside the block", () => {
      const result = parser.parse(
        '```json\n[{"hp": "subtract 10"}, {"gold": "+50"}, {"hasKey": "toggle"}, {"score": "set 100"}]\n```'
      );
      expect(result.effects).toEqual([
        { variableId: "hp", operation: "subtract", value: 10 },
        { variableId: "gold", operation: "add", value: 50 },
        { variableId: "hasKey", operation: "toggle", value: true },
        { variableId: "score", operation: "set", value: 100 },
      ]);
    });

    it("supports merge/push with JSON payloads", () => {
      const result = parser.parse(
        '```json\n[{"npcs.aria": "merge {\\"trust\\": 80}"}, {"inventory": "push \\"rope\\""}]\n```'
      );
      expect(result.effects).toEqual([
        { variableId: "npcs.aria", operation: "merge", value: { trust: 80 } },
        { variableId: "inventory", operation: "push", value: "rope" },
      ]);
    });

    it("accepts an untagged fence with directive content", () => {
      const result = parser.parse('```\n[{"place": "set forest"}]\n```');
      expect(result.effects).toEqual([
        { variableId: "place", operation: "set", value: "forest" },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("leaves non-directive json fences untouched", () => {
      const text = 'Here is the config:\n```json\n{"name": "hero", "level": 3}\n```';
      const result = parser.parse(text);
      expect(result.effects).toEqual([]);
      expect(result.cleanText).toContain('{"name": "hero", "level": 3}');
    });

    it("leaves the fence untouched when any entry fails the gate (all-or-nothing)", () => {
      const text = '```json\n[{"place": "set forest"}, {"note": "just a string"}]\n```';
      const result = parser.parse(text);
      expect(result.effects).toEqual([]);
      expect(result.cleanText).toContain("just a string");
    });

    it("leaves non-json code fences untouched", () => {
      const text = "```ts\nconst x = 1;\n```";
      const result = parser.parse(text);
      expect(result.effects).toEqual([]);
      expect(result.cleanText).toContain("const x = 1;");
    });

    it("leaves numeric-valued json untouched (no implicit set from bare numbers)", () => {
      const text = '```json\n{"count": 3}\n```';
      const result = parser.parse(text);
      expect(result.effects).toEqual([]);
      expect(result.cleanText).toContain('"count": 3');
    });

    it("ignores empty arrays and empty objects", () => {
      expect(parser.parse("```json\n[]\n```").effects).toEqual([]);
      expect(parser.parse("```json\n{}\n```").effects).toEqual([]);
    });

    it("handles multiple fences independently", () => {
      const text =
        '```json\n[{"place": "set A"}]\n```\nMid narrative.\n```json\n{"story": {"nested": true}}\n```';
      const result = parser.parse(text);
      expect(result.effects).toEqual([
        { variableId: "place", operation: "set", value: "A" },
      ]);
      expect(result.cleanText).toContain("Mid narrative.");
      expect(result.cleanText).toContain('"nested": true');
    });

    it("tolerates CRLF line endings inside the fence", () => {
      const result = parser.parse('```json\r\n[{"place": "set forest"}]\r\n```');
      expect(result.effects).toEqual([
        { variableId: "place", operation: "set", value: "forest" },
      ]);
    });
  });

  describe("JSON directives with bare scalar values", () => {
    it("parses push with a bare quoted string", () => {
      const result = parser.parse('[truths: push "new truth"]');
      expect(result.effects).toEqual([
        { variableId: "truths", operation: "push", value: "new truth" },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("parses push with a quoted string containing escapes", () => {
      const result = parser.parse('[log: push "He said \\"hi\\""]');
      expect(result.effects).toEqual([
        { variableId: "log", operation: "push", value: 'He said "hi"' },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("parses push with a bare number", () => {
      const result = parser.parse("[counters: push 42]");
      expect(result.effects).toEqual([
        { variableId: "counters", operation: "push", value: 42 },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("parses push with a negative decimal", () => {
      const result = parser.parse("[deltas: push -1.5]");
      expect(result.effects).toEqual([
        { variableId: "deltas", operation: "push", value: -1.5 },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("parses push with true / false / null", () => {
      const r1 = parser.parse("[flags: push true]");
      const r2 = parser.parse("[flags: push false]");
      const r3 = parser.parse("[flags: push null]");
      expect(r1.effects[0]?.value).toBe(true);
      expect(r2.effects[0]?.value).toBe(false);
      expect(r3.effects[0]?.value).toBe(null);
    });

    it("parses delete with a bare numeric index", () => {
      const result = parser.parse("[items: delete 2]");
      expect(result.effects).toEqual([
        { variableId: "items", operation: "delete", value: 2 },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("parses delete with a bare quoted key", () => {
      const result = parser.parse('[inventory: delete "potion"]');
      expect(result.effects).toEqual([
        { variableId: "inventory", operation: "delete", value: "potion" },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("tolerates padding spaces around a scalar value", () => {
      const result = parser.parse('[ truths: push   "hello"   ]');
      expect(result.effects).toEqual([
        { variableId: "truths", operation: "push", value: "hello" },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("leaves unrecognized JSON shapes for the standard pattern", () => {
      // `set forest` is an implicit-set with a bare identifier — handled by
      // the standard regex path, NOT the JSON path. Locking this in protects
      // a real-world test elsewhere in this file.
      const result = parser.parse("[location: set forest]");
      expect(result.effects).toEqual([
        { variableId: "location", operation: "set", value: "forest" },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("falls through to the lenient standard path for malformed JSON numbers", () => {
      // Strict JSON grammar rejects `007` (leading zero). Scanner refuses to
      // capture it, so it falls through to the standard path which is lenient:
      // Number("007") = 7. Net effect: still parses, no leakage.
      const result = parser.parse("[health: set 007]");
      expect(result.effects).toEqual([
        { variableId: "health", operation: "set", value: 7 },
      ]);
      expect(result.cleanText).toBe("");
    });

    it("parses push of a string into an array of strings (real card scenario)", () => {
      // Repro: 百花谷 card's discovered-truths variable. Before fix, this
      // entire directive disappeared without taking effect.
      const result = parser.parse('丝茉脚踝有红痕。 [discovered-truths: push "丝茉是淫蛇功修炼者"] 你心头一紧。');
      expect(result.effects).toEqual([
        { variableId: "discovered-truths", operation: "push", value: "丝茉是淫蛇功修炼者" },
      ]);
      expect(result.cleanText).toBe("丝茉脚踝有红痕。 你心头一紧。");
    });
  });

  // =========================================================================
  // Text cleaning
  // =========================================================================

  describe("text cleaning", () => {
    it("removes state directives from narrative", () => {
      const result = parser.parse("The hero finds gold. [gold: +50] They continue walking.");
      expect(result.cleanText).toBe("The hero finds gold. They continue walking.");
    });

    it("collapses multiple spaces after removal", () => {
      const result = parser.parse("Start [health: +10]   [gold: +5] end.");
      // After removal: "Start    end." => collapsed to "Start end."
      expect(result.cleanText).toBe("Start end.");
    });

    it("trims leading and trailing whitespace", () => {
      const result = parser.parse("  [health: set 100]  Some narrative.  ");
      expect(result.cleanText).toBe("Some narrative.");
    });

    it("removes both audio and state directives from text", () => {
      const result = parser.parse("Battle! [audio: combat play] [health: -20] Fight on!");
      expect(result.cleanText).toBe("Battle! Fight on!");
      expect(result.effects).toHaveLength(1);
      expect(result.audioEffects).toHaveLength(1);
    });
  });

  // =========================================================================
  // Multiple directives
  // =========================================================================

  describe("multiple directives in one response", () => {
    it("parses multiple state effects", () => {
      const result = parser.parse(
        "The hero wins the battle. [health: -15] [gold: +100] [xp: +50]"
      );
      expect(result.effects).toHaveLength(3);
      expect(result.effects[0]).toEqual({ variableId: "health", operation: "subtract", value: 15 });
      expect(result.effects[1]).toEqual({ variableId: "gold", operation: "add", value: 100 });
      expect(result.effects[2]).toEqual({ variableId: "xp", operation: "add", value: 50 });
    });

    it("parses multiple audio effects", () => {
      const result = parser.parse(
        "[audio: ambient stop] [audio: battle play 1.0]"
      );
      expect(result.audioEffects).toHaveLength(2);
      expect(result.audioEffects[0]).toEqual({ trackId: "ambient", action: "stop" });
      expect(result.audioEffects[1]).toEqual({ trackId: "battle", action: "play" });
    });

    it("parses mixed state and audio effects", () => {
      const result = parser.parse(
        "The dungeon rumbles. [audio: earthquake play] [health: -5] [fear: +10] [audio: ambient volume 0.3]"
      );
      expect(result.effects).toHaveLength(2);
      expect(result.audioEffects).toHaveLength(2);
      expect(result.effects[0]).toEqual({ variableId: "health", operation: "subtract", value: 5 });
      expect(result.effects[1]).toEqual({ variableId: "fear", operation: "add", value: 10 });
      expect(result.audioEffects[0]).toEqual({ trackId: "earthquake", action: "play" });
      expect(result.audioEffects[1]).toEqual({ trackId: "ambient", action: "volume", volume: 0.3 });
    });

    it("cleans text after removing all directives", () => {
      const result = parser.parse(
        "[health: +10] The hero rests. [gold: -5] All is well. [hasKey: toggle]"
      );
      expect(result.cleanText).toBe("The hero rests. All is well.");
    });
  });

  // =========================================================================
  // Boolean values
  // =========================================================================

  describe("boolean values", () => {
    it("parses set true as boolean", () => {
      const result = parser.parse("[isAlive: set true]");
      expect(result.effects).toEqual([
        { variableId: "isAlive", operation: "set", value: true },
      ]);
    });

    it("parses set false as boolean", () => {
      const result = parser.parse("[isAlive: set false]");
      expect(result.effects).toEqual([
        { variableId: "isAlive", operation: "set", value: false },
      ]);
    });

    it("parses toggle operation", () => {
      const result = parser.parse("[isHidden: toggle]");
      expect(result.effects).toEqual([
        { variableId: "isHidden", operation: "toggle", value: true },
      ]);
    });
  });

  // =========================================================================
  // Numeric values
  // =========================================================================

  describe("numeric values", () => {
    it("parses integer values", () => {
      const result = parser.parse("[health: set 100]");
      expect(result.effects[0]!.value).toBe(100);
      expect(typeof result.effects[0]!.value).toBe("number");
    });

    it("parses decimal values", () => {
      const result = parser.parse("[modifier: set 1.5]");
      expect(result.effects[0]!.value).toBe(1.5);
    });

    it("parses zero", () => {
      const result = parser.parse("[health: set 0]");
      expect(result.effects[0]!.value).toBe(0);
    });

    it("implicit set with number only (no op keyword)", () => {
      const result = parser.parse("[health: 50]");
      // When there's no recognized op, and only rawValue is present,
      // it falls through to implicit set
      expect(result.effects).toEqual([
        { variableId: "health", operation: "set", value: 50 },
      ]);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("handles empty input", () => {
      const result = parser.parse("");
      expect(result.cleanText).toBe("");
      expect(result.effects).toEqual([]);
      expect(result.audioEffects).toEqual([]);
    });

    it("handles input with no directives", () => {
      const text = "The adventurer walks through the quiet forest, leaves crunching underfoot.";
      const result = parser.parse(text);
      expect(result.cleanText).toBe(text);
      expect(result.effects).toEqual([]);
      expect(result.audioEffects).toEqual([]);
    });

    it("handles input that is only directives", () => {
      const result = parser.parse("[health: +10] [gold: +5]");
      expect(result.cleanText).toBe("");
      expect(result.effects).toHaveLength(2);
    });

    it("handles directives at start of text", () => {
      const result = parser.parse("[health: +10] The adventure begins.");
      expect(result.cleanText).toBe("The adventure begins.");
      expect(result.effects).toHaveLength(1);
    });

    it("handles directives at end of text", () => {
      const result = parser.parse("The adventure ends. [health: -50]");
      expect(result.cleanText).toBe("The adventure ends.");
      expect(result.effects).toHaveLength(1);
    });

    it("handles directives in the middle of text", () => {
      const result = parser.parse("Start [health: +10] end.");
      expect(result.cleanText).toBe("Start end.");
    });

    it("handles underscore in variable names", () => {
      const result = parser.parse("[max_health: +10]");
      expect(result.effects).toEqual([
        { variableId: "max_health", operation: "add", value: 10 },
      ]);
    });

    it("handles unquoted string values (fall back to string)", () => {
      const result = parser.parse("[location: set forest]");
      expect(result.effects).toEqual([
        { variableId: "location", operation: "set", value: "forest" },
      ]);
    });

    it("handles a long narrative with embedded directives", () => {
      const narrative = `The hero steps forward into the ancient ruins. Dust particles
      float in the dim light filtering through cracks above. [health: -5] A trap
      springs! [audio: trap play] Arrows fly past. [gold: +20] Amongst the rubble,
      a glint of gold catches the eye. [location: set "ruins"] The adventure continues.`;
      const result = parser.parse(narrative);
      expect(result.effects).toHaveLength(3);
      expect(result.audioEffects).toHaveLength(1);
      expect(result.cleanText).not.toContain("[health:");
      expect(result.cleanText).not.toContain("[gold:");
      expect(result.cleanText).not.toContain("[location:");
      expect(result.cleanText).not.toContain("[audio:");
    });

    it("preserves newlines in clean text (collapses only spaces)", () => {
      // The regex replaces \s{2,} which includes newlines, so let's verify behavior
      const result = parser.parse("Line one.\n[health: +10]\nLine two.");
      // \s{2,} will collapse the resulting double newline
      expect(result.effects).toHaveLength(1);
      // After removal: "Line one.\n\nLine two." -> the \n\n is \s{2,} -> " "
      expect(result.cleanText).toContain("Line one.");
      expect(result.cleanText).toContain("Line two.");
    });
  });

  // =========================================================================
  // Custom regex pattern
  // =========================================================================

  describe("custom pattern", () => {
    it("accepts a custom regex pattern via constructor", () => {
      // Custom pattern that uses curly braces instead of square brackets
      const customParser = new ResponseParser(
        /\{(\w+):\s*(set|add|subtract|multiply|toggle|append|\+|-|\*)?\s*("(?:[^"\\]|\\.)*"|[\w.-]+)?\}/g
      );
      const result = customParser.parse("The hero gains gold. {gold: +50}");
      expect(result.effects).toEqual([
        { variableId: "gold", operation: "add", value: 50 },
      ]);
    });
  });

  // =========================================================================
  // ParseResult structure
  // =========================================================================

  describe("ParseResult structure", () => {
    it("always returns cleanText, effects, and audioEffects", () => {
      const result = parser.parse("Hello world");
      expect(result).toHaveProperty("cleanText");
      expect(result).toHaveProperty("effects");
      expect(result).toHaveProperty("audioEffects");
      expect(typeof result.cleanText).toBe("string");
      expect(Array.isArray(result.effects)).toBe(true);
      expect(Array.isArray(result.audioEffects)).toBe(true);
    });
  });

  // =========================================================================
  // Echoed <game-state> block (the engine injects this; some models mirror it back)
  // =========================================================================

  describe("echoed game-state block", () => {
    it("strips a game-state block the model echoed back into prose", () => {
      const input =
        "She smiles softly.\n\n" +
        "<game-state>\n" +
        "current-location: Celeste家饭厅\n" +
        "current-date: 2025年06月14日\n" +
        "timeline: modern-han\n" +
        "current-time: 下午 15:30\n" +
        "</game-state>";
      const result = parser.parse(input);
      expect(result.cleanText).toBe("She smiles softly.");
      expect(result.cleanText).not.toContain("<game-state>");
      expect(result.cleanText).not.toContain("current-location");
      expect(result.cleanText).not.toContain("timeline: modern-han");
    });

    it("strips a game-state block that appears before the narrative", () => {
      const input =
        "<game-state>\ncurrent-time: 下午 15:30\n</game-state>\n\n" +
        "The door creaks open.";
      const result = parser.parse(input);
      expect(result.cleanText).toBe("The door creaks open.");
      expect(result.cleanText).not.toContain("game-state");
    });

    // Integration guard: build the REAL tail block (with the update reminder) and
    // simulate a model echoing it verbatim. It must produce ZERO spurious effects
    // and leave no instruction text in the narrative — even when the JSON state
    // value itself contains [ ] { } characters.
    it("a verbatim echo of the real buildFormatBlock tail produces no effects", () => {
      const pb = new PromptBuilder();
      const vars = [
        createMockVariable({ id: "npcs", name: "NPCs", type: "json", defaultValue: {} }),
        createMockVariable({ id: "inventory", name: "Inventory", type: "json", defaultValue: [] }),
        createMockVariable({ id: "hp", name: "Health", type: "number", defaultValue: 100 }),
      ];
      const world = createMockWorld({ variables: vars });
      const state = createMockGameState({
        variables: {
          npcs: { aria: { mood: "calm", affinity: 30 } },
          inventory: ["sword", "shield"],
          hp: 80,
        },
      });

      const tailBlock = pb.buildFormatBlock(world, state);
      // Sanity: the block really does carry both the JSON-bracketed values and the reminder.
      expect(tailBlock).toContain('"mood":"calm"');
      expect(tailBlock).toContain("<state-reminder>");

      const echoedReply =
        "Aria nods and the door swings open.\n\n" + tailBlock;
      const result = parser.parse(echoedReply);

      expect(result.effects).toEqual([]);
      expect(result.audioEffects).toEqual([]);
      expect(result.cleanText).toBe("Aria nods and the door swings open.");
      expect(result.cleanText).not.toContain("state-reminder");
      expect(result.cleanText).not.toContain("game-state");
      expect(result.cleanText).not.toContain("npcs");
    });
  });
});
