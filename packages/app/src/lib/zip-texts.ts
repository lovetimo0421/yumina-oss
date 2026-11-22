/**
 * The text files in a .zip, read in the browser with no library: the central directory names each entry and where
 * it starts; an entry is stored (method 0) or deflated (method 8, through DecompressionStream "deflate-raw").
 * Only entries whose name passes `want` are read, at most `maxFiles` of them, `maxBytes` each and `maxTotal` in all
 * once unpacked, counted as the bytes come out (an entry's declared size can lie): one that unpacks past its cap is
 * passed over, and reading stops at the total. Folders, encrypted entries and other methods are passed over too.
 * For imports like a SillyTavern regex folder zipped.
 */
export async function readZipTexts(
  data: ArrayBuffer,
  want: (name: string) => boolean = () => true,
  { maxFiles = 200, maxBytes = 2 * 1024 * 1024, maxTotal = 20 * 1024 * 1024 } = {},
): Promise<{ name: string; text: string }[]> {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  // the end of central directory record: its signature, searched back from the end past a comment of up to 64 KB
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const out: { name: string; text: string }[] = [];
  let total = 0;
  for (let n = 0; n < count && at + 46 <= bytes.length && out.length < maxFiles; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || flags & 1 || size > maxBytes || packed > maxBytes || !want(name)) continue;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = bytes.slice(start, start + packed);
    const cap = Math.min(maxBytes, maxTotal - total);
    let raw: Uint8Array | null;
    if (method === 0) raw = body.length <= cap ? body : null;
    else if (method === 8) raw = await inflateUpTo(body, cap);
    else continue;
    if (!raw) { if (cap < maxBytes) break; continue; }
    total += raw.length;
    out.push({ name, text: new TextDecoder().decode(raw) });
  }
  return out;
}

/** A raw deflate stream unpacked, or null once it passes `cap` bytes (stopped there, not unpacked to the end). */
async function inflateUpTo(body: Uint8Array<ArrayBuffer>, cap: number): Promise<Uint8Array | null> {
  const reader = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (got > cap) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
