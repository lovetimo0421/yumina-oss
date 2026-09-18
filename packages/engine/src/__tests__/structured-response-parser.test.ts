import { describe, it, expect } from "vitest";
import { StructuredResponseParser } from "../parser/structured-response-parser.js";

describe("StructuredResponseParser", () => {
  const parser = new StructuredResponseParser();

  // ===========================================================================
  // isStructuredResponse
  // ===========================================================================

  describe("isStructuredResponse", () => {
    it("returns true for valid JSON with narrative and stateChanges", () => {
      const text = JSON.stringify({
        narrative: "The hero enters the cave.",
        stateChanges: [
          { variableId: "hp", operation: "set", value: 100 },
        ],
      });
      expect(parser.isStructuredResponse(text)).toBe(true);
    });

    it("returns true for valid JSON with narrative only (no stateChanges)", () => {
      const text = JSON.stringify({
        narrative: "A quiet scene unfolds.",
      });
      expect(parser.isStructuredResponse(text)).toBe(true);
    });

    it("returns false for plain text", () => {
      expect(parser.isStructuredResponse("The hero enters the cave.")).toBe(false);
    });

    it("returns false for JSON without narrative field", () => {
      const text = JSON.stringify({
        description: "No narrative here",
        stateChanges: [],
      });
      expect(parser.isStructuredResponse(text)).toBe(false);
    });

    it("returns false for malformed JSON with no narrative field", () => {
      // Starts with "{" but is not parseable and has no `"narrative":` pattern.
      expect(parser.isStructuredResponse('{ "foo": "broken')).toBe(false);
    });

    it("returns true for truncated JSON that still has a narrative field", () => {
      // LLM hit the token limit mid-stream: unparseable, but clearly a
      // structured response — recognized so the parser can repair it.
      expect(parser.isStructuredResponse('{ "narrative": "broken')).toBe(true);
    });

    it("returns false for empty string", () => {
      expect(parser.isStructuredResponse("")).toBe(false);
    });

    it("returns true when JSON has leading whitespace", () => {
      const text = `  \n  ${JSON.stringify({ narrative: "Hello" })}`;
      expect(parser.isStructuredResponse(text)).toBe(true);
    });
  });

  // ===========================================================================
  // parse — narrative extraction
  // ===========================================================================

  describe("parse — narrative extraction", () => {
    it("extracts narrative as cleanText", () => {
      const text = JSON.stringify({
        narrative: "The hero finds a sword gleaming in the darkness.",
        stateChanges: [],
      });
      const result = parser.parse(text);
      expect(result.cleanText).toBe("The hero finds a sword gleaming in the darkness.");
    });

    it("handles empty narrative", () => {
      const text = JSON.stringify({
        narrative: "",
        stateChanges: [],
      });
      const result = parser.parse(text);
      expect(result.cleanText).toBe("");
    });
  });

  // ===========================================================================
  // parse — stateChanges to effects
  // ===========================================================================

  describe("parse — stateChanges to effects", () => {
    it("converts set operation", () => {
      const text = JSON.stringify({
        narrative: "Scene.",
        stateChanges: [
          { variableId: "hp", operation: "set", value: 100 },
        ],
      });
      const result = parser.parse(text);
      expect(result.effects).toEqual([
        { variableId: "hp", operation: "set", value: 100 },
      ]);
    });

    it("converts add operation", () => {
      const text = JSON.stringify({
        narrative: "Scene.",
        stateChanges: [
          { variableId: "gold", operation: "add", value: 50 },
        ],
      });
      const result = parser.parse(text);
      expect(result.effects).toEqual([
        { variableId: "gold", operation: "add", value: 50 },
      ]);
    });

    it("converts multiple stateChanges", () => {
      const text = JSON.stringify({
        narrative: "Battle results.",
        stateChanges: [
          { variableId: "hp", operation: "subtract", value: 20 },
          { variableId: "xp", operation: "add", value: 100 },
          { variableId: "location", operation: "set", value: "dungeon" },
        ],
      });
      const result = parser.parse(text);
      expect(result.effects).toHaveLength(3);
      expect(result.effects[0]).toEqual({ variableId: "hp", operation: "subtract", value: 20 });
      expect(result.effects[1]).toEqual({ variableId: "xp", operation: "add", value: 100 });
      expect(result.effects[2]).toEqual({ variableId: "location", operation: "set", value: "dungeon" });
    });

    it("handles JSON array values (segments variable)", () => {
      const segments = [
        { type: "narration", content: "The wind howls." },
        { type: "dialogue", content: "Who goes there?", speaker: "Guard" },
      ];
      const text = JSON.stringify({
        narrative: "A stormy night.",
        stateChanges: [
          { variableId: "segments", operation: "set", value: segments },
        ],
      });
      const result = parser.parse(text);
      expect(result.effects).toHaveLength(1);
      expect(result.effects[0]!.variableId).toBe("segments");
      expect(result.effects[0]!.operation).toBe("set");
      expect(result.effects[0]!.value).toEqual(segments);
    });

    it("handles missing stateChanges gracefully (empty effects)", () => {
      const text = JSON.stringify({
        narrative: "A peaceful scene with no state changes.",
      });
      const result = parser.parse(text);
      expect(result.effects).toEqual([]);
    });

    it("handles boolean values in stateChanges", () => {
      const text = JSON.stringify({
        narrative: "The key is found.",
        stateChanges: [
          { variableId: "hasKey", operation: "set", value: true },
        ],
      });
      const result = parser.parse(text);
      expect(result.effects).toEqual([
        { variableId: "hasKey", operation: "set", value: true },
      ]);
    });

    it("handles object values in stateChanges", () => {
      const objValue = { strength: 10, agility: 15 };
      const text = JSON.stringify({
        narrative: "Stats updated.",
        stateChanges: [
          { variableId: "stats", operation: "set", value: objValue },
        ],
      });
      const result = parser.parse(text);
      expect(result.effects[0]!.value).toEqual(objValue);
    });
  });

  // ===========================================================================
  // parse — audioEffects
  // ===========================================================================

  describe("parse — audioEffects", () => {
    it("extracts audioEffects when present", () => {
      const text = JSON.stringify({
        narrative: "Battle music starts.",
        stateChanges: [],
        audioEffects: [
          { trackId: "bgm1", action: "play" },
        ],
      });
      const result = parser.parse(text);
      expect(result.audioEffects).toEqual([
        { trackId: "bgm1", action: "play" },
      ]);
    });

    it("handles multiple audioEffects", () => {
      const text = JSON.stringify({
        narrative: "Scene transition.",
        stateChanges: [],
        audioEffects: [
          { trackId: "bgm1", action: "stop" },
          { trackId: "bgm2", action: "play" },
          { trackId: "sfx1", action: "play" },
        ],
      });
      const result = parser.parse(text);
      expect(result.audioEffects).toHaveLength(3);
    });

    it("handles audioEffects with optional fields (volume, fadeDuration)", () => {
      const text = JSON.stringify({
        narrative: "Volume changes.",
        stateChanges: [],
        audioEffects: [
          { trackId: "bgm1", action: "volume", volume: 0.5 },
          { trackId: "bgm2", action: "crossfade", volume: 0.8, fadeDuration: 2.0 },
        ],
      });
      const result = parser.parse(text);
      expect(result.audioEffects).toEqual([
        { trackId: "bgm1", action: "volume", volume: 0.5 },
        { trackId: "bgm2", action: "crossfade", volume: 0.8, fadeDuration: 2.0 },
      ]);
    });

    it("returns empty audioEffects when field is missing", () => {
      const text = JSON.stringify({
        narrative: "No audio.",
        stateChanges: [],
      });
      const result = parser.parse(text);
      expect(result.audioEffects).toEqual([]);
    });
  });

  // ===========================================================================
  // parse — ParseResult structure
  // ===========================================================================

  describe("parse — ParseResult structure", () => {
    it("always returns cleanText, effects, and audioEffects", () => {
      const text = JSON.stringify({ narrative: "Hello" });
      const result = parser.parse(text);
      expect(result).toHaveProperty("cleanText");
      expect(result).toHaveProperty("effects");
      expect(result).toHaveProperty("audioEffects");
      expect(typeof result.cleanText).toBe("string");
      expect(Array.isArray(result.effects)).toBe(true);
      expect(Array.isArray(result.audioEffects)).toBe(true);
    });
  });

  // ===========================================================================
  // parse — edge cases
  // ===========================================================================

  describe("parse — edge cases", () => {
    it("handles JSON with extra/unknown fields gracefully", () => {
      const text = JSON.stringify({
        narrative: "Scene.",
        stateChanges: [{ variableId: "hp", operation: "set", value: 50 }],
        choices: ["Go left", "Go right"],
        unknownField: 42,
      });
      const result = parser.parse(text);
      expect(result.cleanText).toBe("Scene.");
      expect(result.effects).toHaveLength(1);
    });

    it("handles malformed JSON by returning raw text as cleanText with empty arrays", () => {
      const text = '{ "narrative": "broken';
      const result = parser.parse(text);
      expect(result.cleanText).toBe(text);
      expect(result.effects).toEqual([]);
      expect(result.audioEffects).toEqual([]);
    });

    it("handles JSON with leading whitespace", () => {
      const text = `  \n  ${JSON.stringify({ narrative: "Spaced out.", stateChanges: [] })}`;
      const result = parser.parse(text);
      expect(result.cleanText).toBe("Spaced out.");
    });
  });
});
