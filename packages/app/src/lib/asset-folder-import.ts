import { getUploadMetadata, type UploadAssetType } from "./asset-upload";

export interface FolderFile {
  file: File;
  path: string;
}

export interface FolderImportPlan {
  files: (FolderFile & { type: UploadAssetType })[];
  skipped: string[];
  directories: string[];
  totalBytes: number;
}

const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const textTypes = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const videoTypes = new Set(["video/mp4", "video/webm"]);
const audioTypes = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/aac", "audio/mp4"]);
const fontTypes = new Set(["font/woff", "font/woff2", "font/ttf", "font/otf"]);

export function planFolderImport(entries: FolderFile[]): FolderImportPlan {
  const plan: FolderImportPlan = { files: [], skipped: [], directories: [], totalBytes: 0 };
  const directories = new Set<string>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    const { type, contentType } = getUploadMetadata(entry.file);
    if (parts.some((part) => !part.trim() || part === "." || part === ".." || /[\\\0]/.test(part))
      || parts.at(-1) !== entry.file.name || seen.has(entry.path)
      || !((type === "image" && imageTypes.has(contentType)) || (type === "txt" && textTypes.has(contentType))
        || (type === "video" && videoTypes.has(contentType)) || (type === "audio" && audioTypes.has(contentType))
        || (type === "font" && fontTypes.has(contentType)))) {
      plan.skipped.push(entry.path);
      continue;
    }
    seen.add(entry.path);
    plan.files.push({ ...entry, type });
    plan.totalBytes += entry.file.size;
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join("/"));
  }
  plan.directories = [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return plan;
}

/** Capture entries before the drop event's protected data store is cleared. */
export async function readDroppedAssets(dataTransfer: DataTransfer): Promise<{ files: FolderFile[]; hasDirectories: boolean }> {
  const entries = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  const fallback = Array.from(dataTransfer.files ?? []);
  const files: FolderFile[] = [];
  const hasDirectories = entries.some(({ entry }) => entry?.isDirectory);
  async function visit(entry: FileSystemEntry, parent: string) {
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      files.push({ file, path });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // Chromium returns at most 100 children per readEntries call.
      for (;;) {
        const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        for (const child of children) await visit(child, path);
      }
    }
  }
  if (!entries.length) return { files: fallback.map((file) => ({ file, path: file.name })), hasDirectories: false };
  for (const { entry, file } of entries) {
    if (entry) await visit(entry, "");
    else if (file) files.push({ file, path: file.name });
  }
  return { files, hasDirectories };
}

export interface FolderImportState {
  folderIds: Map<string, string>;
  completed: Set<string>;
}

/** State belongs to one import, so retry never recreates successful folders/files. */
export async function importFolderFiles(
  plan: FolderImportPlan,
  state: FolderImportState,
  options: {
    parentFolderId?: string;
    signal: AbortSignal;
    createFolder: (name: string, parentId?: string) => Promise<{ id: string } | null>;
    uploadFile: (file: File, type: UploadAssetType, folderId?: string) => Promise<unknown>;
    onFile?: (entry: FolderImportPlan["files"][number]) => void;
    onProgress: (completed: number, attempted: number) => void;
  },
): Promise<string[]> {
  const failed: string[] = [];
  const failedFolders = new Set<string>();
  let attempted = state.completed.size;
  async function ensureFolder(path: string): Promise<string | undefined> {
    if (!path) return options.parentFolderId;
    const existing = state.folderIds.get(path);
    if (existing) return existing;
    if (failedFolders.has(path) || options.signal.aborted) throw new Error("Folder unavailable");
    const parts = path.split("/");
    const name = parts.pop()!;
    const parentId = await ensureFolder(parts.join("/"));
    if (options.signal.aborted) throw new Error("Import stopped");
    try {
      const folder = await options.createFolder(name, parentId);
      if (!folder) throw new Error("Folder creation failed");
      state.folderIds.set(path, folder.id);
      return folder.id;
    } catch (error) {
      failedFolders.add(path);
      throw error;
    }
  }
  for (const entry of plan.files) {
    if (options.signal.aborted) break;
    if (state.completed.has(entry.path)) continue;
    options.onFile?.(entry);
    try {
      const folderId = await ensureFolder(entry.path.split("/").slice(0, -1).join("/"));
      if (options.signal.aborted) break;
      const result = await options.uploadFile(entry.file, entry.type, folderId);
      if (!result) throw new Error("Upload failed");
      state.completed.add(entry.path);
    } catch {
      if (!options.signal.aborted) failed.push(entry.path);
    }
    options.onProgress(state.completed.size, ++attempted);
  }
  return failed;
}
