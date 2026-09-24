import type { AssetFolder } from "@/stores/user-assets";

export function assetFolderTrail(folders: AssetFolder[], folderId: string | null): AssetFolder[] {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const trail: AssetFolder[] = [];
  const visited = new Set<string>();
  let id = folderId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    trail.unshift(folder);
    id = folder.parentFolderId;
  }
  return trail;
}

export function chatAssetQuery(folderId: string | null, search: string, page: number): string {
  return new URLSearchParams({ type: "image", folderId: folderId ?? "root", search: search.trim(), sort: "newest", limit: "24", offset: String((page - 1) * 24) }).toString();
}
