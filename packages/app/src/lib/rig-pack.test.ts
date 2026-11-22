import assert from "node:assert/strict";
import test from "node:test";
import { rigCharacterId, withRigSettings } from "./rig-pack";

function pack(header: object, body: Uint8Array): ArrayBuffer {
  let json = new TextEncoder().encode(JSON.stringify(header));
  const pad = (8 - (json.length % 8)) % 8;
  if (pad) { const p = new Uint8Array(json.length + pad); p.set(json); p.fill(0x20, json.length); json = p; }
  const out = new Uint8Array(8 + json.length + body.length);
  out.set([0x52, 0x49, 0x47, 0x36]);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8); out.set(body, 8 + json.length);
  return out.buffer;
}

function read(buf: ArrayBuffer) {
  const dv = new DataView(buf), hl = dv.getUint32(4, true);
  return { hl, header: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl))), body: new Uint8Array(buf, 8 + hl) };
}

test("the creator's settings go into the pack's header and the blocks stay as they were", () => {
  const body = Uint8Array.from({ length: 37 }, (_, i) => i * 7);
  const out = withRigSettings(pack({ version: 6, blocks: [{ off: 0, len: 37 }] }, body), { tuning: { turn: 0.5 }, custom: [{ slot: "x1", name: "坏笑" }] });
  const r = read(out);
  assert.equal(r.hl % 8, 0, "the header stays padded to 8 bytes");
  assert.deepEqual(r.header.settings, { tuning: { turn: 0.5 }, custom: [{ slot: "x1", name: "坏笑" }] });
  assert.equal(r.header.version, 6);
  assert.deepEqual([...r.body], [...body]);
});

test("not a pack: handed back untouched", () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;
  assert.equal(withRigSettings(junk, { mood: "happy" }), junk);
});

test("a character reference, and only that", () => {
  assert.equal(rigCharacterId("@rig:0F1AC80B-80CF-45D5-806A-B7C2B24F990B"), "0f1ac80b-80cf-45d5-806a-b7c2b24f990b");
  assert.equal(rigCharacterId("@asset:0f1ac80b-80cf-45d5-806a-b7c2b24f990b"), null);
  assert.equal(rigCharacterId("@rig:../etc"), null);
});
