import { test } from "node:test";
import assert from "node:assert/strict";
import { revertTurn, type WorldDefinition } from "@yumina/engine";
import { turnNarrowedTo } from "./turn-narrow";

const entry = (id: string, content: string) => ({ id, name: id, content, role: "lore", keywords: [], alwaysSend: true });
const card = (entries: ReturnType<typeof entry>[], variables: Array<{ id: string; defaultValue: number }> = []) =>
  ({ id: "w", name: "w", entries, variables, rules: [], worldbooks: [] }) as unknown as WorldDefinition;

// The assistant rewrote A, added C and changed a variable; the author then edited B.
const before = card([entry("A", "old A"), entry("B", "old B")], [{ id: "hp", defaultValue: 10 }]);
const end = card([entry("A", "AI A"), entry("B", "old B"), entry("C", "AI C")], [{ id: "hp", defaultValue: 50 }]);
const now = card([entry("A", "AI A"), entry("B", "author B"), entry("C", "AI C")], [{ id: "hp", defaultValue: 50 }]);
const contents = (w: WorldDefinition) => Object.fromEntries(w.entries.map((e) => [e.id, e.content]));

test("one changed item comes back; the rest of the turn and the author's edits stay", () => {
  const { world } = revertTurn(before, turnNarrowedTo(before, end, "entry:A")!, now);
  assert.deepEqual(contents(world), { A: "old A", B: "author B", C: "AI C" });
  assert.equal(world.variables[0]!.defaultValue, 50);
});

test("one added item goes; the rest stays", () => {
  const { world } = revertTurn(before, turnNarrowedTo(before, end, "entry:C")!, now);
  assert.deepEqual(contents(world), { A: "AI A", B: "author B" });
});

test("a variable comes back on its own", () => {
  const { world } = revertTurn(before, turnNarrowedTo(before, end, "var:hp")!, now);
  assert.equal(world.variables[0]!.defaultValue, 10);
  assert.deepEqual(contents(world), { A: "AI A", B: "author B", C: "AI C" });
});

test("objects it cannot narrow to are refused, not guessed", () => {
  assert.equal(turnNarrowedTo(before, end, "frontend"), null);
  assert.equal(turnNarrowedTo(before, end, "entry:gone"), null);
});

test("the banner lists what the turn did, not what the author did after it", async () => {
  const { turnOnlyDiff } = await import("./turn-narrow");
  const node = (id: string) => ({ id, kind: "entry", title: id, ports: [], data: {} }) as never;
  const live = { addedNodes: ["entry:a", "var:mine"], changedNodes: ["entry:b", "entry:c"], removedNodes: [node("entry:d")], addedEdges: [], removedEdges: [], total: 5, isEmpty: false };
  const turn = { addedNodes: ["entry:a", "entry:undone"], changedNodes: ["entry:b"], removedNodes: [node("entry:d")], addedEdges: [], removedEdges: [], total: 4, isEmpty: false };
  const only = turnOnlyDiff(live, turn);
  assert.deepEqual(only.addedNodes, ["entry:a"]);
  assert.deepEqual(only.changedNodes, ["entry:b"]);
  assert.deepEqual(only.removedNodes.map((n) => (n as { id: string }).id), ["entry:d"]);
  assert.equal(only.total, 3);
});
