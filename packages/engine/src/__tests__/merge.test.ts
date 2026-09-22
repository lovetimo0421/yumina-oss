import { describe, it, expect } from "vitest";
import { mergeWorldDefinition, deepEqual } from "../world/merge.js";
import type { WorldDefinition } from "../types/index.js";

function world(partial: Partial<WorldDefinition>): WorldDefinition {
  return {
    entries: [], variables: [], rules: [], reactions: [], audioTracks: [],
    ...partial,
  } as unknown as WorldDefinition;
}
const e = (id: string, content: string) => ({ id, name: id, content, section: "system-presets" }) as any;
const ids = (arr: any[]) => arr.map((x) => x.id);

describe("deepEqual", () => {
  it("is key-order independent and treats undefined as absent", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe("mergeWorldDefinition — entries (id-keyed)", () => {
  it("retains a background portrait while the creator edits that character's text", () => {
    const base = world({ entries: [e("alice", "Original")] });
    const local = world({ entries: [e("alice", "Creator's edits")] });
    const server = world({ entries: [{ ...e("alice", "Original"), portrait: "generated-portrait" }] });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.entries[0]).toMatchObject({ content: "Creator's edits", portrait: "generated-portrait" });
    expect(conflicts).toEqual([]);
    // The next autosave/merge uses the newly accepted server as its ancestor;
    // the generated portrait must remain present in that local save candidate.
    expect(mergeWorldDefinition(server, merged, server).merged.entries[0]?.portrait).toBe("generated-portrait");
    expect(local.entries[0]?.portrait).toBeUndefined();
  });

  it("keeps an explicitly replaced or removed local portrait during a concurrent image result", () => {
    const base = world({ entries: [{ ...e("alice", "Original"), portrait: "old-portrait" }] });
    const server = world({ entries: [{ ...e("alice", "Server text"), portrait: "generated-portrait" }] });
    for (const portrait of ["creator-upload", undefined]) {
      const local = world({ entries: [{ ...e("alice", "Original"), portrait }] });
      const { merged, conflicts } = mergeWorldDefinition(base, local, server);
      expect(merged.entries[0]?.portrait).toBe(portrait);
      expect(merged.entries[0]?.content).toBe("Server text");
      expect(conflicts).toEqual([{ collection: "entries", id: "alice", reason: "both-edited" }]);
    }
  });

  it("absorbs a server portrait even when the same entry also has a text conflict", () => {
    const base = world({ entries: [e("alice", "Original")] });
    const local = world({ entries: [e("alice", "Local text")] });
    const server = world({ entries: [{ ...e("alice", "Server text"), portrait: "generated-portrait" }] });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.entries[0]).toMatchObject({ content: "Local text", portrait: "generated-portrait" });
    expect(conflicts).toEqual([{ collection: "entries", id: "alice", reason: "both-edited" }]);
  });

  it("auto-merges disjoint edits (the Mode B win): agent adds, user edits a DIFFERENT entry", () => {
    const base = world({ entries: [e("a", "A0"), e("b", "B0")] });
    const local = world({ entries: [e("a", "A-user"), e("b", "B0")] }); // user edited a
    const server = world({ entries: [e("a", "A0"), e("b", "B0"), e("c", "C-agent")] }); // agent added c
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(conflicts).toHaveLength(0);
    const byId = Object.fromEntries((merged.entries as any[]).map((x) => [x.id, x.content]));
    expect(byId.a).toBe("A-user"); // user's edit kept
    expect(byId.c).toBe("C-agent"); // agent's add kept
    expect(ids(merged.entries as any[]).sort()).toEqual(["a", "b", "c"]);
  });

  it("conflict when SAME entry edited on both sides → keeps local + records conflict", () => {
    const base = world({ entries: [e("a", "A0")] });
    const local = world({ entries: [e("a", "A-user")] });
    const server = world({ entries: [e("a", "A-agent")] });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(conflicts).toEqual([{ collection: "entries", id: "a", reason: "both-edited" }]);
    expect((merged.entries as any[])[0].content).toBe("A-user"); // local kept, never silently dropped
  });

  it("same-value edits on both sides are NOT a conflict", () => {
    const base = world({ entries: [e("a", "A0")] });
    const local = world({ entries: [e("a", "SAME")] });
    const server = world({ entries: [e("a", "SAME")] });
    const { conflicts } = mergeWorldDefinition(base, local, server);
    expect(conflicts).toHaveLength(0);
  });

  it("user add + agent add both survive", () => {
    const base = world({ entries: [] });
    const local = world({ entries: [e("u", "user")] });
    const server = world({ entries: [e("ag", "agent")] });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(conflicts).toHaveLength(0);
    expect(ids(merged.entries as any[]).sort()).toEqual(["ag", "u"]);
  });

  it("honors a user delete when the server left that entry untouched", () => {
    const base = world({ entries: [e("a", "A0"), e("b", "B0")] });
    const local = world({ entries: [e("a", "A0")] }); // user deleted b
    const server = world({ entries: [e("a", "A0"), e("b", "B0")] });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(conflicts).toHaveLength(0);
    expect(ids(merged.entries as any[])).toEqual(["a"]); // delete honored
  });

  it("edit-vs-delete keeps the edit + records a conflict (no silent loss)", () => {
    const base = world({ entries: [e("a", "A0")] });
    const local = world({ entries: [] }); // user deleted a
    const server = world({ entries: [e("a", "A-agent")] }); // agent edited a
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(conflicts).toEqual([{ collection: "entries", id: "a", reason: "edit-vs-delete" }]);
    expect((merged.entries as any[])[0].content).toBe("A-agent"); // agent's edit preserved
  });

  it("agent's new folder + filed entries survive a concurrent unrelated user edit", () => {
    const base = world({ entries: [e("a", "A0")], entryFolders: [] });
    const local = world({ entries: [{ ...e("a", "A-user") }], entryFolders: [] });
    const server = world({
      entries: [e("a", "A0"), { ...e("x", "X"), folderId: "f1" }],
      entryFolders: [{ id: "f1", name: "人物", section: "system-presets", order: 0 }],
    });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(conflicts).toHaveLength(0);
    expect(ids(merged.entryFolders as any[])).toEqual(["f1"]); // agent's folder kept
    expect((merged.entries as any[]).find((z) => z.id === "a").content).toBe("A-user"); // user edit kept
  });
});

describe("mergeWorldDefinition — fields", () => {
  it("keeps the user's renamed name; takes server for fields the user didn't touch", () => {
    const base = world({ name: "Old", description: "D0" });
    const local = world({ name: "User Name", description: "D0" });
    const server = world({ name: "Old", description: "D-agent" });
    const { merged } = mergeWorldDefinition(base, local, server);
    expect(merged.name).toBe("User Name"); // user changed → kept
    expect(merged.description).toBe("D-agent"); // only server changed → taken
  });
});

describe("mergeWorldDefinition — rootComponent files", () => {
  it("merges disjoint file edits; conflicts only on the same file", () => {
    const rc = (files: Record<string, string>) => ({ entryFile: "App.tsx", files });
    const base = world({ rootComponent: rc({ "App.tsx": "v0", "Panel.tsx": "p0" }) as any });
    const local = world({ rootComponent: rc({ "App.tsx": "v-user", "Panel.tsx": "p0" }) as any });
    const server = world({ rootComponent: rc({ "App.tsx": "v0", "Panel.tsx": "p-agent" }) as any });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(conflicts).toHaveLength(0);
    const files = (merged.rootComponent as any).files;
    expect(files["App.tsx"]).toBe("v-user");
    expect(files["Panel.tsx"]).toBe("p-agent");
    expect((merged.rootComponent as any).compiled).toBeUndefined(); // forces recompile
  });
});

describe("mergeWorldDefinition — no ancestor (defensive)", () => {
  it("does not throw and keeps server adds when base is null", () => {
    const local = world({ entries: [e("a", "A-user")] });
    const server = world({ entries: [e("a", "A-user"), e("b", "B-agent")] });
    const { merged } = mergeWorldDefinition(null, local, server);
    expect(ids(merged.entries as any[]).sort()).toEqual(["a", "b"]);
  });
});
