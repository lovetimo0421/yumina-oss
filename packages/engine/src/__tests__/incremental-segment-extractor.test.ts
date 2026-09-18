import { describe, it, expect, beforeEach } from "vitest";
import { IncrementalSegmentExtractor } from "../parser/incremental-segment-extractor.js";

describe("IncrementalSegmentExtractor", () => {
  let extractor: IncrementalSegmentExtractor;

  beforeEach(() => {
    extractor = new IncrementalSegmentExtractor();
  });

  // ===========================================================================
  // Empty / non-JSON content
  // ===========================================================================

  describe("empty and non-JSON content", () => {
    it("returns empty result for empty content", () => {
      const result = extractor.extract("");
      expect(result.newSegments).toEqual([]);
      expect(result.bg).toBeNull();
    });

    it("returns empty result for non-JSON content", () => {
      const result = extractor.extract("The hero enters the cave.");
      expect(result.newSegments).toEqual([]);
      expect(result.bg).toBeNull();
    });

    it("returns empty result for content that starts with something other than {", () => {
      const result = extractor.extract("[1, 2, 3]");
      expect(result.newSegments).toEqual([]);
      expect(result.bg).toBeNull();
    });
  });

  // ===========================================================================
  // Single segment extraction
  // ===========================================================================

  describe("single completed segment", () => {
    it("extracts a single completed segment", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "segments",
            operation: "set",
            value: [
              {
                speaker: "陽菜",
                text: "Hello!",
                variant: "default",
                color: "#f472b6",
              },
            ],
          },
        ],
      });

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(1);
      expect(result.newSegments[0]).toEqual({
        speaker: "陽菜",
        text: "Hello!",
        variant: "default",
        color: "#f472b6",
      });
    });

    it("extracts a narration segment (empty speaker)", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "segments",
            operation: "set",
            value: [
              { speaker: "", text: "The sun sets.", variant: "narration" },
            ],
          },
        ],
      });

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(1);
      expect(result.newSegments[0]).toEqual({
        speaker: "",
        text: "The sun sets.",
        variant: "narration",
      });
    });
  });

  // ===========================================================================
  // Incremental extraction (no re-extraction)
  // ===========================================================================

  describe("incremental extraction", () => {
    it("does not re-extract already seen segments on subsequent calls", () => {
      // First call: one segment complete
      const content1 = `{"narrative":"...","stateChanges":[{"variableId":"segments","operation":"set","value":[{"speaker":"陽菜","text":"Hello!","variant":"default","color":"#f472b6"}`;

      const result1 = extractor.extract(content1);
      expect(result1.newSegments).toHaveLength(1);
      expect(result1.newSegments[0].text).toBe("Hello!");

      // Second call: same content plus more — should not re-extract the first
      const content2 = `{"narrative":"...","stateChanges":[{"variableId":"segments","operation":"set","value":[{"speaker":"陽菜","text":"Hello!","variant":"default","color":"#f472b6"},{"speaker":"","text":"Narration.","variant":"narration"}`;

      const result2 = extractor.extract(content2);
      expect(result2.newSegments).toHaveLength(1);
      expect(result2.newSegments[0].text).toBe("Narration.");
    });

    it("returns empty newSegments when content has not grown with new segments", () => {
      const content = `{"narrative":"...","stateChanges":[{"variableId":"segments","operation":"set","value":[{"speaker":"陽菜","text":"Hello!","variant":"default"}`;

      extractor.extract(content);

      // Same content, no new segments
      const result = extractor.extract(content);
      expect(result.newSegments).toEqual([]);
    });
  });

  // ===========================================================================
  // currentBg extraction
  // ===========================================================================

  describe("currentBg extraction", () => {
    it("extracts currentBg from stateChanges", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "currentBg",
            operation: "set",
            value: "classroom",
          },
          {
            variableId: "segments",
            operation: "set",
            value: [{ speaker: "", text: "A room.", variant: "narration" }],
          },
        ],
      });

      const result = extractor.extract(content);
      expect(result.bg).toBe("classroom");
    });

    it("returns null bg when no currentBg in stateChanges", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "segments",
            operation: "set",
            value: [{ speaker: "", text: "Hello.", variant: "narration" }],
          },
        ],
      });

      const result = extractor.extract(content);
      expect(result.bg).toBeNull();
    });
  });

  // ===========================================================================
  // Segment bg field
  // ===========================================================================

  describe("segment bg field", () => {
    it("extracts bg from a segment's bg field", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "segments",
            operation: "set",
            value: [
              {
                speaker: "",
                text: "On the rooftop.",
                variant: "narration",
                bg: "rooftop",
              },
            ],
          },
        ],
      });

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(1);
      expect(result.bg).toBe("rooftop");
    });

    it("segment bg takes precedence (latest bg wins)", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "currentBg",
            operation: "set",
            value: "classroom",
          },
          {
            variableId: "segments",
            operation: "set",
            value: [
              {
                speaker: "",
                text: "On the rooftop.",
                variant: "narration",
                bg: "rooftop",
              },
            ],
          },
        ],
      });

      const result = extractor.extract(content);
      // The segment bg "rooftop" should be the latest bg
      expect(result.bg).toBe("rooftop");
    });
  });

  // ===========================================================================
  // Multiple segments
  // ===========================================================================

  describe("multiple segments", () => {
    it("extracts multiple completed segments in one call", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "segments",
            operation: "set",
            value: [
              {
                speaker: "陽菜",
                text: "Hello!",
                variant: "default",
                color: "#f472b6",
              },
              {
                speaker: "",
                text: "She smiled.",
                variant: "narration",
              },
              {
                speaker: "太郎",
                text: "Hey there.",
                variant: "default",
                color: "#60a5fa",
              },
            ],
          },
        ],
      });

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(3);
      expect(result.newSegments[0].text).toBe("Hello!");
      expect(result.newSegments[1].text).toBe("She smiled.");
      expect(result.newSegments[2].text).toBe("Hey there.");
    });
  });

  // ===========================================================================
  // Incomplete segment objects
  // ===========================================================================

  describe("incomplete segment objects", () => {
    it("ignores an incomplete trailing segment object", () => {
      // The last segment is cut off mid-JSON
      const content = `{"narrative":"...","stateChanges":[{"variableId":"segments","operation":"set","value":[{"speaker":"陽菜","text":"Hello!","variant":"default"},{"speaker":"太郎","text":"How are`;

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(1);
      expect(result.newSegments[0].text).toBe("Hello!");
    });

    it("ignores segment objects without a text field", () => {
      const content = `{"narrative":"...","stateChanges":[{"variableId":"segments","operation":"set","value":[{"speaker":"陽菜","variant":"default"},{"speaker":"","text":"Valid.","variant":"narration"}]}]}`;

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(1);
      expect(result.newSegments[0].text).toBe("Valid.");
    });
  });

  // ===========================================================================
  // reset()
  // ===========================================================================

  describe("reset()", () => {
    it("clears state so previously seen segments are re-extractable", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "segments",
            operation: "set",
            value: [
              { speaker: "陽菜", text: "Hello!", variant: "default" },
            ],
          },
        ],
      });

      const result1 = extractor.extract(content);
      expect(result1.newSegments).toHaveLength(1);

      extractor.reset();

      const result2 = extractor.extract(content);
      expect(result2.newSegments).toHaveLength(1);
      expect(result2.newSegments[0].text).toBe("Hello!");
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe("edge cases", () => {
    it("handles escaped quotes inside text field", () => {
      const content = `{"narrative":"...","stateChanges":[{"variableId":"segments","operation":"set","value":[{"speaker":"陽菜","text":"She said \\"hello\\" quietly.","variant":"default"}]}]}`;

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(1);
      expect(result.newSegments[0].text).toBe('She said "hello" quietly.');
    });

    it("handles nested braces inside string values", () => {
      const content = `{"narrative":"...","stateChanges":[{"variableId":"segments","operation":"set","value":[{"speaker":"AI","text":"The object is {key: value}.","variant":"default"}]}]}`;

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(1);
      expect(result.newSegments[0].text).toBe("The object is {key: value}.");
    });

    it("handles content with segments appearing before currentBg in stateChanges", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "segments",
            operation: "set",
            value: [
              { speaker: "", text: "Scene.", variant: "narration" },
            ],
          },
          {
            variableId: "currentBg",
            operation: "set",
            value: "park",
          },
        ],
      });

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(1);
      expect(result.bg).toBe("park");
    });

    it("extracts from partial JSON (streaming, no closing brackets)", () => {
      const content = `{"narrative":"Scene description","stateChanges":[{"variableId":"currentBg","operation":"set","value":"classroom"},{"variableId":"segments","operation":"set","value":[{"speaker":"陽菜","text":"Hello!","variant":"default","color":"#f472b6"},{"speaker":"","text":"Narration.","variant":"narration"}`;

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(2);
      expect(result.bg).toBe("classroom");
    });

    it("handles extra unknown fields on segments gracefully", () => {
      const content = JSON.stringify({
        narrative: "...",
        stateChanges: [
          {
            variableId: "segments",
            operation: "set",
            value: [
              {
                speaker: "陽菜",
                text: "Hello!",
                variant: "default",
                emotion: "happy",
                customField: 42,
              },
            ],
          },
        ],
      });

      const result = extractor.extract(content);
      expect(result.newSegments).toHaveLength(1);
      expect(result.newSegments[0].emotion).toBe("happy");
      expect(result.newSegments[0].customField).toBe(42);
    });
  });
});
