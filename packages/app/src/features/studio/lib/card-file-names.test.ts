import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCardFileName, componentNameFromFile, starterCardFile } from "./card-file-names.js";

/**
 * A creator pasting a tree-shaken three.js build into a card wants it to be
 * called `three-lib.js`. Both editors appended `.tsx` to anything that did not
 * already end in `.tsx`, so they got `three-lib.js.tsx` and — with no rename
 * anywhere in the UI — no way back short of exporting the world JSON, editing
 * it by hand and importing it again.
 */
test("an extension the author typed survives", () => {
  assert.deepEqual(normalizeCardFileName("three-lib.js"), { ok: true, name: "three-lib.js" });
  assert.deepEqual(normalizeCardFileName("engine.ts"), { ok: true, name: "engine.ts" });
  assert.deepEqual(normalizeCardFileName("panel.jsx"), { ok: true, name: "panel.jsx" });
  assert.deepEqual(normalizeCardFileName("hud.tsx"), { ok: true, name: "hud.tsx" });
});

test("no extension still means .tsx", () => {
  assert.deepEqual(normalizeCardFileName("stat-bar"), { ok: true, name: "stat-bar.tsx" });
  assert.deepEqual(normalizeCardFileName("  stat-bar  "), { ok: true, name: "stat-bar.tsx" });
  assert.deepEqual(normalizeCardFileName("./stat-bar"), { ok: true, name: "stat-bar.tsx" });
});

test("subfolders are allowed — installed bundles already use them", () => {
  assert.deepEqual(normalizeCardFileName("scenes/atrium.tsx"), { ok: true, name: "scenes/atrium.tsx" });
  assert.deepEqual(normalizeCardFileName("scenes\\atrium"), { ok: true, name: "scenes/atrium.tsx" });
});

test("an extension the bundler cannot compile is refused, not silently suffixed", () => {
  // `data.json` would resolve (EXTENSIONS ends with the exact name) and then
  // die in Sucrase. `data.json.tsx` is the old behaviour and just as useless.
  assert.deepEqual(normalizeCardFileName("data.json"), { ok: false, reason: "extension" });
  assert.deepEqual(normalizeCardFileName("shader.glsl"), { ok: false, reason: "extension" });
});

test("path escapes are refused", () => {
  assert.deepEqual(normalizeCardFileName("/etc/passwd"), { ok: false, reason: "path" });
  assert.deepEqual(normalizeCardFileName("../other"), { ok: false, reason: "path" });
  assert.deepEqual(normalizeCardFileName("a//b"), { ok: false, reason: "path" });
  assert.deepEqual(normalizeCardFileName("   "), { ok: false, reason: "empty" });
});

test("extension case is normalized, the name is not", () => {
  assert.deepEqual(normalizeCardFileName("StatBar.TSX"), { ok: true, name: "StatBar.tsx" });
});

test("starter content matches the extension", () => {
  assert.match(starterCardFile("stat-bar.tsx"), /export default function StatBar\(\)/);
  assert.match(starterCardFile("stat-bar.tsx"), /<div>Hello<\/div>/);
  // JSX in a .js file compiles fine, but a helper module is the likelier intent.
  assert.match(starterCardFile("helpers.js"), /export function Helpers\(\)/);
  assert.doesNotMatch(starterCardFile("helpers.js"), /<div>/);
});

test("component names survive dashes and folders", () => {
  assert.equal(componentNameFromFile("scenes/stat-bar.tsx"), "StatBar");
  assert.equal(componentNameFromFile("123.tsx"), "Component");
});
