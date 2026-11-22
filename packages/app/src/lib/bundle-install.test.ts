import assert from "node:assert/strict";
import test from "node:test";
import { COMPOSED_MARKER, USER_ROOT_PATH, generateComposedIndex } from "@yumina/engine";
import { assetFieldWrites, authorOwnInterface, readSettingValue, remapVariableIdsInCode, writeSettingValue } from "./bundle-install";

test("exporting a composed interface takes the author's root and files, not other packs", () => {
  const root = {
    entryFile: "index.tsx",
    files: {
      "index.tsx": generateComposedIndex(["phone"]),
      [USER_ROOT_PATH]: "export default function Mine() { return <Panel />; }",
      "panel.tsx": "export function Panel() { return null; }",
      "_bundles/phone/index.tsx": "export default function Phone() { return null; }",
    },
  };
  assert.ok(root.files["index.tsx"]!.startsWith(COMPOSED_MARKER));
  const { root: own, leftOut } = authorOwnInterface(root);
  assert.equal(own.entryFile, USER_ROOT_PATH);
  assert.deepEqual(Object.keys(own.files).sort(), [USER_ROOT_PATH, "panel.tsx"]);
  assert.deepEqual(leftOut, ["phone"]);
  // A card without packs exports as it is.
  const plain = { entryFile: "index.tsx", files: { "index.tsx": "x" } };
  assert.equal(authorOwnInterface(plain).root, plain);
});

test("settings read and write at a dot path without touching the rest", () => {
  const before = { voice: { id: "a", speed: 1 }, name: "x" };
  const after = writeSettingValue(before, "voice.id", "b");
  assert.deepEqual(after, { voice: { id: "b", speed: 1 }, name: "x" });
  assert.deepEqual(before, { voice: { id: "a", speed: 1 }, name: "x" });
  assert.equal(readSettingValue(after, "voice.id"), "b");
  assert.equal(writeSettingValue(3, undefined, 4), 4);
});

test("an asset upload follows the field's extension rules", () => {
  const field = {
    id: "model", label: "Model", type: "asset" as const, variableId: "look", path: "image",
    extensionRules: [{ ext: "vrm", path: "model", also: [{ path: "kind", value: "vrm" }] }],
  };
  assert.deepEqual(assetFieldWrites(field, "Me.VRM", "id1"), [
    { path: "model", value: "@asset:id1" },
    { path: "kind", value: "vrm" },
  ]);
  assert.deepEqual(assetFieldWrites(field, "face.png", "id2"), [{ path: "image", value: "@asset:id2" }]);
});

test("a pack's interface follows its variables to their new ids", () => {
  const code = `api.variables.mood; api.variables?.mood; setVariable("mood", 1); const moodier = 2;`;
  const out = remapVariableIdsInCode(code, new Map([["mood", "var_9"]]));
  assert.equal(out, `api.variables.var_9; api.variables?.var_9; setVariable("var_9", 1); const moodier = 2;`);
});
