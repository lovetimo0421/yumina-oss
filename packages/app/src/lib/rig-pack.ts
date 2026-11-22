/**
 * Live characters as cards name them: `@rig:<id>` is a character, not one pack. The server says which pack it shows
 * now and the creator's settings (GET /cdn/rig/:id); the pack is fetched as any asset and the settings go into its
 * header (`settings`), where the player reads them. Packs themselves never change.
 *
 * .rig6: "RIG6", a little-endian u32 header length, the JSON header (padded to 8 bytes), then the blocks; block
 * offsets count from the end of the header, so a new header leaves them valid.
 */
const RIG_REF = /^@rig:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function rigCharacterId(ref: string): string | null {
  const m = RIG_REF.exec(ref.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export interface RigCharacterInfo { id: string; assetId: string; settings: Record<string, unknown>; name: string }

export async function fetchRigCharacterInfo(id: string, base = import.meta.env.VITE_API_URL || ""): Promise<RigCharacterInfo> {
  const res = await fetch(`${base}/cdn/rig/${id}`, { credentials: "omit" });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return (await res.json()) as RigCharacterInfo;
}

/** The pack with the creator's settings in its header (a pack without a valid header comes back as it was). */
export function withRigSettings(pack: ArrayBuffer, settings: Record<string, unknown>): ArrayBuffer {
  const dv = new DataView(pack);
  if (pack.byteLength < 8 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "RIG6") return pack;
  const hl = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(pack, 8, hl))) as Record<string, unknown>;
  header.settings = settings;
  let json = new TextEncoder().encode(JSON.stringify(header));
  const pad = (8 - (json.length % 8)) % 8;
  if (pad) { const p = new Uint8Array(json.length + pad); p.set(json); p.fill(0x20, json.length); json = p; }
  const out = new Uint8Array(8 + json.length + (pack.byteLength - 8 - hl));
  out.set([0x52, 0x49, 0x47, 0x36]);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(new Uint8Array(pack, 8 + hl), 8 + json.length);
  return out.buffer;
}
