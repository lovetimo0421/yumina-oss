import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { WorldEntry } from "@yumina/engine";
import { CANVAS_WRITING_MORE_HEIGHT, GROUP_LIMIT, GROUP_ROW_LIMIT, OPEN_ALL_GROUPS, canvasWritingNodeHeight, writingSections } from "./canvas-writing-node";

const entry = (id: string, folderId: string): WorldEntry => ({ id, name: id, role: "lore", content: `Story ${id}`, position: 0, enabled: true, folderId } as WorldEntry);
const gateBar = { label: "卷", value: "1", index: 0, size: 21, active: false, answer: "", onChange: () => {}, onClear: () => {} };
/** A block grouped by chapter: `groups` groups of `rows` entries each. */
const grouped = (groups: number, rows: number, open: string[] = []) => ({
  kind: "setting" as const,
  entries: Array.from({ length: groups * rows }, (_, i) => entry(`e${i}`, `gate:${Math.floor(i / rows)}`)),
  folders: Array.from({ length: groups }, (_, g) => ({ id: `gate:${g}`, name: `卷 ${g + 1}`, order: g })),
  gateBar,
  openGroups: new Set(open),
});

test("an open group draws its first rows and folds the rest behind '… N more'", () => {
  const sections = writingSections(grouped(2, GROUP_ROW_LIMIT + 5));
  assert.equal(sections[0]!.entries.length, GROUP_ROW_LIMIT);
  assert.equal(sections[0]!.more, 5);
  const opened = writingSections(grouped(2, GROUP_ROW_LIMIT + 5, ["gate:0"]));
  assert.equal(opened[0]!.entries.length, GROUP_ROW_LIMIT + 5, "a group shown whole has no fold");
  assert.equal(opened[0]!.more, undefined);
});

test("a block of many groups draws the first few and one line for the rest", () => {
  const sections = writingSections(grouped(GROUP_LIMIT + 4, 1));
  assert.equal(sections.filter((s) => s.folder).length, GROUP_LIMIT);
  assert.equal(sections.at(-1)!.moreGroups, 4);
  assert.equal(writingSections(grouped(GROUP_LIMIT + 4, 1, [OPEN_ALL_GROUPS])).filter((s) => s.folder).length, GROUP_LIMIT + 4);
});

test("a folded block is shorter, and the board counts every '… more' line it draws", () => {
  const folded = canvasWritingNodeHeight(grouped(GROUP_LIMIT + 4, GROUP_ROW_LIMIT + 5));
  const whole = canvasWritingNodeHeight(grouped(GROUP_LIMIT + 4, GROUP_ROW_LIMIT + 5, [OPEN_ALL_GROUPS, ...Array.from({ length: GROUP_LIMIT + 4 }, (_, g) => `gate:${g}`)]));
  assert.ok(folded < whole / 2, `${folded} vs ${whole}`);
  const plain = { kind: "setting" as const, entries: [entry("a", "")] };
  assert.equal(canvasWritingNodeHeight({ ...plain, unfolded: true }) - canvasWritingNodeHeight(plain), CANVAS_WRITING_MORE_HEIGHT, "「收起」 is a line of its own");
});

test("a block not grouped by chapter keeps every row it is given", () => {
  const { gateBar: _drop, ...plain } = grouped(GROUP_LIMIT + 4, GROUP_ROW_LIMIT + 5);
  void _drop;
  const sections = writingSections(plain);
  assert.equal(sections.reduce((n, s) => n + s.entries.length, 0), plain.entries.length);
});

test("a fold never hides a single row or a single group", () => {
  assert.equal(writingSections(grouped(1, GROUP_ROW_LIMIT + 1))[0]!.entries.length, GROUP_ROW_LIMIT + 1);
  assert.equal(writingSections(grouped(1, GROUP_ROW_LIMIT + 1))[0]!.more, undefined);
  const groups = writingSections(grouped(GROUP_LIMIT + 1, 1));
  assert.equal(groups.filter((s) => s.folder).length, GROUP_LIMIT + 1);
  assert.equal(groups.some((s) => s.moreGroups), false);
});

test("an open entry is as tall as its text, up to the full editor", async () => {
  const { openEntryEditorHeight, CANVAS_WRITING_OPEN_EDITOR_HEIGHT } = await import("./canvas-writing-node");
  const one = openEntryEditorHeight("setting", "Plain, exact, institutional. Short sentences.");
  const long = openEntryEditorHeight("setting", "word ".repeat(2000));
  assert.ok(one < 260, `a line of text opens small (${one})`);
  assert.equal(long, CANVAS_WRITING_OPEN_EDITOR_HEIGHT, "a long one stops at the full height");
  assert.equal(openEntryEditorHeight("setting", "一二三四五六七八九十".repeat(6)), openEntryEditorHeight("setting", "x".repeat(120)), "a CJK character takes two");
});
