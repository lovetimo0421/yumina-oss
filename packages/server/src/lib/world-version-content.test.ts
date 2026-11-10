import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { worldVersionHash, versionMetadata } from "./world-version-content.js";
import { WORLD_VERSION_SCHEMA_SQL } from "../db/world-version-schema.js";

test("version identity ignores object order and compiled timestamps, but retains meaningful content", () => {
  const root = { files: { "index.tsx": "hello" }, compiled: "build one", updatedAt: "one" };
  const a = { name: "A", rootComponent: root, variables: [1, 2] };
  const b = { variables: [1, 2], rootComponent: { ...root, compiled: "build two", updatedAt: "two" }, name: "A" };
  assert.equal(worldVersionHash(a, { name: "A", tags: ["x"] }), worldVersionHash(b, { tags: ["x"], name: "A" }));
  assert.notEqual(worldVersionHash(a, {}), worldVersionHash({ ...b, variables: [2, 1] }, {}));
  assert.notEqual(worldVersionHash(a, {}), worldVersionHash({ ...a, rootComponent: { ...root, files: { "index.tsx": "changed" } } }, {}));
  assert.notEqual(worldVersionHash(a, { description: "old" }), worldVersionHash(a, { description: "new" }));
});

test("version metadata excludes ownership, counters, permissions and moderation decisions", () => {
  assert.deepEqual(versionMetadata({ name: "Card", description: "Description", creatorId: "other", playCount: 999,
    allowEdit: true, status: "published", reviewStatus: "approved", moderationAction: "clear" }), { name: "Card", description: "Description" });
});

test("Railway predeploy applies the same additive version schema as local startup", { skip: "Hosted deployment script is not exported" }, async () => {
  const deployed = await readFile(new URL("../../scripts/add-world-versions.sql", import.meta.url), "utf8");
  assert.equal(deployed.replaceAll("\r", "").trim(), `BEGIN;\n${WORLD_VERSION_SCHEMA_SQL}\nCOMMIT;`.trim());
});
