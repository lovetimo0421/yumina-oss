import { describe, it, expect } from "vitest";
import { normalizeFolders } from "../world/normalize-folders.js";
import type { WorldDefinition } from "../types/index.js";

function world(partial: Partial<WorldDefinition>): WorldDefinition {
  return { entries: [], variables: [], rules: [], ...partial } as unknown as WorldDefinition;
}

const folder = (id: string, worldbookId?: string) => ({ id, name: id, section: "system-presets" as const, order: 0, worldbookId });
const entry = (id: string, folderId?: string, worldbookId?: string) =>
  ({ id, name: id, content: "", section: "system-presets", ...(folderId ? { folderId } : {}), worldbookId }) as any;

describe("normalizeFolders", () => {
  it("clears a folderId that points at a non-existent folder (the orphan symptom)", () => {
    const w = world({
      entries: [entry("e1", "missing"), entry("e2", "real")],
      entryFolders: [folder("real")],
    } as Partial<WorldDefinition>);
    const { world: out, fixed } = normalizeFolders(w);
    expect(fixed).toBe(1);
    expect(out.entries[0]!.folderId).toBeUndefined(); // orphan cleared → renders ungrouped
    expect(out.entries[1]!.folderId).toBe("real"); // valid reference untouched
  });

  it("is a no-op (returns same reference) when every folderId resolves", () => {
    const w = world({
      entries: [entry("e1", "a"), entry("e2")],
      entryFolders: [folder("a")],
    } as Partial<WorldDefinition>);
    const { world: out, fixed } = normalizeFolders(w);
    expect(fixed).toBe(0);
    expect(out).toBe(w); // unchanged → same object, no needless re-render churn
  });

  it("clears ALL orphans when entryFolders is missing/empty (czh123: folders wiped)", () => {
    const w = world({
      entries: [entry("e1", "f1"), entry("e2", "f2"), entry("e3")],
    } as Partial<WorldDefinition>);
    const { world: out, fixed } = normalizeFolders(w);
    expect(fixed).toBe(2);
    expect(out.entries.every((e) => e.folderId === undefined)).toBe(true);
  });

  it("clears a folder reference owned by a different knowledge base", () => {
    const w = world({
      entries: [entry("e1", "shared", "book-b")],
      entryFolders: [folder("shared", "book-a")],
    } as Partial<WorldDefinition>);
    const { world: out, fixed } = normalizeFolders(w);
    expect(fixed).toBe(1);
    expect(out.entries[0]!.folderId).toBeUndefined();
  });

  it("keeps a folder reference in the same knowledge base", () => {
    const w = world({
      entries: [entry("e1", "book-folder", "book-a")],
      entryFolders: [folder("book-folder", "book-a")],
    } as Partial<WorldDefinition>);
    const { world: out, fixed } = normalizeFolders(w);
    expect(fixed).toBe(0);
    expect(out).toBe(w);
  });

  it("clears a folder reference from a different section", () => {
    const w = world({
      entries: [{ ...entry("e1", "f1"), section: "post-history" }],
      entryFolders: [folder("f1")],
    } as Partial<WorldDefinition>);
    const { world: out, fixed } = normalizeFolders(w);
    expect(fixed).toBe(1);
    expect(out.entries[0]!.folderId).toBeUndefined();
  });

  it("does not mutate the input world or its entries", () => {
    const e = entry("e1", "missing");
    const w = world({ entries: [e], entryFolders: [] } as Partial<WorldDefinition>);
    normalizeFolders(w);
    expect(e.folderId).toBe("missing"); // original entry object untouched
    expect(w.entries[0]!.folderId).toBe("missing");
  });

  it("is idempotent", () => {
    const w = world({
      entries: [entry("e1", "missing"), entry("e2", "real")],
      entryFolders: [folder("real")],
    } as Partial<WorldDefinition>);
    const once = normalizeFolders(w).world;
    const twice = normalizeFolders(once);
    expect(twice.fixed).toBe(0);
    expect(twice.world).toBe(once);
  });

  it("handles empty / missing entries safely", () => {
    expect(normalizeFolders(world({ entries: [] })).fixed).toBe(0);
    expect(normalizeFolders(world({ entries: undefined as any })).fixed).toBe(0);
  });
});
