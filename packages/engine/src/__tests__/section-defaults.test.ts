import { describe, it, expect } from "vitest";
import {
  deriveSectionDefaults,
  deriveSectionDefaultsForEntry,
} from "../entries/section-defaults.js";

describe("deriveSectionDefaults", () => {
  it("maps sections to their engine-field defaults", () => {
    expect(deriveSectionDefaults("system-presets")).toEqual({ alwaysSend: true });
    expect(deriveSectionDefaults("examples")).toEqual({ alwaysSend: true, role: "example" });
    expect(deriveSectionDefaults("chat-history")).toEqual({ alwaysSend: false, depth: 4 });
    expect(deriveSectionDefaults("post-history")).toEqual({ alwaysSend: true });
  });
});

describe("deriveSectionDefaultsForEntry", () => {
  const bound = {
    variableBound: true,
    conditions: [{ variableId: "is-inside", operator: "eq" as const, value: true }],
  };
  const conditionsOnly = {
    variableBound: undefined,
    conditions: [{ variableId: "is-inside", operator: "eq" as const, value: true }],
  };
  const unbound = { variableBound: undefined, conditions: [] };

  it("never resurrects alwaysSend on a variable-bound entry (the bundle-import clobber)", () => {
    expect(deriveSectionDefaultsForEntry(bound, "system-presets").alwaysSend).toBe(false);
    expect(deriveSectionDefaultsForEntry(bound, "examples").alwaysSend).toBe(false);
    expect(deriveSectionDefaultsForEntry(bound, "post-history").alwaysSend).toBe(false);
  });

  it("treats conditions-only entries as bound too", () => {
    expect(deriveSectionDefaultsForEntry(conditionsOnly, "system-presets").alwaysSend).toBe(false);
  });

  it("keeps plain section defaults for unbound entries", () => {
    expect(deriveSectionDefaultsForEntry(unbound, "system-presets")).toEqual({ alwaysSend: true });
    expect(deriveSectionDefaultsForEntry(unbound, "chat-history")).toEqual({ alwaysSend: false, depth: 4 });
  });

  it("preserves non-alwaysSend defaults (depth, role) for bound entries", () => {
    expect(deriveSectionDefaultsForEntry(bound, "chat-history")).toEqual({ alwaysSend: false, depth: 4 });
    expect(deriveSectionDefaultsForEntry(bound, "examples")).toEqual({ alwaysSend: false, role: "example" });
  });

  it("remembers the role an entry had before the examples and gives it back on the way out", () => {
    const character = { conditions: [], role: "character" as const };
    const into = deriveSectionDefaultsForEntry(character, "examples");
    expect(into).toEqual({ alwaysSend: true, role: "example", roleBeforeExample: "character" });
    const back = deriveSectionDefaultsForEntry({ conditions: [], role: "example", roleBeforeExample: into.roleBeforeExample }, "system-presets");
    expect(back).toEqual({ alwaysSend: true, role: "character", roleBeforeExample: undefined });
  });

  it("turns a born example into plain lore when it leaves the examples", () => {
    expect(deriveSectionDefaultsForEntry({ conditions: [], role: "example" }, "chat-history"))
      .toEqual({ alwaysSend: false, depth: 4, role: "custom", roleBeforeExample: undefined });
  });
});
