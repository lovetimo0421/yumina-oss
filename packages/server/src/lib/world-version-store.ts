import { and, desc, eq, sql } from "drizzle-orm";
import { worldPendingEdits, worldVersions } from "../db/schema.js";
import type { WorldEditExecutor } from "./pending-edit.js";
import { versionMetadata, worldVersionHash, type VersionMetadata } from "./world-version-content.js";

export async function readVersionState(tx: WorldEditExecutor, worldId: string) {
  const result = await tx.execute(sql`SELECT to_jsonb(w) AS row FROM worlds w WHERE id = ${worldId} FOR UPDATE`);
  const raw = result.rows[0]?.row as Record<string, unknown> | undefined;
  if (!raw) return null;
  const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
  const live = { schema: row.schema as Record<string, unknown>, metadata: versionMetadata(row) };
  const [pending] = await tx.select({ schema: worldPendingEdits.schema, metadata: worldPendingEdits.metadata,
    thumbnailUrl: worldPendingEdits.thumbnailUrl, ageRating: worldPendingEdits.ageRating })
    .from(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId)).limit(1);
  const metadata = pending && row.status === "published"
    ? { ...live.metadata, ...pending.metadata, thumbnailUrl: pending.thumbnailUrl, ageRating: pending.ageRating ?? "all" }
    : live.metadata;
  const schema = { ...(pending && row.status === "published" ? pending.schema : live.schema), name: metadata.name ?? live.schema.name };
  return { creatorId: row.creatorId as string, status: row.status as string, row, live, working: { schema, metadata } };
}

async function insertWorldCheckpoint(tx: WorldEditExecutor, args: {
  worldId: string; creatorId: string; schema: Record<string, unknown>; metadata: VersionMetadata;
  source: string; published?: boolean;
}) {
  const contentHash = worldVersionHash(args.schema, args.metadata);
  const [existing] = await tx.select({ id: worldVersions.id, publishedAt: worldVersions.publishedAt })
    .from(worldVersions).where(and(eq(worldVersions.worldId, args.worldId), eq(worldVersions.contentHash, contentHash)))
    .orderBy(desc(worldVersions.createdAt), desc(worldVersions.id)).limit(1);
  if (existing) {
    if (args.published && !existing.publishedAt) {
      await tx.update(worldVersions).set({ publishedAt: new Date() }).where(eq(worldVersions.id, existing.id));
    }
    return existing.id;
  }
  const [version] = await tx.insert(worldVersions).values({
    worldId: args.worldId, createdBy: args.creatorId,
    name: `Saved version · ${new Date().toISOString()}`,
    schema: args.schema, metadata: args.metadata, source: args.source, contentHash,
    publishedAt: args.published ? new Date() : null,
  }).returning();
  if (!version) throw new Error("Version checkpoint was not saved");
  return version.id;
}

/** Caller owns the world lock. A failed checkpoint must fail its save/publish transaction. */
export async function checkpointWorld(tx: WorldEditExecutor, worldId: string, source: string, copy: "live" | "working" = "working") {
  const state = await readVersionState(tx, worldId);
  if (!state) throw new Error("World not found while saving a version");
  const content = state[copy];
  const published = state.status === "published" && (copy === "live"
    || worldVersionHash(content.schema, content.metadata) === worldVersionHash(state.live.schema, state.live.metadata));
  return insertWorldCheckpoint(tx, { worldId, creatorId: state.creatorId, ...content, source, published });
}

/** Retained content references protect hosted bytes from ordinary asset deletion. */
export async function assetIsVersioned(tx: WorldEditExecutor, id: string, url: string): Promise<boolean> {
  const result = await tx.execute(sql`SELECT 1 FROM world_versions
    WHERE strpos(schema::text, ${id}) > 0 OR strpos(schema::text, ${url}) > 0
      OR strpos(COALESCE(metadata::text, ''), ${id}) > 0 OR strpos(COALESCE(metadata::text, ''), ${url}) > 0 LIMIT 1`);
  return result.rows.length > 0;
}
