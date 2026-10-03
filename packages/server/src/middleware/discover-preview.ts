import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../lib/types.js";
import { discoverAccess } from "../lib/discover-access.js";
import { overlayDiscoverArtwork } from "../lib/admin-world-artwork.js";
/** Apply presentation overlays after feed caching, so shared caches contain only public originals. */
export const discoverPreviewMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== "GET") return next();
  const access = await discoverAccess(c.get("user")?.id);
  c.set("discoverPreviewEnabled", access.enabled);
  await next();
  if (!access.enabled || !c.res.ok || !c.res.headers.get("Content-Type")?.includes("application/json")) return;
  c.header("Cache-Control", "private, no-store");
  c.header("CDN-Cache-Control", "no-store");
  c.header("Vary", "Cookie");
  // The owner edit route has already selected the held working copy. Discover
  // artwork is a presentation overlay, and must never replace authoring data.
  if (c.req.query("forEdit") === "1") return;
  const body = await c.res.clone().json();
  const targets: Array<Record<string, any>> = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = value as Record<string, any>;
    if ((typeof row.id === "string" && "thumbnailUrl" in row) || (typeof row.worldId === "string" && "worldThumbnailUrl" in row)) { targets.push(row); return; }
    // Never traverse creator schema, game state, or arbitrary embedded content.
    for (const key of ["data", "worlds", "items", "variants"]) if (key in row) visit(row[key]);
  }
  visit(body);
  const rows = await overlayDiscoverArtwork(targets.map(row => ({ id: row.worldId ?? row.id })));
  targets.forEach((target, i) => {
    const { id: _id, ...art } = rows[i]!;
    for (const [key, value] of Object.entries(art)) target["worldThumbnailUrl" in target ? "world" + key[0]!.toUpperCase() + key.slice(1) : key] = value;
  });
  c.res = new Response(JSON.stringify(body), { status: c.res.status, headers: c.res.headers });
});
