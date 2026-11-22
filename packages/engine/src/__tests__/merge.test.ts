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
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.name).toBe("User Name"); // user changed → kept
    expect(merged.description).toBe("D-agent"); // only server changed → taken
    expect(conflicts).toEqual([]);
  });

  it("reports different concurrent renames so the caller can recover the server title", () => {
    const base = world({ name: "Original title" });
    const local = world({ name: "This page's title" });
    const server = world({ name: "Other page's title" });
    const before = structuredClone({ base, local, server });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.name).toBe("This page's title");
    expect(conflicts).toEqual([{ collection: "field", id: "name", reason: "both-edited" }]);
    expect({ base, local, server }).toEqual(before);
  });

  it("reports each conflicting top-level field and keeps local values", () => {
    const base = world({ name: "Original", description: "Original description" });
    const local = world({ name: "Local", description: "Local description" });
    const server = world({ name: "Remote", description: "Remote description" });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.name).toBe("Local");
    expect(merged.description).toBe("Local description");
    expect(conflicts).toEqual([
      { collection: "field", id: "name", reason: "both-edited" },
      { collection: "field", id: "description", reason: "both-edited" },
    ]);
  });

  it.each([
    ["Original", "Original", "Original"],
    ["Original", "Local", "Local"],
    ["Remote", "Original", "Remote"],
    ["Shared edit", "Shared edit", "Shared edit"],
  ])("does not report a conflict for server=%s and local=%s", (serverName, localName, expectedName) => {
    const { merged, conflicts } = mergeWorldDefinition(
      world({ name: "Original" }), world({ name: localName }), world({ name: serverName }),
    );
    expect(merged.name).toBe(expectedName);
    expect(conflicts).toEqual([]);
  });

  it("merges settings key by key, reporting only a key changed both ways", () => {
    const original = { temperature: 0.7, maxTokens: 2000 } as WorldDefinition["settings"];
    const apart = mergeWorldDefinition(
      world({ settings: original }),
      world({ settings: { ...original, temperature: 0.9 } }),
      world({ settings: { ...original, maxTokens: 3000 } }),
    );
    expect(apart.merged.settings).toEqual({ temperature: 0.9, maxTokens: 3000 });
    expect(apart.conflicts).toEqual([]);
    const clash = mergeWorldDefinition(
      world({ settings: original }),
      world({ settings: { ...original, temperature: 0.9 } }),
      world({ settings: { ...original, temperature: 0.1 } }),
    );
    expect(clash.merged.settings).toEqual({ temperature: 0.9, maxTokens: 2000 });
    expect(clash.conflicts).toEqual([{ collection: "field", id: "settings.temperature", reason: "both-edited" }]);
  });

  it("keeps both people's canvas moves and sticky notes", () => {
    const note = (id: string, text: string) => ({ id, x: 0, y: 0, w: 100, h: 80, text });
    const base = world({ graphLayout: { version: 1, nodes: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } }, notes: [note("n1", "old")] } });
    const local = world({ graphLayout: { version: 1, nodes: { a: { x: 50, y: 0 }, b: { x: 0, y: 0 } }, notes: [note("n1", "old")] } });
    const server = world({ graphLayout: { version: 1, nodes: { a: { x: 0, y: 0 }, b: { x: 9, y: 9 } }, notes: [note("n1", "edited"), note("n2", "theirs")] } });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.graphLayout).toEqual({ version: 1, nodes: { a: { x: 50, y: 0 }, b: { x: 9, y: 9 } }, notes: [note("n1", "edited"), note("n2", "theirs")] });
    expect(conflicts).toEqual([]);
  });

  it("merges characters by id", () => {
    const c = (id: string, name: string) => ({ id, name });
    const { merged } = mergeWorldDefinition(
      world({ characters: [c("a", "A")] } as Partial<WorldDefinition>),
      world({ characters: [c("a", "A2")] } as Partial<WorldDefinition>),
      world({ characters: [c("a", "A"), c("b", "B")] } as Partial<WorldDefinition>),
    );
    expect((merged as unknown as { characters: unknown[] }).characters).toEqual([c("a", "A2"), c("b", "B")]);
  });

  it("treats identical structural edits as agreement despite key order and omitted undefined keys", () => {
    const base = world({ coverCrop: { x: 0, y: 0, zoom: 1 } });
    const local = world({ coverCrop: { x: 10, y: 20, zoom: 1.5 } });
    const server = world({ coverCrop: { zoom: 1.5, y: 20, x: 10, fit: undefined } });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.coverCrop).toEqual(local.coverCrop);
    expect(conflicts).toEqual([]);
  });

  it("does not claim a two-sided field conflict when the ancestor is unknown", () => {
    const { merged, conflicts } = mergeWorldDefinition(null, world({ name: "Local" }), world({ name: "Remote" }));
    expect(merged.name).toBe("Remote"); // preserve the established no-ancestor policy
    expect(conflicts).toEqual([]);
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

describe("mergeWorldDefinition — keys outside the fixed lists", () => {
  it("keeps unsaved local edits to uiDoc, continuity and tag colors when the server changed something else", () => {
    const base = world({ uiDoc: { v: 1 } as any, continuity: { a: 1 } as any, customTagColors: { x: "red" }, description: "d" });
    const local = world({ uiDoc: { v: 2 } as any, continuity: { a: 2 } as any, customTagColors: { x: "blue" }, description: "d" });
    const server = world({ uiDoc: { v: 1 } as any, continuity: { a: 1 } as any, customTagColors: { x: "red" }, description: "agent" });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.uiDoc).toEqual({ v: 2 });
    expect(merged.continuity).toEqual({ a: 2 });
    expect(merged.customTagColors).toEqual({ x: "blue" });
    expect(merged.description).toBe("agent");
    expect(conflicts).toEqual([]);
  });

  it("honors a local removal of an optional field", () => {
    const base = world({ systems: ["a"] });
    const { merged } = mergeWorldDefinition(base, world({}), world({ systems: ["a"] }));
    expect("systems" in merged).toBe(false);
  });

  it("merges worldbooks by id so two people editing different situations both land", () => {
    const wb = (id: string, name: string) => ({ id, name }) as any;
    const base = world({ worldbooks: [wb("w1", "One"), wb("w2", "Two")] });
    const local = world({ worldbooks: [wb("w1", "One (me)"), wb("w2", "Two")] });
    const server = world({ worldbooks: [wb("w1", "One"), wb("w2", "Two (them)"), wb("w3", "Three")] });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect((merged.worldbooks as any[]).map((w) => w.name)).toEqual(["One (me)", "Two (them)", "Three"]);
    expect(conflicts).toEqual([]);
  });

  it("falls back to a whole-field merge when a collection has rows without ids", () => {
    const base = world({ replyRules: [{ name: "old" }] as any });
    const local = world({ replyRules: [{ name: "mine" }] as any });
    const server = world({ replyRules: [{ name: "old" }] as any });
    const { merged } = mergeWorldDefinition(base, local, server);
    expect(merged.replyRules).toEqual([{ name: "mine" }]);
  });
});

describe("mergeWorldDefinition — one entry, two people", () => {
  it("keeps both when they changed different fields of the same entry", () => {
    const base = world({ entries: [e("a", "old")] });
    const local = world({ entries: [{ ...e("a", "old"), name: "Renamed" }] });
    const server = world({ entries: [e("a", "their text")] });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.entries[0]).toMatchObject({ name: "Renamed", content: "their text" });
    expect(conflicts).toEqual([]);
  });

  it("reports a conflict only for the same field changed both ways, keeping ours", () => {
    const base = world({ variables: [{ id: "v", name: "hp", defaultValue: 1 }] as any });
    const local = world({ variables: [{ id: "v", name: "hp", defaultValue: 2 }] as any });
    const server = world({ variables: [{ id: "v", name: "HP", defaultValue: 3 }] as any });
    const { merged, conflicts } = mergeWorldDefinition(base, local, server);
    expect(merged.variables[0]).toMatchObject({ name: "HP", defaultValue: 2 });
    expect(conflicts).toEqual([{ collection: "variables", id: "v", reason: "both-edited" }]);
  });
});
