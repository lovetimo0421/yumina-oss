import { describe, it, expect } from "vitest";
import { ThinkingTagFilter } from "../parser/thinking-tag-filter.js";

describe("ThinkingTagFilter", () => {
  describe("one-shot strip()", () => {
    it("removes a leaked thinking block", () => {
      const input = "Hello <think>I should be nice</think> there.";
      expect(ThinkingTagFilter.strip(input)).toBe("Hello  there.".trim());
    });

    it("removes an echoed game-state block", () => {
      const input =
        "She smiles.\n\n<game-state>\ncurrent-location: Celeste家饭厅\ncurrent-time: 下午 15:30\n</game-state>";
      const out = ThinkingTagFilter.strip(input);
      expect(out).toBe("She smiles.");
      expect(out).not.toContain("game-state");
      expect(out).not.toContain("current-location");
    });

    it("removes an echoed last-turn-changes block (incl. json values with brackets)", () => {
      // ResponseParser strips suppressed tags BEFORE directive extraction, so an
      // echoed changes block must vanish here or its json values (which contain
      // `[`/`{`) would reach the directive regex.
      const input =
        'Dawn breaks.\n\n<last-turn-changes>\n时间段: 5 → 1\n日期: 2 → 3\ninventory: ["剑"] → ["剑","盾"]\n</last-turn-changes>';
      const out = ThinkingTagFilter.strip(input);
      expect(out).toBe("Dawn breaks.");
      expect(out).not.toContain("last-turn-changes");
      expect(out).not.toContain("时间段");
    });
  });

  describe("streaming push()", () => {
    it("suppresses a game-state block streamed in chunks", () => {
      const filter = new ThinkingTagFilter();
      const chunks = [
        "The door ",
        "creaks open.\n\n<game-",
        "state>\ncurrent-location: ",
        "Celeste家饭厅\n</game-state>",
      ];
      let output = "";
      for (const c of chunks) output += filter.push(c);
      output += filter.flush();
      expect(output).toBe("The door creaks open.\n\n");
      expect(output).not.toContain("game-state");
      expect(output).not.toContain("current-location");
    });
  });
});
