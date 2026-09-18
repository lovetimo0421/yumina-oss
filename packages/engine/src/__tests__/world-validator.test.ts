import { describe, it, expect, beforeEach } from "vitest";
import { validateWorld } from "../validation/world-validator.js";
import type { WorldWarning } from "../validation/world-validator.js";
import type { GameComponent } from "../types/components.js";
import {
  createMockWorld,
  createMockVariable,
  createMockRule,
  createMockCondition,
  createMockEffect,
  createMockEntry,
  resetIdCounter,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateWorld", () => {
  beforeEach(() => {
    resetIdCounter();
  });

  // =========================================================================
  // Valid world — no warnings
  // =========================================================================

  describe("valid world with no issues", () => {
    it("returns empty array for an empty world", () => {
      const world = createMockWorld();
      const warnings = validateWorld(world);
      expect(warnings).toEqual([]);
    });

    it("returns empty array for a well-formed world with variables, rules, entries, and components", () => {
      const healthVar = createMockVariable({ id: "hp", name: "Health" });
      const goldVar = createMockVariable({
        id: "gold",
        name: "Gold",
        type: "number",
        defaultValue: 50,
      });

      const world = createMockWorld({
        variables: [healthVar, goldVar],
        rules: [
          createMockRule({
            name: "Heal rule",
            conditions: [createMockCondition({ variableId: "hp", operator: "lt", value: 20 })],
            actions: [{ type: "modify-variable", variableId: "gold", operation: "subtract", value: 10 }],
          }),
        ],
        entries: [
          createMockEntry({
            name: "Lore entry",
            content: "Some lore content.",
            alwaysSend: false,
            keywords: ["tavern"],
            enabled: true,
          }),
        ],
        components: [],
      });

      const warnings = validateWorld(world);
      expect(warnings).toEqual([]);
    });
  });

  // =========================================================================
  // rule-refs-deleted-var — rules referencing non-existent variables
  // =========================================================================

  describe("rule-refs-deleted-var", () => {
    it("warns when a rule condition references a non-existent variable", () => {
      const world = createMockWorld({
        variables: [],
        rules: [
          createMockRule({
            name: "Broken Rule",
            conditions: [createMockCondition({ variableId: "deleted-var" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        type: "rule-refs-deleted-var",
        severity: "warning",
        entityName: "Broken Rule",
      });
      expect(warnings[0].message).toContain("deleted-var");
      expect(warnings[0].message).toContain("condition");
    });

    it("warns when a rule action references a non-existent variable", () => {
      const world = createMockWorld({
        variables: [],
        rules: [
          createMockRule({
            name: "Bad Action Rule",
            actions: [{ type: "modify-variable", variableId: "gone-var", operation: "add", value: 1 }],
          }),
        ],
      });

      const warnings = validateWorld(world);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        type: "rule-refs-deleted-var",
        severity: "warning",
        entityName: "Bad Action Rule",
      });
      expect(warnings[0].message).toContain("gone-var");
      expect(warnings[0].message).toContain("action");
    });

    it("does not warn when rule references existing variables", () => {
      const hp = createMockVariable({ id: "hp", name: "HP" });
      const world = createMockWorld({
        variables: [hp],
        rules: [
          createMockRule({
            name: "Valid Rule",
            conditions: [createMockCondition({ variableId: "hp" })],
            actions: [{ type: "modify-variable", variableId: "hp", operation: "add", value: 1 }],
          }),
        ],
      });

      const warnings = validateWorld(world);
      // No rule-refs-deleted-var warnings (might have unused-variable=0 since hp IS referenced)
      const ruleWarnings = warnings.filter((w) => w.type === "rule-refs-deleted-var");
      expect(ruleWarnings).toHaveLength(0);
    });

    it("produces multiple warnings when both condition and action reference deleted vars", () => {
      const world = createMockWorld({
        variables: [],
        rules: [
          createMockRule({
            name: "Double Bad",
            conditions: [createMockCondition({ variableId: "cond-var" })],
            actions: [{ type: "modify-variable", variableId: "eff-var", operation: "add", value: 1 }],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const ruleWarnings = warnings.filter((w) => w.type === "rule-refs-deleted-var");
      expect(ruleWarnings).toHaveLength(2);
      expect(ruleWarnings.map((w) => w.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("cond-var"),
          expect.stringContaining("eff-var"),
        ]),
      );
    });
  });

  // =========================================================================
  // keywords-on-always-send — keywords are useless with alwaysSend
  // =========================================================================

  describe("keywords-on-always-send", () => {
    it("warns when an enabled entry has both alwaysSend and keywords", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            name: "Redundant Keywords",
            alwaysSend: true,
            keywords: ["dragon", "fire"],
            enabled: true,
            content: "Fire-breathing dragon.",
          }),
        ],
      });

      const warnings = validateWorld(world);
      const kwWarnings = warnings.filter((w) => w.type === "keywords-on-always-send");
      expect(kwWarnings).toHaveLength(1);
      expect(kwWarnings[0]).toMatchObject({
        type: "keywords-on-always-send",
        severity: "info",
        entityName: "Redundant Keywords",
      });
      expect(kwWarnings[0].message).toContain("keywords are ignored");
    });

    it("does not warn when alwaysSend is true but keywords are empty", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            name: "Always No Keywords",
            alwaysSend: true,
            keywords: [],
            enabled: true,
            content: "Always sent.",
          }),
        ],
      });

      const warnings = validateWorld(world);
      const kwWarnings = warnings.filter((w) => w.type === "keywords-on-always-send");
      expect(kwWarnings).toHaveLength(0);
    });

    it("does not warn when alwaysSend is false even with keywords", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            name: "Normal Keywords",
            alwaysSend: false,
            keywords: ["elf"],
            enabled: true,
            content: "An elf.",
          }),
        ],
      });

      const warnings = validateWorld(world);
      const kwWarnings = warnings.filter((w) => w.type === "keywords-on-always-send");
      expect(kwWarnings).toHaveLength(0);
    });

    it("does not warn when alwaysSend is true with keywords but entry is disabled", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            name: "Disabled Redundant",
            alwaysSend: true,
            keywords: ["test"],
            enabled: false,
            content: "Disabled entry.",
          }),
        ],
      });

      const warnings = validateWorld(world);
      const kwWarnings = warnings.filter((w) => w.type === "keywords-on-always-send");
      expect(kwWarnings).toHaveLength(0);
    });
  });

  // =========================================================================
  // empty-content — enabled entry with empty/whitespace content
  // =========================================================================

  describe("empty-content", () => {
    it("warns when an enabled entry has empty content", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            name: "Empty Entry",
            content: "",
            enabled: true,
          }),
        ],
      });

      const warnings = validateWorld(world);
      const emptyWarnings = warnings.filter((w) => w.type === "empty-content");
      expect(emptyWarnings).toHaveLength(1);
      expect(emptyWarnings[0]).toMatchObject({
        type: "empty-content",
        severity: "warning",
        entityName: "Empty Entry",
      });
      expect(emptyWarnings[0].message).toContain("empty content");
    });

    it("warns when an enabled entry has whitespace-only content", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            name: "Whitespace Entry",
            content: "   \n\t  ",
            enabled: true,
          }),
        ],
      });

      const warnings = validateWorld(world);
      const emptyWarnings = warnings.filter((w) => w.type === "empty-content");
      expect(emptyWarnings).toHaveLength(1);
      expect(emptyWarnings[0].entityName).toBe("Whitespace Entry");
    });

    it("does not warn when a disabled entry has empty content", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            name: "Disabled Empty",
            content: "",
            enabled: false,
          }),
        ],
      });

      const warnings = validateWorld(world);
      const emptyWarnings = warnings.filter((w) => w.type === "empty-content");
      expect(emptyWarnings).toHaveLength(0);
    });

    it("does not warn when an enabled entry has non-empty content", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            name: "Normal Entry",
            content: "Some content here.",
            enabled: true,
          }),
        ],
      });

      const warnings = validateWorld(world);
      const emptyWarnings = warnings.filter((w) => w.type === "empty-content");
      expect(emptyWarnings).toHaveLength(0);
    });
  });

  // =========================================================================
  // orphaned-var-ref — entry conditions referencing non-existent variables
  // =========================================================================

  describe("orphaned-var-ref", () => {
    it("warns when an entry condition references a non-existent variable", () => {
      const world = createMockWorld({
        variables: [],
        entries: [
          createMockEntry({
            name: "Conditional Entry",
            conditions: [createMockCondition({ variableId: "phantom-var" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const orphanWarnings = warnings.filter((w) => w.type === "orphaned-var-ref");
      expect(orphanWarnings).toHaveLength(1);
      expect(orphanWarnings[0]).toMatchObject({
        type: "orphaned-var-ref",
        severity: "warning",
        entityName: "Conditional Entry",
      });
      expect(orphanWarnings[0].message).toContain("phantom-var");
    });

    it("does not warn when entry condition references an existing variable", () => {
      const hp = createMockVariable({ id: "hp", name: "HP" });
      const world = createMockWorld({
        variables: [hp],
        entries: [
          createMockEntry({
            name: "Valid Conditional",
            conditions: [createMockCondition({ variableId: "hp" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const orphanWarnings = warnings.filter((w) => w.type === "orphaned-var-ref");
      expect(orphanWarnings).toHaveLength(0);
    });

    it("warns for multiple orphaned references across different entries", () => {
      const world = createMockWorld({
        variables: [],
        entries: [
          createMockEntry({
            name: "Entry A",
            conditions: [createMockCondition({ variableId: "no-exist-1" })],
          }),
          createMockEntry({
            name: "Entry B",
            conditions: [createMockCondition({ variableId: "no-exist-2" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const orphanWarnings = warnings.filter((w) => w.type === "orphaned-var-ref");
      expect(orphanWarnings).toHaveLength(2);
      expect(orphanWarnings[0]!.entityName).toBe("Entry A");
      expect(orphanWarnings[1]!.entityName).toBe("Entry B");
    });
  });

  // =========================================================================
  // unused-variable — variables not referenced by any rule, component, or entry
  // =========================================================================

  describe("unused-variable", () => {
    it("warns for variables not referenced by any rule, component, or entry condition", () => {
      const lonely = createMockVariable({ id: "lonely", name: "Lonely Var" });
      const world = createMockWorld({
        variables: [lonely],
        rules: [],
        components: [],
        entries: [],
      });

      const warnings = validateWorld(world);
      const unusedWarnings = warnings.filter((w) => w.type === "unused-variable");
      expect(unusedWarnings).toHaveLength(1);
      expect(unusedWarnings[0]).toMatchObject({
        type: "unused-variable",
        severity: "info",
        entityName: "Lonely Var",
        entityId: "lonely",
      });
      expect(unusedWarnings[0]!.message).toContain("not referenced");
    });

    it("does not warn for a variable referenced by a rule condition", () => {
      const hp = createMockVariable({ id: "hp", name: "HP" });
      const world = createMockWorld({
        variables: [hp],
        rules: [
          createMockRule({
            conditions: [createMockCondition({ variableId: "hp" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const unusedWarnings = warnings.filter((w) => w.type === "unused-variable");
      expect(unusedWarnings).toHaveLength(0);
    });

    it("does not warn for a variable referenced by a rule action", () => {
      const gold = createMockVariable({ id: "gold", name: "Gold" });
      const world = createMockWorld({
        variables: [gold],
        rules: [
          createMockRule({
            actions: [{ type: "modify-variable", variableId: "gold", operation: "add", value: 1 }],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const unusedWarnings = warnings.filter((w) => w.type === "unused-variable");
      expect(unusedWarnings).toHaveLength(0);
    });

    it("does not warn for a variable referenced by a component config.variableId", () => {
      const hp = createMockVariable({ id: "hp", name: "HP" });
      const comp: GameComponent = {
        id: "comp-1",
        name: "HP Bar",
        type: "stat-bar",
        order: 0,
        config: { variableId: "hp" },
      };
      const world = createMockWorld({
        variables: [hp],
        components: [comp],
      });

      const warnings = validateWorld(world);
      const unusedWarnings = warnings.filter((w) => w.type === "unused-variable");
      expect(unusedWarnings).toHaveLength(0);
    });



    it("does not warn for a variable referenced by an entry condition", () => {
      const flag = createMockVariable({
        id: "quest-done",
        name: "Quest Done",
        type: "boolean",
        defaultValue: false,
      });
      const world = createMockWorld({
        variables: [flag],
        entries: [
          createMockEntry({
            conditions: [createMockCondition({ variableId: "quest-done" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const unusedWarnings = warnings.filter((w) => w.type === "unused-variable");
      expect(unusedWarnings).toHaveLength(0);
    });

    it("reports multiple unused variables", () => {
      const a = createMockVariable({ id: "a", name: "Var A" });
      const b = createMockVariable({ id: "b", name: "Var B" });
      const c = createMockVariable({ id: "c", name: "Var C" });
      const world = createMockWorld({
        variables: [a, b, c],
      });

      const warnings = validateWorld(world);
      const unusedWarnings = warnings.filter((w) => w.type === "unused-variable");
      expect(unusedWarnings).toHaveLength(3);
      expect(unusedWarnings.map((w) => w.entityId)).toEqual(
        expect.arrayContaining(["a", "b", "c"]),
      );
    });
  });

  // =========================================================================
  // Severity levels
  // =========================================================================

  describe("severity levels", () => {
    it("rule-refs-deleted-var has severity 'warning'", () => {
      const world = createMockWorld({
        rules: [
          createMockRule({
            conditions: [createMockCondition({ variableId: "nope" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const w = warnings.find((w) => w.type === "rule-refs-deleted-var");
      expect(w).toBeDefined();
      expect(w!.severity).toBe("warning");
    });

    it("orphaned-var-ref has severity 'warning'", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            conditions: [createMockCondition({ variableId: "nope" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const w = warnings.find((w) => w.type === "orphaned-var-ref");
      expect(w).toBeDefined();
      expect(w!.severity).toBe("warning");
    });

    it("empty-content has severity 'warning'", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({ content: "", enabled: true }),
        ],
      });

      const warnings = validateWorld(world);
      const w = warnings.find((w) => w.type === "empty-content");
      expect(w).toBeDefined();
      expect(w!.severity).toBe("warning");
    });

    it("keywords-on-always-send has severity 'info'", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            alwaysSend: true,
            keywords: ["test"],
            enabled: true,
            content: "Content.",
          }),
        ],
      });

      const warnings = validateWorld(world);
      const w = warnings.find((w) => w.type === "keywords-on-always-send");
      expect(w).toBeDefined();
      expect(w!.severity).toBe("info");
    });

    it("unused-variable has severity 'info'", () => {
      const world = createMockWorld({
        variables: [createMockVariable({ id: "unused", name: "Unused" })],
      });

      const warnings = validateWorld(world);
      const w = warnings.find((w) => w.type === "unused-variable");
      expect(w).toBeDefined();
      expect(w!.severity).toBe("info");
    });
  });

  // =========================================================================
  // Multiple warnings at once
  // =========================================================================

  describe("multiple warnings at once", () => {
    it("produces warnings of all 5 types simultaneously", () => {
      const usedVar = createMockVariable({ id: "used", name: "Used Var" });
      const unusedVar = createMockVariable({ id: "unused", name: "Unused Var" });

      const world = createMockWorld({
        variables: [usedVar, unusedVar],
        rules: [
          // rule-refs-deleted-var: references a non-existent variable
          createMockRule({
            name: "Bad Rule",
            conditions: [createMockCondition({ variableId: "deleted-var" })],
            // Also reference the existing 'used' var so it isn't flagged unused
            actions: [{ type: "modify-variable", variableId: "used", operation: "add", value: 1 }],
          }),
        ],
        entries: [
          // keywords-on-always-send
          createMockEntry({
            name: "Always+Keywords",
            alwaysSend: true,
            keywords: ["redundant"],
            enabled: true,
            content: "Has content.",
          }),
          // empty-content
          createMockEntry({
            name: "Empty",
            content: "",
            enabled: true,
          }),
          // orphaned-var-ref
          createMockEntry({
            name: "Orphaned Ref",
            content: "Some content.",
            conditions: [createMockCondition({ variableId: "ghost-var" })],
          }),
        ],
      });

      const warnings = validateWorld(world);

      const types = new Set(warnings.map((w) => w.type));
      expect(types.has("rule-refs-deleted-var")).toBe(true);
      expect(types.has("keywords-on-always-send")).toBe(true);
      expect(types.has("empty-content")).toBe(true);
      expect(types.has("orphaned-var-ref")).toBe(true);
      expect(types.has("unused-variable")).toBe(true);

      // Verify correct count: 1 rule-refs + 1 keywords + 1 empty + 1 orphaned + 1 unused = 5
      expect(warnings).toHaveLength(5);
    });

    it("accumulates warnings across multiple rules", () => {
      const world = createMockWorld({
        variables: [],
        rules: [
          createMockRule({
            name: "Rule 1",
            conditions: [createMockCondition({ variableId: "x" })],
          }),
          createMockRule({
            name: "Rule 2",
            actions: [{ type: "modify-variable", variableId: "y", operation: "add", value: 1 }],
          }),
          createMockRule({
            name: "Rule 3",
            trigger: { type: "variable-crossed", variableId: "z", direction: "drops-below", threshold: 0 },
          }),
        ],
      });

      const ruleWarnings = validateWorld(world).filter(
        (w) => w.type === "rule-refs-deleted-var",
      );
      expect(ruleWarnings).toHaveLength(3);
      expect(ruleWarnings.map((w) => w.entityName)).toEqual(
        expect.arrayContaining(["Rule 1", "Rule 2", "Rule 3"]),
      );
    });

    it("accumulates warnings across multiple entries", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({ name: "E1", content: "", enabled: true }),
          createMockEntry({ name: "E2", content: "  ", enabled: true }),
          createMockEntry({ name: "E3", content: "\n", enabled: true }),
        ],
      });

      const emptyWarnings = validateWorld(world).filter((w) => w.type === "empty-content");
      expect(emptyWarnings).toHaveLength(3);
    });
  });

  // =========================================================================
  // entityId and entityName fields
  // =========================================================================

  describe("entityId and entityName", () => {
    it("includes rule id and name for rule-refs-deleted-var", () => {
      const world = createMockWorld({
        rules: [
          createMockRule({
            id: "rule-abc",
            name: "My Rule",
            conditions: [createMockCondition({ variableId: "nope" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      expect(warnings[0]!.entityId).toBe("rule-abc");
      expect(warnings[0]!.entityName).toBe("My Rule");
    });

    it("includes entry id and name for empty-content", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            id: "entry-xyz",
            name: "Blank Entry",
            content: "",
            enabled: true,
          }),
        ],
      });

      const warnings = validateWorld(world);
      const w = warnings.find((w) => w.type === "empty-content");
      expect(w!.entityId).toBe("entry-xyz");
      expect(w!.entityName).toBe("Blank Entry");
    });

    it("includes variable id and name for unused-variable", () => {
      const world = createMockWorld({
        variables: [createMockVariable({ id: "var-lonely", name: "Lonely" })],
      });

      const warnings = validateWorld(world);
      const w = warnings.find((w) => w.type === "unused-variable");
      expect(w!.entityId).toBe("var-lonely");
      expect(w!.entityName).toBe("Lonely");
    });

    it("includes entry id and name for orphaned-var-ref", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            id: "entry-orphan",
            name: "Orphan Entry",
            conditions: [createMockCondition({ variableId: "missing" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      const w = warnings.find((w) => w.type === "orphaned-var-ref");
      expect(w!.entityId).toBe("entry-orphan");
      expect(w!.entityName).toBe("Orphan Entry");
    });

    it("includes entry id and name for keywords-on-always-send", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            id: "entry-kw",
            name: "KW Entry",
            alwaysSend: true,
            keywords: ["k"],
            enabled: true,
            content: "C.",
          }),
        ],
      });

      const warnings = validateWorld(world);
      const w = warnings.find((w) => w.type === "keywords-on-always-send");
      expect(w!.entityId).toBe("entry-kw");
      expect(w!.entityName).toBe("KW Entry");
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("a variable referenced only by a component is not flagged as unused", () => {
      const v = createMockVariable({ id: "loc", name: "Location", type: "string", defaultValue: "" });
      const comp: GameComponent = {
        id: "c1",
        name: "Location Display",
        type: "text-display",
        order: 0,
        config: { variableId: "loc" },
      };
      const world = createMockWorld({
        variables: [v],
        components: [comp],
      });

      const warnings = validateWorld(world);
      expect(warnings.filter((w) => w.type === "unused-variable")).toHaveLength(0);
    });

    it("a variable referenced only by entry conditions is not flagged as unused", () => {
      const v = createMockVariable({ id: "flag1", name: "Flag", type: "boolean", defaultValue: false });
      const world = createMockWorld({
        variables: [v],
        entries: [
          createMockEntry({
            conditions: [createMockCondition({ variableId: "flag1" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      expect(warnings.filter((w) => w.type === "unused-variable")).toHaveLength(0);
    });

    it("entry condition on non-existent var produces orphaned-var-ref, not rule-refs-deleted-var", () => {
      const world = createMockWorld({
        entries: [
          createMockEntry({
            conditions: [createMockCondition({ variableId: "nope" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      expect(warnings.every((w) => w.type !== "rule-refs-deleted-var")).toBe(true);
      expect(warnings.some((w) => w.type === "orphaned-var-ref")).toBe(true);
    });

    it("rule referencing a deleted var does not count it as 'referenced' for unused-variable check", () => {
      // If a rule references "ghost" which doesn't exist, and "real" exists but is unused
      const real = createMockVariable({ id: "real", name: "Real Var" });
      const world = createMockWorld({
        variables: [real],
        rules: [
          createMockRule({
            conditions: [createMockCondition({ variableId: "ghost" })],
          }),
        ],
      });

      const warnings = validateWorld(world);
      // Should have both: rule-refs-deleted-var for "ghost" and unused-variable for "real"
      expect(warnings.some((w) => w.type === "rule-refs-deleted-var")).toBe(true);
      expect(warnings.some((w) => w.type === "unused-variable" && w.entityId === "real")).toBe(true);
    });

    it("handles world with no entries, no rules, no variables, no components gracefully", () => {
      const world = createMockWorld({
        entries: [],
        rules: [],
        variables: [],
        components: [],
      });

      const warnings = validateWorld(world);
      expect(warnings).toEqual([]);
    });
  });
});
