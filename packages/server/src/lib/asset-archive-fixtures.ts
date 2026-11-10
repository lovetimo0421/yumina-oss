import { pack, type Header } from "tar-stream";
import { gzipSync } from "node:zlib";

export interface ArchiveFixtureFile { name: string; data?: string | Buffer; mode?: number; flags?: number }
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Small uncompressed ZIP writer allows malformed-path/link fixtures without library sanitizing them. */
export function zipFixture(files: ArchiveFixtureFile[]) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const bytes = Buffer.from(file.data ?? "");
    const payload = (file.flags ?? 0) & 1 ? Buffer.concat([Buffer.alloc(12), bytes]) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800 | (file.flags ?? 0), 6);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, payload);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800 | (file.flags ?? 0), 8);
    directory.writeUInt32LE(crc32(bytes), 16);
    directory.writeUInt32LE(payload.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((file.mode ?? 0x81a4) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + payload.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

export async function tarFixture(files: (ArchiveFixtureFile & { type?: Header["type"]; linkname?: string })[], gzip = false) {
  const archive = pack();
  const chunks: Buffer[] = [];
  const read = (async () => { for await (const chunk of archive) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Expected binary archive data");
    chunks.push(Buffer.from(chunk));
  } })();
  for (const file of files) archive.entry({ name: file.name, type: file.type ?? "file", linkname: file.linkname }, Buffer.from(file.data ?? ""));
  archive.finalize();
  await read;
  const bytes = Buffer.concat(chunks);
  return gzip ? gzipSync(bytes) : bytes;
}
