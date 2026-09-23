import { deflateSync } from "node:zlib";

export const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Real PNG chunks (including CRCs), shared by regression tests and manual fixtures. */
export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, chunk.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

/** 512px checkerboard; APNG alternates blue/orange once per second, forever. */
export function createUploadTestPng(animated = false, metadata?: Buffer): Buffer {
  const size = 512;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit RGB
  const chunks = [PNG_SIGNATURE, pngChunk("IHDR", ihdr)];
  if (metadata) chunks.push(pngChunk("tEXt", metadata));
  if (animated) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(2, 0);
    chunks.push(pngChunk("acTL", actl));
  }
  for (let frame = 0; frame < (animated ? 2 : 1); frame++) {
    if (animated) {
      const control = Buffer.alloc(26);
      control.writeUInt32BE(frame === 0 ? 0 : 1, 0);
      control.writeUInt32BE(size, 4);
      control.writeUInt32BE(size, 8);
      control.writeUInt16BE(1, 20);
      control.writeUInt16BE(1, 22); // 1 second
      chunks.push(pngChunk("fcTL", control));
    }
    const raw = Buffer.alloc(size * (size * 3 + 1));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = y * (size * 3 + 1) + 1 + x * 3;
        const tile = (Math.floor(x / 64) + Math.floor(y / 64)) % 2;
        const color = frame === 0 ? [32, 120 + tile * 40, 220] : [240, 100 + tile * 50, 32];
        raw.set(color, at);
      }
    }
    // Stored DEFLATE deliberately keeps each genuine image above the old 256 KiB sniff limit.
    const compressed = deflateSync(raw, { level: 0 });
    if (frame === 0) chunks.push(pngChunk("IDAT", compressed));
    else {
      const sequence = Buffer.alloc(4);
      sequence.writeUInt32BE(2);
      chunks.push(pngChunk("fdAT", Buffer.concat([sequence, compressed])));
    }
  }
  chunks.push(pngChunk("IEND"));
  return Buffer.concat(chunks);
}
