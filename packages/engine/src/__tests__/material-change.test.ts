import { describe, it, expect } from "vitest";
import { detectMaterialChange, type MaterialSnapshot } from "../diff/material-change.js";
import type { WorldDefinition } from "../types/index.js";

function world(partial: Partial<WorldDefinition>): WorldDefinition {
  return { entries: [], variables: [], rules: [], ...partial } as unknown as WorldDefinition;
}

function snap(over: Partial<MaterialSnapshot> = {}): MaterialSnapshot {
  return { schema: world({}), thumbnailUrl: "worlds/a/cover.png", ageRating: "all", ...over };
}

const entry = (id: string, content: string) => ({ id, name: id, content, keywords: [], enabled: true });

describe("detectMaterialChange", () => {
  it("reports no change for identical snapshots", () => {
    const base = snap({ schema: world({ entries: [entry("e1", "hi")] }) });
    const r = detectMaterialChange(base, snap({ schema: world({ entries: [entry("e1", "hi")] }) }));
    expect(r.changed).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("flags lorebook entry content edits as 'entries'", () => {
    const approved = snap({ schema: world({ entries: [entry("e1", "old")] }) });
    const proposed = snap({ schema: world({ entries: [entry("e1", "new")] }) });
    expect(detectMaterialChange(approved, proposed).reasons).toContain("entries");
  });

  it("flags a newly added entry as 'entries'", () => {
    const approved = snap({ schema: world({ entries: [entry("e1", "a")] }) });
    const proposed = snap({ schema: world({ entries: [entry("e1", "a"), entry("e2", "b")] }) });
    expect(detectMaterialChange(approved, proposed).reasons).toContain("entries");
  });

  it("flags rootComponent (frontend) file edits as 'frontend'", () => {
    const approved = snap({ schema: world({ rootComponent: { id: "r", name: "r", entryFile: "index.tsx", files: { "index.tsx": "old" } } as any }) });
    const proposed = snap({ schema: world({ rootComponent: { id: "r", name: "r", entryFile: "index.tsx", files: { "index.tsx": "new" } } as any }) });
    expect(detectMaterialChange(approved, proposed).reasons).toContain("frontend");
  });

  it("ignores the self-updating rootComponent.updatedAt timestamp (no false positive)", () => {
    const files = { "index.tsx": "same" };
    const approved = snap({ schema: world({ rootComponent: { id: "r", name: "r", entryFile: "index.tsx", files, updatedAt: "2026-01-01T00:00:00Z" } as any }) });
    const proposed = snap({ schema: world({ rootComponent: { id: "r", name: "r", entryFile: "index.tsx", files, updatedAt: "2026-05-29T00:00:00Z" } as any }) });
    expect(detectMaterialChange(approved, proposed).changed).toBe(false);
  });

  it("flags age-rating changes (all → sensitive)", () => {
    expect(detectMaterialChange(snap({ ageRating: "all" }), snap({ ageRating: "sensitive" })).reasons).toContain("ageRating");
  });

  it("treats legacy r18/r18g as the same class as sensitive (no false positive)", () => {
    expect(detectMaterialChange(snap({ ageRating: "sensitive" }), snap({ ageRating: "r18" })).changed).toBe(false);
  });

  it("flags cover changes", () => {
    expect(detectMaterialChange(snap({ thumbnailUrl: "a.png" }), snap({ thumbnailUrl: "b.png" })).reasons).toContain("cover");
  });

  it("treats null and empty-string cover as equal (no false positive)", () => {
    expect(detectMaterialChange(snap({ thumbnailUrl: null }), snap({ thumbnailUrl: "" })).changed).toBe(false);
  });

  it("does NOT flag non-material edits (variables) — they go live instantly", () => {
    const approved = snap({ schema: world({ variables: [{ id: "v1", name: "hp", type: "number", defaultValue: 1 }] as any }) });
    const proposed = snap({ schema: world({ variables: [{ id: "v1", name: "hp", type: "number", defaultValue: 2 }] as any }) });
    expect(detectMaterialChange(approved, proposed).changed).toBe(false);
  });

  it("collects multiple reasons at once", () => {
    const approved = snap({ schema: world({ entries: [entry("e1", "a")] }), thumbnailUrl: "x.png", ageRating: "all" });
    const proposed = snap({ schema: world({ entries: [entry("e1", "b")] }), thumbnailUrl: "y.png", ageRating: "sensitive" });
    const r = detectMaterialChange(approved, proposed);
    expect(r.reasons.sort()).toEqual(["ageRating", "cover", "entries"]);
  });
});
