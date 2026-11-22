import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import type { RegexRule } from "@yumina/shared";
import { importRegexFiles } from "./regex-import";

const file = (name: string, body: string | Uint8Array) => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return { name, type: name.endsWith(".zip") ? "application/zip" : "application/json",
    text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
};
/** a one-level zip, every entry deflated */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
  for (const [n, text] of Object.entries(files)) {
    const raw = Buffer.from(text), body = deflateRawSync(raw), name = Buffer.from(n);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, name, body); centrals.push(c, name); offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(centrals.length / 2, 8); e.writeUInt16LE(centrals.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, e]));
}
const st = (id: string, findRegex: string, replaceString = "") => JSON.stringify({ id, scriptName: id, findRegex, replaceString, placement: [2] });

test("many json files and a zip folder of them come in together, each rule once", async () => {
  const z = zip({
    "regex/vanguard.json": st("a", "/vanguard/gi"),
    "regex/ozone.json": st("b", "/smell of ozone/gi"),
    "__MACOSX/regex/._ozone.json": "\u0000junk",
    "notes.txt": "hello",
  });
  const { added, skipped, failed } = await importRegexFiles([
    file("one.json", st("c", "/shivers? down (?:her|his) spine/gi")),
    file("pack.zip", z),
    file("dupe.json", st("a2", "/vanguard/gi")), // same rule under another id
  ], []);
  assert.equal(failed, false);
  assert.deepEqual(added.map((r) => r.name), ["c", "a", "b"]);
  assert.equal(skipped, 1);
});

test("rules already there are not added again; nothing readable fails", async () => {
  const existing = [{ id: "a", find: "vanguard", replace: "", flags: "gi", isRegex: true } as RegexRule];
  const again = await importRegexFiles([file("a.json", st("a", "/vanguard/gi"))], existing);
  assert.deepEqual(again.added, []);
  assert.equal(again.skipped, 1);
  const bad = await importRegexFiles([file("x.json", "not json"), file("y.zip", new TextEncoder().encode("nope"))], []);
  assert.equal(bad.failed, true);
});
