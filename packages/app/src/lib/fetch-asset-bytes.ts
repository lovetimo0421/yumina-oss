import { assetOriginalPath } from "@/lib/asset-url";
import { fetchRigCharacterInfo, rigCharacterId, withRigSettings } from "@/lib/rig-pack";

/** Ceiling for `api.fetchAsset`. Comfortably fits a game-ready GLB with textures
 *  while keeping one bad call from ballooning the tab — in play the bytes are
 *  buffered in the parent and then structured-cloned into the iframe, so they land twice. */
export const MAX_FETCH_ASSET_BYTES = 32 * 1024 * 1024;

export type FetchAssetResult = { ok: boolean; bytes?: ArrayBuffer; contentType?: string; error?: string };

/**
 * What `api.fetchAsset(ref)` answers, for every host a card runs in: the play sandbox's parent (world-renderer)
 * and the Studio's in-page preview. One implementation, so a card that loads its character from asset bytes
 * (a Live2D model, a .vrm, a .rig6) shows the same thing where its creator edits it as where it is played.
 *
 * Narrow on purpose: the argument is an ASSET ID (or `@asset:<id>`, or a live character `@rig:<id>`), never a URL.
 * A card therefore cannot reach an arbitrary host, cannot probe paths, cannot be steered by a redirect, and gains
 * no exfiltration channel — while still being able to read its own assets, which is the actual need.
 * `credentials: "omit"` so this can never read an authenticated body. Never throws: a failure is `{ok:false, error}`.
 */
export async function fetchAssetBytes(ref: unknown, base: string): Promise<FetchAssetResult> {
  const raw = String(ref ?? "");
  try {
    // a live character (@rig:<id>): the pack it shows now, with the creator's settings in its header
    const rigId = rigCharacterId(raw);
    let assetId: string;
    let settings: Record<string, unknown> | null = null;
    if (rigId) {
      const info = await fetchRigCharacterInfo(rigId, base);
      assetId = info.assetId;
      settings = info.settings ?? {};
    } else {
      const m = /^(?:@asset:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw);
      if (!m) return { ok: false, error: "bad-ref" };
      assetId = m[1]!;
    }
    // The original route: a card reading its own file gets that file, never an edge-optimized copy.
    const r = await fetch(`${base}${assetOriginalPath(assetId)}`, { credentials: "omit" });
    if (!r.ok) return { ok: false, error: `http-${r.status}` };
    // Check the advertised size before buffering, so a hostile or simply
    // enormous asset cannot balloon the tab before we notice.
    const declared = Number(r.headers.get("content-length") || 0);
    if (declared > MAX_FETCH_ASSET_BYTES) return { ok: false, error: "too-large" };
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength > MAX_FETCH_ASSET_BYTES) return { ok: false, error: "too-large" };
    if (settings) return { ok: true, bytes: withRigSettings(bytes, settings), contentType: "application/octet-stream" };
    return { ok: true, bytes, contentType: r.headers.get("content-type") || "" };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 120) };
  }
}
