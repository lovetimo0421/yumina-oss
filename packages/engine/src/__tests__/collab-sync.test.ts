import { describe, it, expect } from "vitest";
import {
  annotateChangeBase, applyWorldChanges, applyWorldChangesChecked, diffWorld, isWorldChangeList, rebaseWorldDetailed,
} from "../world/changes.js";
import { mergeWorldDefinition } from "../world/merge.js";
import { applyHunks, mergeText, stableHash, textHunks } from "../world/text-merge.js";
import { parseTextFieldKey, readTextField, textFieldKey, writeTextField } from "../world/text-fields.js";
import type { WorldDefinition } from "../types/index.js";

function world(partial: Record<string, unknown>): WorldDefinition {
  return { entries: [], variables: [], rules: [], ...partial } as unknown as WorldDefinition;
}
const e = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, name: id, content, ...extra });
const v = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: "HP", type: "number", defaultValue: 0, ...extra });
const roundTrip = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("text diff and merge", () => {
  it("diffs into small hunks that rebuild the text", () => {
    const a = "line one\nline two\nline three\nline four\n";
    const b = "line one\nline 2\nline three\nline four\nline five\n";
    const hunks = textHunks(a, b);
    expect(applyHunks(a, hunks)).toBe(b);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({ start: 14, end: 17, insert: "2" });
  });

  it("round-trips random edits", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const alphabet = "ab\n中文😀 ";
    for (let i = 0; i < 300; i++) {
      let a = ""; for (let j = rnd(40); j > 0; j--) a += alphabet[rnd(alphabet.length)];
      let b = a;
      for (let k = rnd(4); k >= 0; k--) {
        const at = rnd(b.length + 1);
        b = b.slice(0, at) + alphabet[rnd(alphabet.length)]! + b.slice(at + rnd(3));
      }
      expect(applyHunks(a, textHunks(a, b))).toBe(b);
    }
  });

  it("merges two people's edits in different places", () => {
    expect(mergeText("hello world", "hello brave world", "hello world!")).toBe("hello brave world!");
    expect(mergeText("abc", "abc", "abXc")).toBe("abXc");
    expect(mergeText("abc", "aYbc", "abc")).toBe("aYbc");
  });

  it("puts both inserts at the same spot, theirs first", () => {
    expect(mergeText("ab", "aXb", "aYb")).toBe("aYXb");
  });

  it("keeps what we typed when both rewrote the same words", () => {
    const out = mergeText("the cat sat", "the dog sat", "the bird sat");
    expect(out).toContain("bird");
    expect(out).toContain("dog");
  });

  it("fingerprints values regardless of key order", () => {
    expect(stableHash({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(stableHash({ b: [1, { c: 2 }], a: 1 }));
    expect(stableHash("x")).not.toBe(stableHash("y"));
    expect(stableHash(undefined)).not.toBe(stableHash(""));
  });
});

describe("text field keys", () => {
  it("reads and writes rows, files and top-level fields", () => {
    const w = world({ description: "d", entries: [e("a/b:c", "hi")], rootComponent: { files: { "pages/x.tsx": "code" } } });
    const row = textFieldKey({ kind: "row", key: "entries", id: "a/b:c", field: "content" });
    const file = textFieldKey({ kind: "file", name: "pages/x.tsx" });
    expect(parseTextFieldKey(row)).toEqual({ kind: "row", key: "entries", id: "a/b:c", field: "content" });
    expect(readTextField(w, row)).toBe("hi");
    expect(readTextField(w, file)).toBe("code");
    expect(readTextField(w, "t:description")).toBe("d");
    expect(readTextField(writeTextField(w, row, "yo"), row)).toBe("yo");
    expect(readTextField(writeTextField(w, file, "new"), file)).toBe("new");
    expect(readTextField(w, "r:entries:gone:content")).toBeUndefined();
    expect(writeTextField(w, "r:entries:gone:content", "x")).toBe(w);
    expect(parseTextFieldKey("r:__proto__:x:y")).toBeNull();
    expect(parseTextFieldKey("r:entries:x:id")).toBeNull();
  });
});

describe("checked change sets", () => {
  it("reports an edit to a row someone deleted instead of dropping it", () => {
    const base = world({ entries: [e("a", "old")] });
    const changes = diffWorld(base, world({ entries: [e("a", "my words")] }));
    const deleted = world({ entries: [] });
    const result = applyWorldChangesChecked(deleted, changes);
    expect(result.missing).toEqual([{ op: "rowFields", key: "entries", id: "a" }]);
  });

  it("reports the same field changed by someone else since the sender read it", () => {
    const base = world({ entries: [e("a", "old", { keywords: ["k"] })] });
    const mine = annotateChangeBase(base, diffWorld(base, world({ entries: [e("a", "old", { keywords: ["mine"] })] })));
    const server = world({ entries: [e("a", "old", { keywords: ["theirs"] })] });
    const result = applyWorldChangesChecked(server, roundTrip(mine));
    expect(result.conflicts).toEqual([{ op: "rowFields", key: "entries", id: "a", fields: ["keywords"], reason: "both-edited" }]);
    // Unchanged on the server, or changed to the same value: no conflict.
    expect(applyWorldChangesChecked(base, mine).conflicts).toEqual([]);
    expect(applyWorldChangesChecked(world({ entries: [e("a", "old", { keywords: ["mine"] })] }), mine).conflicts).toEqual([]);
  });

  it("leaves fields kept in step live unchecked", () => {
    const base = world({ entries: [e("a", "old")] });
    const mine = annotateChangeBase(base, diffWorld(base, world({ entries: [e("a", "typed")] })), (key) => key === "r:entries:a:content");
    expect(mine[0]).not.toHaveProperty("was");
    expect(applyWorldChangesChecked(world({ entries: [e("a", "other")] }), mine).conflicts).toEqual([]);
  });

  it("checks files, nested values and top-level fields", () => {
    const base = world({ name: "n", uiDoc: { pages: [{ id: "p", title: "T" }] }, rootComponent: { files: { "a.tsx": "1" } } });
    const next = world({ name: "m", uiDoc: { pages: [{ id: "p", title: "U" }] }, rootComponent: { files: { "a.tsx": "2" } } });
    const mine = annotateChangeBase(base, diffWorld(base, next));
    expect(isWorldChangeList(roundTrip(mine))).toBe(true);
    const server = world({ name: "x", uiDoc: { pages: [{ id: "p", title: "V" }] }, rootComponent: { files: { "a.tsx": "3" } } });
    const conflicts = applyWorldChangesChecked(server, mine).conflicts.map((c) => `${c.key}:${c.id}`).sort();
    expect(conflicts).toEqual(["field:name", "field:uiDoc.pages.[p].title", "rootComponent.files:a.tsx"]);
  });

  it("reports two people adding the same id", () => {
    const base = world({ variables: [] });
    const mine = diffWorld(base, world({ variables: [v("hp", { defaultValue: 10 })] }));
    const server = world({ variables: [v("hp", { defaultValue: 99 })] });
    expect(applyWorldChangesChecked(server, mine).conflicts[0]).toMatchObject({ key: "variables", id: "hp", reason: "both-added" });
  });

  it("never puts the compiled bundle in a change set", () => {
    const base = world({ rootComponent: { files: { "a.tsx": "1" }, compiled: { code: "old" } } });
    const next = world({ rootComponent: { files: { "a.tsx": "2" }, compiled: { code: "new" } } });
    expect(diffWorld(base, next)).toEqual([{ op: "file", name: "a.tsx", content: "2" }]);
  });
});

describe("variable renames", () => {
  it("sends a rename, keeping what someone else wrote to the variable", () => {
    const base = world({ variables: [v("a"), v("hp", { description: "old" }), v("z")] });
    const mine = diffWorld(base, world({ variables: [v("a"), v("health", { description: "old" }), v("z")] }));
    expect(mine).toEqual([{ op: "rename", key: "variables", from: "hp", to: "health" }]);
    const theirs = applyWorldChanges(base, diffWorld(base, world({ variables: [v("a"), v("hp", { description: "theirs" }), v("z")] })));
    const out = applyWorldChanges(theirs, mine);
    expect(out.variables.map((x) => x.id)).toEqual(["a", "health", "z"]);
    expect(out.variables[1]).toMatchObject({ description: "theirs" });
  });

  it("reports a rename of a variable someone deleted", () => {
    const base = world({ variables: [v("hp")] });
    const mine = diffWorld(base, world({ variables: [v("health")] }));
    expect(applyWorldChangesChecked(world({ variables: [] }), mine).missing).toContainEqual({ op: "rename", key: "variables", id: "hp" });
  });
});

describe("rebase and merge", () => {
  it("brings back a row edited here that someone else deleted", () => {
    const base = world({ entries: [e("a", "1"), e("b", "2")] });
    const local = world({ entries: [e("a", "1"), e("b", "my edit")] });
    const server = world({ entries: [e("a", "1")] });
    const { world: out, restored } = rebaseWorldDetailed(base, local, server);
    expect(restored).toEqual([{ key: "entries", id: "b" }]);
    expect(out.entries).toEqual(local.entries);
  });

  it("keeps a local drag in a 3-way merge while the server reordered something else", () => {
    const ids = (w: WorldDefinition) => (w.entries as unknown as { id: string }[]).map((x) => x.id);
    const base = world({ entries: [e("a", ""), e("b", ""), e("c", ""), e("d", "")] });
    const local = world({ entries: [e("b", ""), e("a", ""), e("c", ""), e("d", "")] }); // a dragged below b
    const server = world({ entries: [e("a", ""), e("b", ""), e("d", ""), e("c", ""), e("x", "")] }); // c below d, x added
    const { merged } = mergeWorldDefinition(base, local, server);
    expect(ids(merged)).toEqual(["b", "a", "d", "c", "x"]);
  });

  it("keeps both variables when two people add the same id", () => {
    const base = world({ variables: [] });
    const { merged, conflicts } = mergeWorldDefinition(base, world({ variables: [v("hp", { defaultValue: 1 })] }), world({ variables: [v("hp", { defaultValue: 2 })] }));
    expect(merged.variables.map((x) => [x.id, x.defaultValue])).toEqual([["hp", 2], ["hp_2", 1]]);
    expect(conflicts[0]).toMatchObject({ reason: "both-added" });
  });

  it("keeps an edited row the server deleted at its local place", () => {
    const ids = (w: WorldDefinition) => (w.entries as unknown as { id: string }[]).map((x) => x.id);
    const base = world({ entries: [e("a", ""), e("b", ""), e("c", "")] });
    const local = world({ entries: [e("a", ""), e("b", "edited"), e("c", "")] });
    const server = world({ entries: [e("a", ""), e("c", "")] });
    expect(ids(mergeWorldDefinition(base, local, server).merged)).toEqual(["a", "b", "c"]);
  });
});
