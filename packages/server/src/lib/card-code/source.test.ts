import assert from "node:assert/strict";
import test from "node:test";
import { COMPILED_FORMAT_VERSION, hashRootFiles, isCompiledUsable } from "@yumina/shared";

// No worker threads from a test: a stale stamp only asks for a restamp.
process.env.CARD_CODE_STAMP = "off";
const { playerSchema } = await import("./source.js");

const big = "export default function App() { return <div>" + "x".repeat(30_000) + "</div>; }";
const files = { "index.tsx": big };
const compiled = { code: "/*compiled*/", filesHash: hashRootFiles("index.tsx", files), compilerVersion: COMPILED_FORMAT_VERSION };
const world = (over: Record<string, unknown> = {}, id = "w1") => ({
  id,
  updatedAt: "2026-10-30T00:00:00.000Z",
  schema: { name: "Card", rootComponent: { entryFile: "index.tsx", files, compiled, ...over } },
});
const player: { clientFormat: string | undefined; isCreator: boolean } = { clientFormat: String(COMPILED_FORMAT_VERSION), isCreator: false };

test("a player gets a big card's compiled code without its source", () => {
  const out = playerSchema(world(), player) as { name: string; rootComponent: { files: object; compiled: { sourceOmitted?: boolean; code: string } } };
  assert.deepEqual(out.rootComponent.files, {});
  assert.equal(out.rootComponent.compiled.sourceOmitted, true);
  assert.equal(out.rootComponent.compiled.code, "/*compiled*/");
  assert.equal(out.name, "Card", "the rest of the card is untouched");
  assert.equal(isCompiledUsable(out.rootComponent.compiled as never, "index.tsx", {}), true, "the browser accepts it");
});

test("the source stays whenever the compiled copy cannot stand in for it", () => {
  const same = (w: ReturnType<typeof world>, opts = player) => assert.equal(playerSchema(w, opts), w.schema);
  same(world(), { ...player, isCreator: true });
  same(world(), { ...player, clientFormat: undefined });
  same(world(), { ...player, clientFormat: String(COMPILED_FORMAT_VERSION + 1) });
  same(world({ compiled: undefined }));
  same(world({ compiled: { ...compiled, compilerVersion: COMPILED_FORMAT_VERSION - 1 } }));
  same(world({ compiled: { ...compiled, filesHash: "stale:1" } }, "w-stale"));
  const small = { "index.tsx": "export default function App() { return <Chat />; }" };
  same(world({ files: small, compiled: { ...compiled, filesHash: hashRootFiles("index.tsx", small) } }, "w-small"));
  const gallery = { "index.tsx": big + "\nconst k = 'oncin:gallery:v2';\nfunction oswUseGalleryStore(api) { return api; }" };
  same(world({ files: gallery, compiled: { ...compiled, filesHash: hashRootFiles("index.tsx", gallery) } }, "w-gallery"));
});

test("a browser keeps checking stamps itself when the source did come", () => {
  assert.equal(isCompiledUsable(compiled, "index.tsx", files), true);
  assert.equal(isCompiledUsable({ ...compiled, sourceOmitted: true }, "index.tsx", files), true);
  assert.equal(isCompiledUsable(compiled, "index.tsx", { "index.tsx": "changed" }), false);
  assert.equal(isCompiledUsable(compiled, "index.tsx", {}), false, "no source and no server check: not trusted");
});
