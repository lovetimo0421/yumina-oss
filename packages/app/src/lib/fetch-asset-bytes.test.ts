import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fetchAssetBytes, MAX_FETCH_ASSET_BYTES } from "./fetch-asset-bytes";

const ID = "11111111-1111-4111-8111-111111111111";
const RIG = "22222222-2222-4222-8222-222222222222";

function withFetch(t: { after: (fn: () => void) => void }, impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const real = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init }); return impl(String(url), init); }) as typeof fetch;
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

test("an asset id, bare or as @asset:, comes back as its bytes, fetched without credentials", async (t) => {
  const calls = withFetch(t, () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "model/gltf-binary" } }));
  for (const ref of [ID, `@asset:${ID}`]) {
    const got = await fetchAssetBytes(ref, "https://h");
    assert.equal(got.ok, true);
    assert.deepEqual([...new Uint8Array(got.bytes!)], [1, 2, 3]);
    assert.equal(got.contentType, "model/gltf-binary");
  }
  assert.deepEqual(calls.map((c) => c.url), [`https://h/cdn/${ID}/original`, `https://h/cdn/${ID}/original`]);
  assert.ok(calls.every((c) => c.init?.credentials === "omit"));
});

test("anything that is not an asset id is refused before any request: no URLs, no paths", async (t) => {
  const calls = withFetch(t, () => new Response("x"));
  for (const ref of ["https://evil.example/x", `../${ID}`, `${ID}/../../api/users/me`, "", null, undefined, 42]) {
    assert.deepEqual(await fetchAssetBytes(ref, "https://h"), { ok: false, error: "bad-ref" });
  }
  assert.equal(calls.length, 0);
});

test("a missing asset, an oversized one and a network failure are answers, never throws", async (t) => {
  let mode = "404";
  withFetch(t, () => {
    if (mode === "404") return new Response("", { status: 404 });
    if (mode === "big") return new Response("x", { headers: { "content-length": String(MAX_FETCH_ASSET_BYTES + 1) } });
    throw new Error("Network unavailable");
  });
  assert.deepEqual(await fetchAssetBytes(ID, ""), { ok: false, error: "http-404" });
  mode = "big";
  assert.deepEqual(await fetchAssetBytes(ID, ""), { ok: false, error: "too-large" });
  mode = "down";
  assert.deepEqual(await fetchAssetBytes(ID, ""), { ok: false, error: "Network unavailable" });
});

test("a live character (@rig:) is the pack it shows now; a character that is gone is an answer too", async (t) => {
  let gone = false;
  const calls = withFetch(t, (url) => {
    if (url.endsWith(`/cdn/rig/${RIG}`)) return gone ? new Response("", { status: 404 }) : Response.json({ id: RIG, assetId: ID, settings: { tuning: {} }, name: "x" });
    return new Response(new Uint8Array([9, 9]));
  });
  const got = await fetchAssetBytes(`@rig:${RIG}`, "https://h");
  assert.equal(got.ok, true);
  assert.equal(got.contentType, "application/octet-stream");
  assert.deepEqual(calls.map((c) => c.url), [`https://h/cdn/rig/${RIG}`, `https://h/cdn/${ID}/original`]);
  gone = true;
  assert.deepEqual(await fetchAssetBytes(`@rig:${RIG}`, "https://h"), { ok: false, error: "http-404" });
});

// 2026-11-11: a companion card draws its character from model bytes (api.fetchAsset). Play had it; the Studio
// canvas preview's own API object did not, so the card showed "api.fetchAsset is not a function" (or sat on
// "Waking up...") where the character should be. Both hosts answer through this one reader.
test("the play host and the Studio canvas preview both answer api.fetchAsset with this reader", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const play = read("../features/chat/world-renderer.tsx");
  assert.match(play, /case "fetchAsset":[\s\S]{0,900}?return fetchAssetBytes\(args\[0\]/);
  const preview = read("../features/editor/components/preview/live-frontend-preview.tsx");
  const api = preview.slice(preview.indexOf("function buildPreviewApi("), preview.indexOf("function useStableFiles("));
  assert.match(api, /fetchAsset: \(ref: string\) => fetchAssetBytes\(ref,/);
});

// The platform's <RigCharacter> was a placeholder figure in the Studio preview ("needs the asset bytes"), so a card
// that waits for its character to be ready (a companion on "Waking up...") never got past its loading screen there.
test("the Studio preview draws the play sandbox's own <RigCharacter>, with the asset reader", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const preview = read("../features/editor/components/preview/live-frontend-preview.tsx");
  assert.match(preview, /React\.lazy\(\(\) => import\("\.\/preview-rig-character"\)\)/);
  assert.match(preview, /RigCharacter: StubRigCharacter/);
  assert.match(preview.slice(preview.indexOf("const StubRigCharacter"), preview.indexOf("const StubLorePanel")), /<PreviewRigCharacter /);
  const real = read("../features/editor/components/preview/preview-rig-character.tsx");
  assert.match(real, /from "@\/\.\.\/sandbox\/building-blocks\/rig-character"/);
  assert.match(real, /fetchAsset: \(ref: string\) => fetchAssetBytes\(ref,/);
});
