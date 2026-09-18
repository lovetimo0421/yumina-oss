import { and, asc, count, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { assetFolders, userAssets, worldFolderBindings, worlds } from "../../db/schema.js";
import { z } from "zod";
const querySchema = z.object({
    scope: z.enum(["bound", "all"]).optional(),
    folderId: z.string().optional(),
    query: z.string().max(200).optional(),
    offset: z.number().int().min(0).max(100000).default(0),
    limit: z.number().int().min(1).max(100).default(100),
});
/** Includes descendants without trusting client-supplied paths or following cycles. */
export function descendantFolderIds(folders: Array<{
    id: string;
    parentFolderId: string | null;
}>, roots: string[]) {
    const ids = new Set(roots.filter(id => folders.some(f => f.id === id)));
    for (let changed = true; changed;) {
        changed = false;
        for (const f of folders)
            if (f.parentFolderId && ids.has(f.parentFolderId) && !ids.has(f.id)) {
                ids.add(f.id);
                changed = true;
            }
    }
    return [...ids];
}
export async function loadAssetCatalog(userId: string, worldId: string, input: unknown = {}) {
    const options = querySchema.parse(input);
    const [owned] = await db.select({ id: worlds.id }).from(worlds)
        .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId)));
    if (!owned)
        throw new Error("World not found or not authorized");
    const [folders, bindings] = await Promise.all([
        db.select({ id: assetFolders.id, name: assetFolders.name, parentFolderId: assetFolders.parentFolderId })
            .from(assetFolders).where(eq(assetFolders.userId, userId)).orderBy(asc(assetFolders.name), asc(assetFolders.id)),
        db.select({ folderId: worldFolderBindings.folderId }).from(worldFolderBindings).where(eq(worldFolderBindings.worldId, worldId)),
    ]);
    const boundIds = descendantFolderIds(folders, bindings.map(b => b.folderId));
    if (options.folderId && !folders.some(f => f.id === options.folderId))
        throw new Error("Folder not found or not authorized");
    const scope = options.scope ?? (boundIds.length ? "bound" : "all");
    const selected = options.folderId ? descendantFolderIds(folders, [options.folderId]) : scope === "bound" ? boundIds : undefined;
    const filter = and(eq(userAssets.userId, userId), selected ? inArray(userAssets.folderId, selected) : undefined, options.query ? ilike(userAssets.filename, `%${options.query.replace(/[\\%_]/g, "\\$&")}%`) : undefined);
    const [rows, totals] = await Promise.all([
        db.select({ id: userAssets.id, filename: userAssets.filename, type: userAssets.type, folderId: userAssets.folderId })
            .from(userAssets).where(filter).orderBy(asc(userAssets.filename), asc(userAssets.id)).offset(options.offset).limit(options.limit),
        db.select({ total: count() }).from(userAssets).where(filter),
    ]);
    const folderPath = (id: string | null) => {
        const parts: string[] = [], seen = new Set<string>();
        while (id && !seen.has(id)) {
            seen.add(id);
            const f = folders.find(f => f.id === id);
            if (!f)
                break;
            parts.unshift(f.name);
            id = f.parentFolderId;
        }
        return parts.join("/") || "/";
    };
    const total = totals[0]?.total ?? 0;
    return {
        scope, total, offset: options.offset, hasMore: options.offset + rows.length < total,
        nextOffset: options.offset + rows.length < total ? options.offset + rows.length : null,
        folders: folders.map(f => ({ ...f, path: folderPath(f.id), bound: boundIds.includes(f.id) })),
        assets: rows.map(a => ({ ...a, ref: `@asset:${a.id}`, folder: folderPath(a.folderId) })),
    };
}
export function formatAssetCatalog(catalog: Awaited<ReturnType<typeof loadAssetCatalog>>) {
    return `\nASSET LIBRARY (scope=${catalog.scope}; loaded=${catalog.assets.length}/${catalog.total}; truncated=${catalog.hasMore}):\n`
        + catalog.folders.filter(f => f.bound).map(f => `  Bound folder ${JSON.stringify(f.path)} id=${f.id}`).join("\n")
        + "\n" + catalog.assets.map(a => `  ${a.ref} ${JSON.stringify(a.filename)} [${a.type}] folder=${JSON.stringify(a.folder)}`).join("\n")
        + '\nUse list_assets to search filenames, browse a folder, or page with offset. scope="all" searches the entire owned library. An absent item in this page is NOT proof it does not exist.\n';
}
