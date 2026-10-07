import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block, GraphNode } from "@yumina/engine";
import { STARTER_IDS, withStarterSlots, type CanvasBlock } from "./starter-board";

const block = (id: string, kind: Block["kind"], total = 1): Block => ({
  id, kind, total, sharedCount: 0, hiddenCount: 0, rows: [], headSlots: [],
});
const blank = () => [block("block:card", "card"), block("block:frontend", "frontend")];

test("start invitations are view-only blocks and leave frozen original blocks unchanged", () => {
  const source = blank();
  const before = structuredClone(source);
  source.forEach((entry) => {
    Object.freeze(entry.rows);
    Object.freeze(entry.headSlots);
    Object.freeze(entry);
  });
  Object.freeze(source);
  const augmented = withStarterSlots(source, true);
  assert.deepEqual(source, before);
  assert.equal(augmented[0], source[0]);
  assert.equal(augmented[1], source[1]);
  assert.equal(new Set(augmented.map((entry) => entry.id)).size, augmented.length);
  for (const id of Object.values(STARTER_IDS)) {
    const slot = augmented.find((entry) => entry.id === id)!;
    assert.ok(slot);
    assert.equal(slot.total, 0);
    assert.equal(slot.head, undefined);
    assert.deepEqual(slot.rows, []);
    assert.deepEqual(slot.headSlots, []);
  }
});

test("real setting and opening blocks replace only their own empty invitations", () => {
  const setting = block("block:lore:always", "lore");
  const opening = block("block:opening:first", "opening");
  const settingFirst = withStarterSlots([...blank(), setting], true);
  assert.equal(settingFirst.some((entry) => entry.id === STARTER_IDS.setting), false);
  assert.equal(settingFirst.some((entry) => entry.id === STARTER_IDS.opening), true);
  const openingFirst = withStarterSlots([...blank(), opening], true);
  assert.equal(openingFirst.some((entry) => entry.id === STARTER_IDS.setting), true);
  assert.equal(openingFirst.some((entry) => entry.id === STARTER_IDS.opening), false);
  const written = withStarterSlots([...blank(), setting, opening], true);
  assert.deepEqual(written.filter((entry) => entry.id.startsWith("block:starter:")).map((entry) => entry.id), []);
});

test("disabled creation adds no invitations and a module board is unchanged when starter mode is off", () => {
  const viewOnly = withStarterSlots(blank(), false);
  assert.deepEqual(viewOnly.filter((entry) => entry.id.startsWith("block:starter:")).map((entry) => entry.id), []);
  const moduleBlocks = [
    { ...block("block:m:mine:lore:always", "lore"), ownerId: "mine" },
    { ...block("block:m:mine:scene", "scene"), ownerId: "mine" },
    { ...block("block:loose:var:hp", "state"), loose: true },
  ];
  assert.deepEqual(withStarterSlots(moduleBlocks, false), moduleBlocks);
});

test("replacing invitations retains canvas identities and the original editable objects", () => {
  const openingHead: GraphNode = { id: "greeting:first", kind: "greeting", title: "Opening", ports: [{ id: "seeds", type: "state", direction: "out" }], data: { entryId: "first" } };
  const settingNode: GraphNode = { id: "entry:setting", kind: "entry", title: "Setting", ports: [{ id: "read", type: "entry", direction: "out" }], data: { entryId: "setting" } };
  const opening = { ...block("block:opening:first", "opening"), head: openingHead };
  const setting = { ...block("block:lore:always", "lore"), trigger: "always" as const, rows: [{ g: settingNode, slots: [] }] };
  const laterOpening = block("block:opening:other", "opening");
  const laterSetting = block("block:lore:keywords", "lore");
  const source = [...blank(), opening, setting, laterOpening, laterSetting];
  const before = structuredClone(source);
  source.forEach(entry => { Object.freeze(entry.rows); Object.freeze(entry.headSlots); Object.freeze(entry); });
  Object.freeze(source);

  for (const showCreationSlots of [false, true]) {
    const result = withStarterSlots(source, showCreationSlots, true);
    const canvasOpening = result.find(entry => entry.id === STARTER_IDS.opening)!;
    const canvasSetting = result.find(entry => entry.id === STARTER_IDS.setting)!;
    assert.ok(canvasOpening);
    assert.ok(canvasSetting);
    assert.equal(canvasOpening.sourceBlockId, opening.id);
    assert.equal(canvasSetting.sourceBlockId, setting.id);
    assert.equal(canvasOpening.head, openingHead);
    assert.equal(canvasOpening.headSlots, opening.headSlots);
    assert.equal(canvasSetting.rows, setting.rows);
    assert.equal(canvasSetting.rows[0]!.g, settingNode);
    assert.equal(canvasSetting.trigger, "always");
    assert.equal(result.find(entry => entry.id === laterOpening.id), laterOpening);
    assert.equal(result.find(entry => entry.id === laterSetting.id), laterSetting);
    assert.equal(new Set(result.map(entry => entry.id)).size, result.length);
  }
  assert.deepEqual(source, before);
  assert.equal(withStarterSlots(blank(), false, true).some(entry => entry.id.startsWith("block:starter:")), false);
});


test("with a tray, unused audio and scene images become one line; an unused background is not offered", () => {
  const board = [...blank(), block("block:background", "background")];
  const augmented = withStarterSlots(board, true, false, { hasBackground: false, revealed: new Set(), packs: true });
  const kinds = augmented.map((entry) => entry.kind);
  assert.ok(!kinds.includes("audio"), "no empty audio block");
  assert.ok(!kinds.includes("image"), "no empty scene-image block");
  assert.ok(!kinds.includes("background"), "no empty background block");
  const tray = augmented.find((entry) => entry.kind === "tray") as CanvasBlock | undefined;
  assert.deepEqual(tray?.tray, ["state", "behavior", "audio", "image", "packs"], "variables and behaviours first; packs only when the board asks for them");
});

test("a slot taken out of the tray, or one already in use, is a block again", () => {
  const board = [...blank(), block("block:background", "background"), block("block:audio", "audio")];
  const augmented = withStarterSlots(board, true, false, { hasBackground: true, revealed: new Set(["image", "state", "behavior"]), packs: false });
  const kinds = augmented.map((entry) => entry.kind);
  assert.ok(kinds.includes("audio") && kinds.includes("image") && kinds.includes("background"));
  assert.ok(!kinds.includes("tray"), "nothing left to offer, so no tray");
});

test("with every slot in use the tray still offers the packs", () => {
  const board = [...blank(), block("block:background", "background"), block("block:audio", "audio"), block("block:image", "image")];
  const augmented = withStarterSlots(board, true, false, { hasBackground: true, revealed: new Set(["state", "behavior"]), packs: true });
  const tray = augmented.find((entry) => entry.kind === "tray") as CanvasBlock | undefined;
  assert.deepEqual(tray?.tray, ["packs"]);
});

test("without tray options (a lesson, or read-only) the empty slots stay as blocks", () => {
  const augmented = withStarterSlots([...blank(), block("block:background", "background")], true);
  const kinds = augmented.map((entry) => entry.kind);
  assert.ok(kinds.includes("audio") && kinds.includes("image") && kinds.includes("background"));
  assert.ok(kinds.includes("state") && kinds.includes("behavior"), "a lesson teaches them as blocks");
  assert.ok(!kinds.includes("tray"));
});

test("an unused variable or behaviour block is a "+" on the tray, not an empty block", () => {
  const augmented = withStarterSlots(blank(), true, false, { hasBackground: false, revealed: new Set(), packs: false });
  const kinds = augmented.map((entry) => entry.kind);
  assert.ok(!kinds.includes("state") && !kinds.includes("behavior"));
  const tray = augmented.find((entry) => entry.kind === "tray") as CanvasBlock | undefined;
  assert.deepEqual(tray?.tray?.slice(0, 2), ["state", "behavior"]);
});
