import assert from "node:assert/strict";
import test from "node:test";
import { scanWorldSchemaForInlineAssets } from "./asset-validation.js";

const dataUri = `data:image/png;base64,${"A".repeat(240)}`;

// 2026-10-15: an imported file's example-dialogue entries had `content` as an
// array; the scan threw `text.match is not a function` and 500'd every save.
test("malformed imported fields are skipped instead of crashing the save", () => {
  const schema = {
    entries: [
      { id: "example-dialogue-1", content: ["Example", "Guild"], tags: 144 },
      { id: "lore", content: `![](${dataUri})` },
      null,
    ],
    customUI: { not: "an array" },
    rootComponent: { files: { "index.tsx": 42, "art.tsx": `const src = "${dataUri}";` } },
    audioTracks: [{ id: "a", url: 7 }],
  };
  const found = scanWorldSchemaForInlineAssets(schema);
  assert.deepEqual(found.map((m) => m.location), ['rootComponent file "art.tsx"', 'entry "lore" content']);
});
