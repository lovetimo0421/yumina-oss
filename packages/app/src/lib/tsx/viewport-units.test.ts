import { strict as assert } from "node:assert";
import { test } from "node:test";
import { viewportUnitsToContainer, viewportUnitsToContainerFiles } from "./viewport-units";

test("every viewport unit becomes its container twin", () => {
  assert.equal(viewportUnitsToContainer("height: 100vh; width: 100vw"), "height: 100cqh; width: 100cqw");
  assert.equal(viewportUnitsToContainer("min(94vh, 900px)"), "min(94cqh, 900px)");
  assert.equal(viewportUnitsToContainer("height:100dvh;width:50svw;font-size:2vmin;padding:1.5lvmax"), "height:100cqh;width:50cqw;font-size:2cqmin;padding:1.5cqmax");
  assert.equal(viewportUnitsToContainer('style={{ height: "100vh" }}'), 'style={{ height: "100cqh" }}');
});

test("identifiers and prose are left alone", () => {
  const src = 'const vh = window.innerHeight; const avh = 3; // 100 vh of text\nfoo.vw = 1; "verhaal"';
  assert.equal(viewportUnitsToContainer(src), src);
});

test("a file map without viewport units comes back as the same object", () => {
  const files = { "index.tsx": "export default () => null", "a.tsx": "const x = 1" };
  assert.equal(viewportUnitsToContainerFiles(files), files);
  const changed = viewportUnitsToContainerFiles({ ...files, "b.tsx": "h: 100vh" });
  assert.equal(changed["b.tsx"], "h: 100cqh");
  assert.equal(changed["a.tsx"], "const x = 1");
});
