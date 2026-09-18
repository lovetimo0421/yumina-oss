import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { detectMaterialChange, migrateWorldDefinition } from "@yumina/engine";
import { MAX_AUTO_VERSIONS_PER_WORLD } from "@yumina/shared";
import type { db } from "../db/index.js";
import { user, worlds, worldPendingEdits, worldReviewSubmissions, worldVersions } from "../db/schema.js";
import { estimateWorldCopyTokens } from "./world-copy-material.js";

export type VersionExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;
export type VersionWorld = typeof worlds.$inferSelect;
export type VersionMaterial = { schema: Record<string, unknown>; thumbnailUrl: string | null; ageRating: string | null };
type Pending = typeof worldPendingEdits.$inferSelect;
type AutomaticSource = "publish" | "live" | "backup";

export async function lockVersionWorld(tx: VersionExecutor, worldId: string, creatorId: string) {
  const [world] = await tx.select().from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, creatorId))).for("update").limit(1);
  return world ?? null;
}

export async function lockVersionDraft(tx: VersionExecutor, worldId: string) {
  const [draft] = await tx.select().from(worldPendingEdits)
    .where(eq(worldPendingEdits.worldId, worldId)).for("update").limit(1);
  return draft ?? null;
}

// Titles are listing metadata and can change independently of a content release.
export function sameVersionMaterial(a: VersionMaterial, b: VersionMaterial) {
  const { name: _a, ...schemaA } = a.schema;
  const { name: _b, ...schemaB } = b.schema;
  return isDeepStrictEqual(schemaA, schemaB)
    && a.thumbnailUrl === b.thumbnailUrl && (a.ageRating ?? "all") === (b.ageRating ?? "all");
}

export function versionMatchesLiveSql() {
  return sql<boolean>`(${worlds.status} = 'published' AND ${worlds.isPublished} = true
    AND ${worldVersions.source} = 'live'
    AND (${worldVersions.schema} - 'name') = (${worlds.schema} - 'name')
    AND ${worldVersions.thumbnailUrl} IS NOT DISTINCT FROM ${worlds.thumbnailUrl}
    AND COALESCE(${worldVersions.ageRating}, 'all') = COALESCE(${worlds.ageRating}, 'all'))`;
}

/** Caller holds the world lock. Automatic retention never consumes named save slots. */
export async function captureAutomaticVersion(
  tx: VersionExecutor,
  world: Pick<VersionWorld, "id" | "creatorId" | "name"> & { reviewedAt?: Date | null },
  source: AutomaticSource,
  material: VersionMaterial,
  protectIds: string[] = [],
) {
  // Reuse saved content across Update, submission and approval. Only an actual
  // publication can promote it to live; matching named saves remain independent.
  if (source !== "backup") {
    const [existing] = await tx.select({ id: worldVersions.id, source: worldVersions.source, publishedAt: worldVersions.publishedAt }).from(worldVersions).where(and(
      eq(worldVersions.worldId, world.id), inArray(worldVersions.source, ["publish", "live"]),
      sql`(${worldVersions.schema} - 'name') = (${JSON.stringify(material.schema)}::jsonb - 'name')`,
      sql`${worldVersions.thumbnailUrl} IS NOT DISTINCT FROM ${material.thumbnailUrl}`,
      sql`COALESCE(${worldVersions.ageRating}, 'all') = ${material.ageRating ?? "all"}`,
    )).orderBy(desc(worldVersions.createdAt), desc(worldVersions.id)).limit(1);
    if (existing) {
      if (source === "live" && (existing.source !== "live"
        || !existing.publishedAt
        || (world.reviewedAt && existing.publishedAt < world.reviewedAt))) {
        await tx.update(worldVersions).set({ source: "live", publishedAt: new Date() })
          .where(eq(worldVersions.id, existing.id));
      }
      return existing.id;
    }
  }
  const now = new Date();
  const labels = { publish: "Saved version", live: "Saved version", backup: "Backup before restore" };
  const [inserted] = await tx.insert(worldVersions).values({
    worldId: world.id, createdBy: world.creatorId,
    name: `${labels[source]} · ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    source, publishedAt: source === "live" ? now : null, schema: { ...material.schema, name: world.name },
    thumbnailUrl: material.thumbnailUrl, ageRating: material.ageRating ?? "all", createdAt: now,
  }).returning();
  if (!inserted) throw new Error("Version could not be saved");

  // Keep the current live revision and any explicit restore target even when
  // old. Protected rows are included in the automatic history cap.
  const [currentLive] = await tx.select({ id: worldVersions.id }).from(worldVersions)
    .innerJoin(worlds, eq(worlds.id, worldVersions.worldId))
    .where(and(eq(worldVersions.worldId, world.id), versionMatchesLiveSql()))
    .orderBy(desc(worldVersions.createdAt), desc(worldVersions.id)).limit(1);
  const protectedIds = new Set([...protectIds, inserted.id, ...(currentLive ? [currentLive.id] : [])]);
  const rows = await tx.select({ id: worldVersions.id }).from(worldVersions)
    .where(and(eq(worldVersions.worldId, world.id), ne(worldVersions.source, "manual")))
    .orderBy(desc(worldVersions.createdAt), desc(worldVersions.id));
  const protectedCount = rows.filter((r) => protectedIds.has(r.id)).length;
  const overflow = rows.filter((r) => !protectedIds.has(r.id))
    .slice(Math.max(0, MAX_AUTO_VERSIONS_PER_WORLD - protectedCount));
  if (overflow.length) await tx.delete(worldVersions).where(inArray(worldVersions.id, overflow.map((r) => r.id)));
  return inserted.id;
}

export async function capturePublishVersion(tx: VersionExecutor, world: VersionWorld, draft: Pending | null) {
  return captureAutomaticVersion(tx, world, "publish", draft ?? world);
}

/** Full draft retention, including variable-only changes that don't need material review. */
export function versionDraftValues(world: VersionWorld, material: VersionMaterial, previous: Pending | null) {
  const next = { ...material, schema: { ...material.schema, name: world.name }, ageRating: material.ageRating ?? "all" };
  const diff = detectMaterialChange(
    { schema: migrateWorldDefinition(world.schema as never), thumbnailUrl: world.thumbnailUrl, ageRating: world.ageRating ?? "all" },
    { schema: migrateWorldDefinition(next.schema as never), thumbnailUrl: next.thumbnailUrl, ageRating: next.ageRating },
  );
  return {
    worldId: world.id, createdBy: world.creatorId, groupKey: world.languageGroupId ?? world.id,
    ...next, isNsfw: next.ageRating !== "all", preserveDraft: true, reasons: diff.reasons,
    status: "draft", submittedAt: null, reviewedAt: null, reviewedBy: null,
    rejectionReason: null, rejectionDetail: null,
    baseUpdatedAt: world.updatedAt, updatedAt: new Date(),
    updateTitle: previous?.updateTitle ?? null, updateContent: previous?.updateContent ?? null,
    updateIsMajor: previous?.updateIsMajor ?? false,
  } satisfies typeof worldPendingEdits.$inferInsert;
}

export class VersionActionError extends Error {
  constructor(public code: string, message: string, public status: 400 | 403 | 404 | 409 = 409) { super(message); }
}

async function ownedVersion(tx: VersionExecutor, worldId: string, versionId: string) {
  const [version] = await tx.select().from(worldVersions)
    .where(and(eq(worldVersions.worldId, worldId), eq(worldVersions.id, versionId))).limit(1);
  if (!version) throw new VersionActionError("VERSION_NOT_FOUND", "Version not found", 404);
  return version;
}

export async function restoreVersionDraft(tx: VersionExecutor, args: {
  worldId: string; creatorId: string; versionId: string; skipSafetySnapshot?: boolean;
}) {
  const world = await lockVersionWorld(tx, args.worldId, args.creatorId);
  if (!world) throw new VersionActionError("NOT_FOUND", "World not found", 404);
  const target = await ownedVersion(tx, world.id, args.versionId);
  const draft = await lockVersionDraft(tx, world.id);
  const working = world.status === "published" ? draft ?? world : world;
  if (!args.skipSafetySnapshot) {
    await captureAutomaticVersion(tx, world, "backup", working, [target.id]);
  }
  const material = {
    schema: { ...target.schema, name: world.name },
    thumbnailUrl: target.ageRating === null ? working.thumbnailUrl : target.thumbnailUrl,
    ageRating: target.ageRating ?? working.ageRating ?? "all",
  };
  if (world.status === "published") {
    // Restoring a draft is never a public write, even for a formerly-live version.
    if (draft?.status === "pending") {
      await tx.update(worldReviewSubmissions).set({ decision: "withdrawn", decidedBy: args.creatorId, decidedAt: new Date() })
        .where(and(eq(worldReviewSubmissions.worldId, world.id), eq(worldReviewSubmissions.decision, "pending"), eq(worldReviewSubmissions.submissionType, "edit")));
    }
    const values = versionDraftValues(world, material, draft);
    await tx.insert(worldPendingEdits).values(values).onConflictDoUpdate({ target: worldPendingEdits.worldId, set: values });
    await tx.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, world.id));
  } else {
    await tx.update(worlds).set({ ...material, isNsfw: material.ageRating !== "all", totalTokens: estimateWorldCopyTokens(material.schema), updatedAt: new Date() })
      .where(eq(worlds.id, world.id));
  }
  return { restored: true };
}

/** Only server-recorded, actually-live material can be switched without another review. */
export async function makeVersionLive(tx: VersionExecutor, args: {
  worldId: string; creatorId: string; versionId: string;
}) {
  const world = await lockVersionWorld(tx, args.worldId, args.creatorId);
  if (!world) throw new VersionActionError("NOT_FOUND", "World not found", 404);
  const [creator] = await tx.select({ isBanned: user.isBanned }).from(user).where(eq(user.id, args.creatorId));
  if (!creator || creator.isBanned) throw new VersionActionError("BANNED", "Your account cannot publish worlds", 403);
  if (world.status !== "published" || !world.isPublished) {
    throw new VersionActionError("NOT_PUBLISHED", "Publish this world through review before switching its live version");
  }
  const draft = await lockVersionDraft(tx, world.id);
  if (draft?.status === "pending") throw new VersionActionError("VERSION_IN_REVIEW", "Withdraw the pending review before switching the live version");
  const target = await ownedVersion(tx, world.id, args.versionId);
  // Reapproval after a takedown starts a new eligibility epoch. Content removed
  // by moderation must never be republished just because it was live once.
  if (target.source !== "live" || target.ageRating === null
    || (world.reviewedAt && (target.publishedAt ?? target.createdAt).getTime() < world.reviewedAt.getTime())) {
    throw new VersionActionError("VERSION_NOT_APPROVED", "Restore this version to your draft and publish it through review", 400);
  }
  const material = { schema: { ...target.schema, name: world.name }, thumbnailUrl: target.thumbnailUrl, ageRating: target.ageRating };
  if (sameVersionMaterial(world, material)) return { changed: false, world };
  const now = new Date();
  const [updated] = await tx.update(worlds).set({
    ...material, isNsfw: material.ageRating !== "all", totalTokens: estimateWorldCopyTokens(material.schema), updatedAt: now,
  }).where(eq(worlds.id, world.id)).returning();
  if (!updated) throw new Error("World could not be updated");
  // Preserve the current working content even if there was no material hold.
  // preserveDraft keeps later autosaves from silently undoing the version switch.
  const values = versionDraftValues(updated, draft ?? world, draft);
  await tx.insert(worldPendingEdits).values(values).onConflictDoUpdate({ target: worldPendingEdits.worldId, set: values });
  return { changed: true, world: updated };
}
