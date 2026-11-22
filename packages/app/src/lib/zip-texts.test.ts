import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { readZipTexts } from "./zip-texts";

/** a zip of the given files, each stored or deflated */
function zip(files: { name: string; text: string; deflate?: boolean }[]): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(enc.encode(f.text)), body = f.deflate ? deflateRawSync(raw) : raw, name = Buffer.from(f.name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(f.deflate ? 8 : 0, 8);
    h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(f.deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, name, body); centrals.push(c, name); offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...locals, cd, e]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

test("reads stored and deflated entries, only the wanted ones, folders passed over", async () => {
  const data = zip([
    { name: "regex/", text: "" },
    { name: "regex/a.json", text: '{"findRegex":"/vanguard/gi","replaceString":""}' },
    { name: "regex/b.json", text: JSON.stringify([{ findRegex: "x".repeat(500) }]), deflate: true },
    { name: "readme.txt", text: "hello", deflate: true },
  ]);
  const got = await readZipTexts(data, (n) => n.toLowerCase().endsWith(".json"));
  assert.deepEqual(got.map((g) => g.name), ["regex/a.json", "regex/b.json"]);
  assert.equal(JSON.parse(got[0]!.text).findRegex, "/vanguard/gi");
  assert.equal(JSON.parse(got[1]!.text)[0].findRegex.length, 500);
});

test("not a zip throws", async () => {
  await assert.rejects(readZipTexts(new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer));
});

test("an entry that unpacks past its cap is passed over even when it claims to be small", async () => {
  const data = zip([
    { name: "bomb.json", text: "a".repeat(300_000), deflate: true },
    { name: "ok.json", text: '{"findRegex":"x"}', deflate: true },
  ]);
  // lie in the central directory: the bomb says it unpacks to 10 bytes
  const view = new DataView(data);
  const firstHeader = view.getUint32(data.byteLength - 22 + 16, true);
  view.setUint32(firstHeader + 24, 10, true);
  const got = await readZipTexts(data, () => true, { maxBytes: 100_000 });
  assert.deepEqual(got.map((g) => g.name), ["ok.json"]);
});
