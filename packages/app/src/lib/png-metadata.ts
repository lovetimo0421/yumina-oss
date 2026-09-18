/**
 * Minimal PNG tEXt / iTXt chunk reader+writer.
 *
 * Used for SillyTavern-style character cards (PNG with JSON metadata
 * embedded in a tEXt chunk) — both for importing existing ST cards
 * and for exporting Yumina worlds as PNG-with-cover.
 *
 * Spec: https://www.w3.org/TR/PNG/#11textinfo
 *   - tEXt chunk = keyword (1-79 Latin-1) + 0x00 + Latin-1 text
 *   - iTXt chunk = keyword + 0x00 + cflag + cmethod + lang + 0x00 + transKey + 0x00 + UTF-8 text
 *   - SillyTavern stores JSON as base64 in tEXt under keyword `chara` (V1/V2)
 *     or `ccv3` (V3). Base64 is ASCII so it fits Latin-1 fine.
 *
 * We adopt the same convention for our own export, using keyword `yumina`
 * with base64-encoded UTF-8 JSON.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export const YUMINA_KEYWORD = "yumina";
export const ST_V2_KEYWORD = "chara";
export const ST_V3_KEYWORD = "ccv3";

let crc32Table: Uint32Array | null = null;
function getCrc32Table(): Uint32Array {
  if (crc32Table) return crc32Table;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  crc32Table = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrc32Table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

export interface PngTextChunk {
  keyword: string;
  text: string;
}

/** Read all tEXt and uncompressed iTXt chunks. zTXt and compressed iTXt are skipped. */
export function readPngTextChunks(bytes: Uint8Array): PngTextChunk[] {
  if (!isPng(bytes)) throw new Error("Not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = new TextDecoder("latin1");
  const utf8 = new TextDecoder("utf-8");
  const chunks: PngTextChunk[] = [];
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;

    if (type === "tEXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0) {
        chunks.push({
          keyword: latin1.decode(data.subarray(0, nullIdx)),
          text: latin1.decode(data.subarray(nullIdx + 1)),
        });
      }
    } else if (type === "iTXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      const k1 = data.indexOf(0);
      if (k1 > 0 && data.length >= k1 + 5) {
        const compressionFlag = data[k1 + 1];
        const langEnd = data.indexOf(0, k1 + 3);
        if (langEnd >= 0) {
          const transEnd = data.indexOf(0, langEnd + 1);
          if (transEnd >= 0 && compressionFlag === 0) {
            chunks.push({
              keyword: latin1.decode(data.subarray(0, k1)),
              text: utf8.decode(data.subarray(transEnd + 1)),
            });
          }
        }
      }
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  return chunks;
}

function buildTextChunk(keyword: string, text: string): Uint8Array {
  if (keyword.length === 0 || keyword.length > 79) {
    throw new Error("Invalid PNG tEXt keyword length");
  }
  // Both keyword and text must be Latin-1 representable. Caller ensures.
  // (For Yumina export, text is always base64 → ASCII subset → safe.)
  const enc = new TextEncoder();
  const keywordBytes = enc.encode(keyword);
  const textBytes = enc.encode(text);
  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  data.set(keywordBytes, 0);
  data[keywordBytes.length] = 0;
  data.set(textBytes, keywordBytes.length + 1);

  const chunk = new Uint8Array(8 + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk[4] = 0x74; chunk[5] = 0x45; chunk[6] = 0x58; chunk[7] = 0x74; // "tEXt"
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/**
 * Insert (or replace) a tEXt chunk with the given keyword.
 * Inserted right after IHDR so it appears before any IDAT, which is
 * required by the spec for textual chunks.
 */
export function writePngTextChunk(
  bytes: Uint8Array,
  keyword: string,
  text: string,
): Uint8Array {
  if (!isPng(bytes)) throw new Error("Not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin1 = new TextDecoder("latin1");

  // First pass: strip any existing tEXt/iTXt with the same keyword (so writes
  // are idempotent and don't accumulate on repeated downloads).
  const keep: { start: number; end: number }[] = [];
  let insertAfter = -1;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));
    const next = offset + 8 + length + 4;
    if (next > bytes.length) break;

    let drop = false;
    if (type === "tEXt" || type === "iTXt") {
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const nullIdx = data.indexOf(0);
      if (nullIdx > 0 && latin1.decode(data.subarray(0, nullIdx)) === keyword) {
        drop = true;
      }
    }
    if (!drop) keep.push({ start: offset, end: next });
    if (type === "IHDR") insertAfter = next;
    if (type === "IEND") break;
    offset = next;
  }
  if (insertAfter < 0) throw new Error("PNG missing IHDR");

  const newChunk = buildTextChunk(keyword, text);
  const totalKeep = keep.reduce((n, r) => n + (r.end - r.start), 0);
  const out = new Uint8Array(8 + totalKeep + newChunk.length);
  out.set(bytes.subarray(0, 8), 0); // PNG signature
  let cursor = 8;
  let inserted = false;
  for (const r of keep) {
    out.set(bytes.subarray(r.start, r.end), cursor);
    cursor += r.end - r.start;
    if (!inserted && r.end === insertAfter) {
      out.set(newChunk, cursor);
      cursor += newChunk.length;
      inserted = true;
    }
  }
  if (!inserted) {
    // Fallback shouldn't happen if IHDR was found, but be safe.
    out.set(newChunk, cursor);
  }
  return out;
}

/** UTF-8 → base64. Chunked to avoid stack overflow on large strings. */
export function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 → UTF-8. */
export function base64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
