import { describe, it, expect } from "vitest";
import { NODE_TYPES, paletteNodeTypes } from "../registry.js";

describe("node registry", () => {
  it("includes the core authoring node kinds", () => {
    const kinds = NODE_TYPES.map((n) => n.kind);
    expect(kinds).toContain("variable");
    expect(kinds).toContain("rule");
  });
  it("paletteNodeTypes returns a non-empty list for default systems", () => {
    expect(paletteNodeTypes().length).toBeGreaterThan(0);
  });
});
